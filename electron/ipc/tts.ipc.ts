/**
 * TTS IPC：API Key 管理 + 参考音频管理 + 合成请求。
 *
 * 存储：
 * - API Key：data/secure/voiceApiKey.enc（DPAPI 加密，与 LLM Key 隔离）
 * - 参考音频文件：data/voices/voice_xxx.{wav|mp3}
 * - 参考音频索引：data/voices/index.json
 * - TTS 配置：data/voice-settings.json（非敏感）
 */
import { ipcMain, dialog } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { TTSConfig, TTSLanguage, VoiceReference } from '../../src/types'
import { paths, readJson, writeJson, mutateJson, deleteFile } from '../services/storage'
import { saveSecret, readSecret, hasSecret } from '../services/crypto'
import { genId, assertValidResourceId } from '../services/repository'
import { synthesizeWithMiMo, bufferToBase64 } from '../services/ttsClient'

/** 默认 TTS 配置 */
const DEFAULT_TTS_CONFIG: TTSConfig = {
  language: 'zh',
  model: '',
  followText: true,
}

/** 默认参考音频列表（空数组） */
const DEFAULT_VOICES: VoiceReference[] = []

/** 支持的参考音频扩展名 */
const SUPPORTED_AUDIO_EXTS = ['wav', 'mp3']

/** MiMo voiceclone 推荐的参考音频时长范围（秒） */
const RECOMMENDED_MIN_DURATION = 5
const RECOMMENDED_MAX_DURATION = 30

/**
 * 解析 WAV 文件时长（秒）。
 * 通过遍历 RIFF chunk 找到 data chunk，用采样率/声道/位深计算时长。
 * 不引入 music-metadata 等重量级依赖，仅支持标准 PCM WAV。
 * @returns 时长秒数；非 WAV 或解析失败返回 null
 */
function parseWavDuration(buf: Buffer): number | null {
  try {
    // RIFF header check：前 4 字节必须是 "RIFF"
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
    // 遍历 chunks 查找 "data" chunk（WAV 可能含 fmt 等多个 chunk）
    let offset = 12
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4)
      const chunkSize = buf.readUInt32LE(offset + 4)
      if (chunkId === 'data') {
        // 从 fmt chunk 读取的参数（标准 WAV 在 offset 22/24/34）
        const channels = buf.readUInt16LE(22)
        const sampleRate = buf.readUInt32LE(24)
        const bitsPerSample = buf.readUInt16LE(34)
        if (sampleRate > 0 && channels > 0 && bitsPerSample > 0) {
          // 时长 = 数据字节数 / (采样率 × 声道数 × 位深/8)
          return chunkSize / (sampleRate * channels * bitsPerSample / 8)
        }
        return null
      }
      // chunkSize 后可能需要 padding 到偶数
      offset += 8 + chunkSize + (chunkSize % 2)
    }
    return null
  } catch {
    return null
  }
}

/** 读取 TTS 配置（供 ai.ipc 读取跟读等状态） */
export async function getTTSConfig(): Promise<TTSConfig> {
  return readJson<TTSConfig>(paths.voiceSettingsFile, DEFAULT_TTS_CONFIG)
}

/** 读取 MiMo API Key（明文，仅主进程内存中使用） */
async function readVoiceApiKey(): Promise<string | null> {
  return readSecret(paths.voiceApiKeyFile)
}

/**
 * 校验参考音频 ID 合法性，防止路径穿越攻击
 * voice_ 后接 12 位十六进制
 */
function assertValidVoiceId(id: string): void {
  if (typeof id !== 'string' || !/^voice_[0-9a-f]{12}$/.test(id)) {
    throw new Error('非法的参考音频 ID')
  }
}

export function registerTtsIpc(): void {
  // ==================== API Key ====================

  /** 读取 TTS 配置 + API Key 状态（不回显明文 Key） */
  ipcMain.handle('tts:get-config', async () => {
    const config = await getTTSConfig()
    return { ...config, hasApiKey: await hasSecret(paths.voiceApiKeyFile) }
  })

  /** 保存 MiMo API Key（加密存储） */
  ipcMain.handle('tts:save-api-key', async (_e, key: string) => {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('API Key 不能为空')
    }
    await saveSecret(paths.voiceApiKeyFile, key.trim())
  })

  /** 检查 API Key 是否已配置 */
  ipcMain.handle('tts:has-api-key', () => hasSecret(paths.voiceApiKeyFile))

  // ==================== TTS 配置 ====================

  /** 保存 TTS 配置（语言、自动播放） */
  ipcMain.handle('tts:save-config', async (_e, patch: Partial<TTSConfig>) => {
    const current = await getTTSConfig()
    const next: TTSConfig = { ...current, ...patch }
    await writeJson(paths.voiceSettingsFile, next)
    return next
  })

  // ==================== 参考音频管理 ====================

  /**
   * 弹原生文件选择框并导入参考音频。
   * 用户选择 wav/mp3 文件后复制到 voices/ 目录，并写入索引。
   * 导入时解析 WAV 时长（MP3 不解析），用于克隆质量提示。
   * 返回 voice + 质量警告（时长不在 5-30s 推荐范围时）。
   */
  ipcMain.handle('tts:import-reference', async (): Promise<{ voice: VoiceReference; warning: string | null } | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择参考音频（建议 5-30 秒，干净人声）',
      filters: [
        { name: '音频', extensions: SUPPORTED_AUDIO_EXTS },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const src = result.filePaths[0]!
    const ext = path.extname(src).slice(1).toLowerCase()
    if (!SUPPORTED_AUDIO_EXTS.includes(ext)) {
      throw new Error(`不支持的音频格式：${ext}，仅支持 ${SUPPORTED_AUDIO_EXTS.join('/')}`)
    }

    // 读取文件内容用于时长解析（WAV）
    const audioBuf = await fs.readFile(src)
    const durationSec = ext === 'wav' ? (parseWavDuration(audioBuf) ?? 0) : 0

    const id = genId('voice')
    const fileName = `${id}.${ext}`
    const dest = path.join(paths.voicesDir, fileName)

    // 复制到 voices 目录（确保目录存在）
    await fs.mkdir(paths.voicesDir, { recursive: true })
    await fs.copyFile(src, dest)

    // 从文件名提取显示名（去掉扩展名）
    const displayName = path.basename(src, path.extname(src))

    const voice: VoiceReference = {
      id,
      name: displayName,
      filePath: fileName,
      durationSec,
      createdAt: Date.now(),
    }

    // 克隆质量提示：时长不在推荐范围
    let warning: string | null = null
    if (ext === 'wav' && durationSec > 0) {
      if (durationSec < RECOMMENDED_MIN_DURATION) {
        warning = `参考音频仅 ${durationSec.toFixed(1)} 秒，MiMo 建议至少 5 秒。时长过短可能导致声音特征提取不足，克隆效果较差。`
      } else if (durationSec > RECOMMENDED_MAX_DURATION) {
        warning = `参考音频 ${durationSec.toFixed(1)} 秒，MiMo 建议不超过 30 秒。时长过长可能被截断，且增加合成延迟。`
      }
    } else if (ext === 'mp3') {
      warning = 'MP3 格式无法自动检测时长，请自行确认在 5-30 秒范围内。'
    }

    await mutateJson(paths.voicesIndexFile, DEFAULT_VOICES, (list) => [voice, ...list])
    return { voice, warning }
  })

  /** 列出所有参考音频 */
  ipcMain.handle('tts:list-references', () =>
    readJson<VoiceReference[]>(paths.voicesIndexFile, DEFAULT_VOICES),
  )

  /** 删除指定参考音频（同时删除文件与索引条目） */
  ipcMain.handle('tts:remove-reference', async (_e, id: string) => {
    assertValidVoiceId(id)
    const list = await readJson<VoiceReference[]>(paths.voicesIndexFile, DEFAULT_VOICES)
    const voice = list.find((v) => v.id === id)
    if (!voice) return

    // 删除音频文件
    await deleteFile(path.join(paths.voicesDir, voice.filePath)).catch(() => {})
    // 从索引移除
    await mutateJson(paths.voicesIndexFile, DEFAULT_VOICES, (arr) => arr.filter((v) => v.id !== id))
  })

  /** 重命名参考音频（仅改索引，不动文件），返回更新后的对象 */
  ipcMain.handle('tts:rename-reference', async (_e, id: string, name: string) => {
    assertValidVoiceId(id)
    const trimmed = (name ?? '').trim()
    if (!trimmed) throw new Error('名称不能为空')

    // 先查找目标，确认存在
    const list = await readJson<VoiceReference[]>(paths.voicesIndexFile, DEFAULT_VOICES)
    const target = list.find((v) => v.id === id)
    if (!target) throw new Error('参考音频不存在')

    const updated: VoiceReference = { ...target, name: trimmed }

    await mutateJson(paths.voicesIndexFile, DEFAULT_VOICES, (arr) =>
      arr.map((v) => (v.id === id ? updated : v)),
    )
    return updated
  })

  // ==================== 合成 ====================

  /**
   * 合成语音：传入文本 + 参考音频 id，调用 MiMo API 返回 wav ArrayBuffer
   * @param params.text 要合成的文本
   * @param params.voiceId 参考音频 id（对应 voices/index.json 中的条目）
   * @param params.languageOverride 角色级语言覆盖（null/undefined = 跟随全局）
   * @returns wav 格式的 ArrayBuffer，调用失败抛出错误
   */
  ipcMain.handle('tts:synthesize', async (_e, params: { text: string; voiceId: string; languageOverride?: TTSLanguage | null }) => {
    const { text, voiceId, languageOverride } = params ?? {}
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('合成文本不能为空')
    }
    assertValidVoiceId(voiceId)

    const apiKey = await readVoiceApiKey()
    if (!apiKey) {
      throw new Error('未配置 MiMo API Key，请先在「设置 → 语音合成」中填写')
    }

    const config = await getTTSConfig()
    if (!config.model.trim()) {
      throw new Error('未配置 TTS 模型，请先在「设置 → 语音合成」中填写')
    }

    // 角色级语言覆盖：languageOverride 非空时覆盖全局 language
    const effectiveConfig: TTSConfig = languageOverride
      ? { ...config, language: languageOverride }
      : config

    const list = await readJson<VoiceReference[]>(paths.voicesIndexFile, DEFAULT_VOICES)
    const voice = list.find((v) => v.id === voiceId)
    if (!voice) {
      throw new Error('参考音频不存在，请检查设置')
    }

    // 读取参考音频文件并转 base64
    const audioBuf = await fs.readFile(path.join(paths.voicesDir, voice.filePath))
    const referenceAudioBase64 = bufferToBase64(audioBuf)
    // 从文件名提取扩展名，用于确定 MIME 类型（data:audio/wav;base64,...）
    const referenceAudioExt = path.extname(voice.filePath).slice(1).toLowerCase()

    // 调用 MiMo API 合成
    return synthesizeWithMiMo({
      apiKey,
      text: text.trim(),
      referenceAudioBase64,
      referenceAudioExt,
      config: effectiveConfig,
    })
  })
}

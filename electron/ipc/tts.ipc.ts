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
import type { TTSConfig, TTSLanguage, VoiceReference, StandardEmotion, TTSGenieConfig, TTSModelCard, TTSModelCardInput } from '../../src/types'
import { paths, readJson, writeJson, mutateJson, deleteFile } from '../services/storage'
import { saveSecret, readSecret, hasSecret } from '../services/crypto'
import { genId, assertValidResourceId, listTTSModels, getTTSModel, createTTSModel, updateTTSModel, deleteTTSModel } from '../services/repository'
import { synthesizeWithMiMo, bufferToBase64 } from '../services/ttsClient'
import {
  getGenieConfig,
  saveGenieConfig,
  checkGenie,
  startGenieServer,
  downloadGenieData,
  synthesizeGenie,
} from '../services/genieTts'

/** 默认 TTS 配置（默认走本地声库语音服务 GenieTTS） */
const DEFAULT_TTS_CONFIG: TTSConfig = {
  language: 'zh',
  model: '',
  engine: 'genie',
  mergeSpeech: false,
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

/** 读取 TTS 配置（供 ai.ipc 读取跟读等状态）。合并默认值，兼容缺少 engine/mirror 的旧配置 */
export async function getTTSConfig(): Promise<TTSConfig> {
  const current = await readJson<TTSConfig>(paths.voiceSettingsFile, DEFAULT_TTS_CONFIG)
  return { ...DEFAULT_TTS_CONFIG, ...current }
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

  // ==================== 本地声库语音服务(GenieTTS) ====================

  /** 读取 GenieTTS 配置 */
  ipcMain.handle('tts:genie-config', () => getGenieConfig())

  /** 保存 GenieTTS 配置（部分合并） */
  ipcMain.handle('tts:genie-save-config', async (_e, patch: Partial<TTSGenieConfig>) => {
    return saveGenieConfig(patch ?? {})
  })

  /** 检测 GenieTTS 服务是否在线 */
  ipcMain.handle('tts:genie-check', async (_e, baseUrl: string) => {
    return checkGenie(baseUrl)
  })

  /** 用 GenieTTS 环境 + GenieData 目录自动拉起服务 */
  ipcMain.handle('tts:genie-start', async (_e, workPath: string, dataDir?: string) => {
    const cfg = await getGenieConfig()
    return startGenieServer(workPath ?? cfg.workPath, cfg.baseUrl, dataDir ?? cfg.dataDir)
  })

  /** 用系统 python 下载 GenieData 资源 */
  ipcMain.handle('tts:genie-download-data', async (_e, dataDir: string) => {
    return downloadGenieData(dataDir)
  })

  /** 弹目录选择框 */
  ipcMain.handle('tts:choose-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择目录',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /** 弹文件选择框（wav/mp3） */
  ipcMain.handle('tts:choose-audio-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择参考音频',
      filters: [{ name: '音频', extensions: ['wav', 'mp3'] }],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
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
   * 合成语音：按 engine 路由到本地声库服务(GenieTTS) 或 MiMo 声音克隆。
   * @param params.text 要合成的文本
   * @param params.voiceId 参考音频 id（仅 mimo 引擎需要；genie 可空）
   * @param params.languageOverride 角色级语言覆盖（null/undefined = 跟随全局）
   * @param params.emotion 保留字段（Genie 由声库自带性格，忽略逐句情绪）
   * @param params.engine 显式引擎覆盖（角色卡决定；缺省用全局配置）
   * @param params.genieOverride 角色级 Genie 覆盖（绑定的 TTS 模型卡 id）
   * @returns wav 格式的 ArrayBuffer，调用失败抛出错误
   */
  ipcMain.handle('tts:synthesize', async (_e, params: { text: string; voiceId: string | null; languageOverride?: TTSLanguage | null; emotion?: StandardEmotion | null; engine?: 'genie' | 'mimo'; genieOverride?: import('../../src/types').CharacterGenieOverride | null }) => {
    const { text, voiceId, languageOverride, engine: engineOverride, genieOverride } = params ?? {}
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('合成文本不能为空')
    }

    // 角色级语言覆盖：languageOverride 非空时覆盖全局 language
    const config = await getTTSConfig()
    const effectiveConfig: TTSConfig = languageOverride
      ? { ...config, language: languageOverride }
      : config
    const engine = engineOverride ?? config.engine ?? 'genie'

    // 本地声库引擎：无需参考音频，直接合成（声库自带性格）
    if (engine === 'genie') {
      const base = await getGenieConfig()
      // 从 TTS 模型卡获取角色参数
      let characterName = ''
      let onnxModelDir = ''
      let refAudioPath = ''
      let refAudioText = ''
      if (genieOverride?.ttsModelId) {
        const modelCard = await getTTSModel(genieOverride.ttsModelId)
        if (modelCard) {
          characterName = modelCard.characterName
          onnxModelDir = modelCard.onnxModelDir
          refAudioPath = modelCard.refAudioPath
          refAudioText = modelCard.refAudioText
        }
      }
      if (!characterName || !onnxModelDir) {
        throw new Error('未绑定 TTS 模型卡或模型卡配置不完整，请先在「设置 → 语音合成」中创建并绑定')
      }
      return synthesizeGenie({
        config: base,
        characterName,
        onnxModelDir,
        refAudioPath: refAudioPath || undefined,
        refAudioText: refAudioText || undefined,
        text: text.trim(),
        lang: effectiveConfig.language,
      })
    }

    // MiMo 引擎：需要参考音频 + API Key
    assertValidVoiceId(voiceId ?? '')
    const apiKey = await readVoiceApiKey()
    if (!apiKey) {
      throw new Error('未配置 MiMo API Key，请先在「设置 → 语音合成」中填写')
    }
    if (!config.model.trim()) {
      throw new Error('未配置 TTS 模型，请先在「设置 → 语音合成」中填写')
    }

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

// ---- TTS 模型卡 CRUD ----

ipcMain.handle('tts-model:list', async () => {
  return listTTSModels()
})

ipcMain.handle('tts-model:create', async (_e, input: TTSModelCardInput) => {
  return createTTSModel(input)
})

ipcMain.handle('tts-model:update', async (_e, id: string, input: TTSModelCardInput) => {
  return updateTTSModel(id, input)
})

ipcMain.handle('tts-model:delete', async (_e, id: string) => {
  return deleteTTSModel(id)
})

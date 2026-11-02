/**
 * 触摸互动 IPC：语音 + AI 感知。
 *
 * 设计取舍：
 * - 语音走 storyVoiceCache（落盘缓存，key 只认文本），首次合成 1~2 秒，之后命中即秒回；
 *   不额外做"预生成"界面，避免多一套状态。
 * - AI 感知默认"旁白入史"（不调用 LLM）；开启「立即回应」才跑一轮完整对话。
 * - AI 正在回复 / 剧情演出中一律只入史或不处理，避免打断。
 */
import { ipcMain } from 'electron'
import type { ChatMessage } from '../../src/types'
import { appendSessionMessages, getSettings, listSessions, listCharacterCards } from '../services/repository'
import { isChatBusy, runChatTurn } from '../services/chatTurn'
import { isStoryActive } from '../services/storyEngine/engine'
import { synthesizeStoryVoice } from '../services/storyVoiceCache'
import { windowManager } from '../windows/windowManager'
import { markTouchPerforming } from '../services/touchPerformance'
import { readJson } from '../services/storage'
import { paths } from '../services/storage'
import type { TTSConfig } from '../../src/types'

/** 触摸旁白的默认模板；%s 为部位名 */
const DEFAULT_TEMPLATE = '（{name}被摸了摸{part}）'

/** 同一次触摸事件的最短间隔（防止连点刷屏） */
const NOTIFY_MIN_GAP_MS = 1500
let lastNotifyAt = 0

/** 读全局语音配置（引擎/语言/默认声库） */
async function readTtsConfig(): Promise<TTSConfig> {
  return readJson<TTSConfig>(paths.voiceSettingsFile, {
    language: 'zh',
    model: '',
    engine: 'genie',
    ttsSpeed: 1,
  } as TTSConfig)
}

/** 解析当前可用的声库：优先角色卡绑定，其次全局默认 */
async function resolveVoice(): Promise<{ ttsModelId: string; language: 'zh' | 'ja'; engine?: 'genie' | 'sbv2' } | null> {
  const cfg = await readTtsConfig()
  try {
    const cards = await listCharacterCards()
    const withVoice = cards.find((c) => c.localVoice?.ttsModelId)
    if (withVoice?.localVoice?.ttsModelId) {
      const engine = withVoice.voiceMode === 'sbv2' ? 'sbv2' : withVoice.voiceMode === 'genie' ? 'genie' : undefined
      return { ttsModelId: withVoice.localVoice.ttsModelId, language: cfg.language ?? 'zh', engine }
    }
  } catch {
    // 忽略：回落全局
  }
  if (!cfg.model) return null
  return { ttsModelId: cfg.model, language: cfg.language ?? 'zh', engine: cfg.engine === 'sbv2' ? 'sbv2' : 'genie' }
}

export function registerTouchIpc(): void {
  /** 桌宠窗上报「接下来 durationMs 内处于触摸演出」：主动搭话据此让路 */
  ipcMain.on('touch:performing', (_e, durationMs: number) => {
    markTouchPerforming(Number(durationMs) || 0)
  })

  /** 桌宠窗回传截图 */
  ipcMain.on('pet:touch-snapshot-data', (_e, payload) => {
    windowManager.resolvePetSnapshot(payload ?? null)
  })

  /**
   * 设置窗请求一张当前姿势的角色截图（用于拖框编辑）。
   * 流程：桌宠窗只回几何（画布/角色包围盒，窗口坐标）→ 主进程截整窗 →
   * 按截图缩放把包围盒换算成图片像素。这样不存在"裁剪原点"导致的整体偏移。
   */
  ipcMain.handle('touch:snapshot', async () => {
    const metrics = await windowManager.requestPetSnapshot()
    if (!metrics) return null
    const shot = await windowManager.capturePetWindow()
    if (!shot) return null
    const content = windowManager.getPetContentSize()
    const sx = content && content[0] > 0 ? shot.width / content[0] : 1
    const sy = content && content[1] > 0 ? shot.height / content[1] : 1
    return {
      ...shot,
      // 透传桌宠窗的渲染目标，供设置窗校验"截图与正在编辑的对象是否一致"
      mode: metrics.mode,
      spriteId: metrics.spriteId,
      spriteFile: metrics.spriteFile,
      bounds: {
        x: metrics.bounds.x * sx,
        y: metrics.bounds.y * sy,
        w: metrics.bounds.w * sx,
        h: metrics.bounds.h * sy,
      },
    }
  })

  /**
   * 取触摸台词音频。allowSynthesize=false 时只查缓存（运行时不阻塞）。
   * 返回 base64（wav）；失败返回 null，调用方静默跳过。
   */
  ipcMain.handle('touch:voice', async (_e, params: { text: string; allowSynthesize?: boolean }) => {
    const text = typeof params?.text === 'string' ? params.text.trim() : ''
    if (!text) return null
    try {
      const voice = await resolveVoice()
      if (!voice) return null
      const res = await synthesizeStoryVoice({ ...voice, text }, params?.allowSynthesize !== false)
      if (!res.ok) return null
      return Buffer.from(res.wav).toString('base64')
    } catch (err) {
      console.warn('[touch] 语音合成失败：', err instanceof Error ? err.message : err)
      return null
    }
  })

  /**
   * 触摸事件上报：写入旁白（默认），或直接让 AI 回应（settings.touch.aiReply）。
   */
  ipcMain.handle('touch:notify', async (_e, payload: { label?: string; line?: string | null }) => {
    const settings = await getSettings()
    if (!settings.touch?.enabled) return
    const now = Date.now()
    if (now - lastNotifyAt < NOTIFY_MIN_GAP_MS) return
    lastNotifyAt = now
    // 剧情演出中不插旁白；AI 忙只影响"立即回应"，写历史不受影响
    if (isStoryActive()) return

    const part = String(payload?.label ?? '').trim() || '头'
    const sessions = await listSessions().catch(() => [])
    const target = sessions[0]
    if (!target) return
    const name = target.characterCardName || '角色'
    const narration = DEFAULT_TEMPLATE.replace('{name}', name).replace('{part}', part)

    if (settings.touch.aiReply) {
      if (isChatBusy()) return
      try {
        await runChatTurn({ sessionId: target.id, content: narration, meta: { proactive: true } })
      } catch (err) {
        console.warn('[touch] AI 回应失败：', err instanceof Error ? err.message : err)
      }
      return
    }

    // 未开「立即回应」时只写历史（要不要写由 saveNarration 控制）
    if (!settings.touch.saveNarration) return
    const msg: ChatMessage = {
      role: 'user',
      content: narration,
      timestamp: Date.now(),
      meta: { proactive: true },
    }
    const detail = await appendSessionMessages(target.id, [msg]).catch((err) => {
      console.warn('[touch] 旁白入史失败：', err instanceof Error ? err.message : err)
      return null
    })
    // 落盘后必须广播：聊天窗和桌宠的会话视图都只监听主进程事件，
    // 不广播的话要切一次会话（重新 session:get）才能看到这条旁白。
    if (detail) {
      windowManager.broadcastAI('ai:session-appended', { sessionId: target.id, message: msg })
    }
  })
}

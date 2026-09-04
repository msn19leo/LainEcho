/**
 * AI 请求 IPC。
 * - 主进程组装 system prompt（人设 + 记忆体）、发起流式请求、持久化消息
 * - API Key 只在主进程内存中解密使用，不经过 IPC 传给渲染进程
 * - 流式 token 通过 webContents 事件推送到发起请求的窗口
 */
import { ipcMain } from 'electron'
import type { ChatMessage, StandardEmotion } from '../../src/types'
import { sendChatCompletion } from '../services/aiClient'
import { parseDialogueJson, extractStreamingJsonText, extractDialogueChunkDelta } from '../services/emotion'
import { getTTSConfig } from './tts.ipc'
import { readApiKey } from '../services/crypto'
import {
  appendSessionMessages,
  buildSystemPrompt,
  getCharacterCard,
  getSession,
  getSettings,
  listMemories,
} from '../services/repository'
import { windowManager } from '../windows/windowManager'

let currentAbort: AbortController | null = null

/**
 * 上下文收窄（降低首 token / 逐 token 延迟）：
 * - MAX_CONTEXT_MESSAGES：只发送最近 N 条历史消息，更早的截断，避免请求体随对话无限膨胀。
 * - MAX_MEMORIES：只注入最近 N 条记忆体，防止 system prompt 过长拖慢生成。
 */
const MAX_CONTEXT_MESSAGES = 16
const MAX_MEMORIES = 8
/** 主进程合并 chunk 的 flush 间隔（毫秒）：多个 delta 合并为一次 IPC 推送，减少消息数 */
const CHUNK_FLUSH_MS = 16
/** 单个"情绪块"最多合并的 dialogue 项数：超过即提前结算，保持在"边生成边读"的实时性，避免单块越长越延迟出声 */
const BLOCK_MAX_ITEMS = 3

export function registerAiIpc(): void {
  ipcMain.handle('ai:send-message', async (event, params: { sessionId: string; messages: ChatMessage[] }) => {
    const { sessionId, messages } = params ?? {}
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('消息内容为空')
    const sender = event.sender
    const last = messages[messages.length - 1]
    const userMsg: ChatMessage = { role: 'user', content: last?.content ?? '', timestamp: Date.now() }
    let partial = ''
    let cancelled = false

    // 广播本轮的 user 消息，让跟随窗口（非发起方）也能立刻补上用户气泡，
    // 无需等 stream-done 全量拉取才出现（否则跟随窗口会缺用户消息、且中途消息闪变）
    windowManager.broadcastAI('ai:stream-user', { sessionId, content: userMsg.content, timestamp: userMsg.timestamp })
    // 记录"进行中的流"所属会话：窗口重载/新建后就绪时补发用于认领，避免漏该轮事件
    windowManager.setActiveStreamingSession(sessionId)

    // 进入"思考中"：通知桌宠切换到思考立绘
    windowManager.notifyThinking(true)

    // 合并推送：把模型原始输出实时提取成纯净台词文本，累积后按 CHUNK_FLUSH_MS 窗口一次性 send，
    // 避免把 JSON（花括号/键名）暴露给聊天窗，也减少 IPC 往返。lastDisplayLen 用于只发新增片段。
    let lastDisplayLen = 0
    let chunkTimer: NodeJS.Timeout | null = null
    const flushChunks = () => {
      chunkTimer = null
      const display = extractStreamingJsonText(partial)
      const delta = display.length > lastDisplayLen ? display.slice(lastDisplayLen) : ''
      lastDisplayLen = Math.max(lastDisplayLen, display.length)
      if (delta) {
        windowManager.broadcastAI('ai:stream-chunk', delta)
      }
    }

    const abort = new AbortController()
    currentAbort = abort
    try {
      const settings = await getSettings()
      const apiKey = await readApiKey()
      if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI API 配置」中填写')
      if (!settings.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
      if (!settings.model.trim()) throw new Error('未配置模型名（model）')

      // 组装 system prompt：人设字段 + 示例对话 + 最近 MAX_MEMORIES 条全局记忆体
      // （每次请求前实时读取，保证记忆更新即时生效）
      const session = await getSession(sessionId)
      const card = await getCharacterCard(session.characterCardId)
      const memories = (await listMemories()).slice(0, MAX_MEMORIES)
      const systemMessage: ChatMessage = {
        role: 'system',
        content: buildSystemPrompt(card, memories),
      }
      // 截断历史：仅保留最近 MAX_CONTEXT_MESSAGES 条（含当前用户消息），降低 TTFT
      const recentMessages = messages.slice(-MAX_CONTEXT_MESSAGES)
      const fullMessages: ChatMessage[] = [systemMessage, ...recentMessages]

      // ---- 语音生成策略（由"是否跟读文本"决定） ----
      // - 跟读开启（followText=true）：情绪块"边生成边读"，桌宠按音频段随语音逐段显示。
      // - 跟读关闭（followText=false）：不边生成边读；整段文本流式输出完毕后，统一触发一次语音。
      const ttsCfg = await getTTSConfig()
      const followText = ttsCfg.followText
      // 流式一开始即广播本轮语音模式与技术策略，让宠物窗提前用正确的展示方式（跟读=段级输出，否则流式打字机）
      windowManager.notifyVoiceMode({ voiceEnabled: !!card?.voiceId, followText })
      let speechCursor = 0
      let pendingBlock: { texts: string[]; emotion: StandardEmotion } | null = null
      /** 是否已通过流式触发过至少一次语音（用于非流式/分块失败的兜底判定） */
      let speechEmitted = false
      // 结算当前情绪块并触发桌宠语音（仅当该会话角色卡配置了 voiceId，沿用现有"语音启用"判定）
      const flushPendingBlock = () => {
        const b = pendingBlock
        pendingBlock = null
        if (!b || b.texts.length === 0 || !card?.voiceId) return
        speechEmitted = true
        const text = b.texts.join('\n')
        const langOverride = card.ttsOverride?.language ?? null
        windowManager.speak(text, card.voiceId, langOverride, { chunks: [{ text, emotion: b.emotion }], follow: followText })
      }
      // 流式 onChunk 中实时结算：新 dialogue 项并入当前块，情绪变化或块足够大即结算旧块，保持"边生成边读"
      const pumpSpeech = () => {
        const { items, cursor } = extractDialogueChunkDelta(partial, speechCursor)
        speechCursor = cursor
        for (const it of items) {
          if (!pendingBlock) { pendingBlock = { texts: [it.text], emotion: it.emotion }; continue }
          if (it.emotion !== pendingBlock.emotion || pendingBlock.texts.length >= BLOCK_MAX_ITEMS) {
            flushPendingBlock()
            pendingBlock = { texts: [it.text], emotion: it.emotion }
          } else {
            pendingBlock.texts.push(it.text)
          }
        }
      }

      const content = await sendChatCompletion(fullMessages, {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        stream: settings.stream,
        signal: abort.signal,
        onChunk: (chunk) => {
          partial += chunk
          if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
          // 仅跟读开启时才边生成边读；关闭跟读时不做逐段语音（留到整段生成完统一播）
          if (followText) pumpSpeech()
        },
      })

      // 流式结束：清空定时器并 flush 残余文本，保证最后一段也送达
      if (chunkTimer) {
        clearTimeout(chunkTimer)
        chunkTimer = null
      }
      flushChunks()
      // 结算最后一个未闭合的情绪块（仅跟读时"边生成边读"才有未闭块；关闭跟读时无块）
      if (followText) flushPendingBlock()
      // 未触发"边生成边读"时（跟读关闭 / 非流式 / 分块一直未触发）：
      // 兜底在整段文本生成完毕后，一次性按 dialogue 块触发语音（满足"等语音生成完再输出语音"）。
      if (!speechEmitted && card?.voiceId) {
        const parsedChunks = parseDialogueJson(content).chunks
        const langOverride = card.ttsOverride?.language ?? null
        for (const c of parsedChunks) {
          windowManager.speak(c.text, card.voiceId, langOverride, { chunks: [c], follow: followText })
        }
      }

      // 持久化：user 消息 + assistant 完整回复（解析 JSON dialogue，落盘句子/情绪段供句级同步与联动）
      const now = Date.now()
      const { text, emotion, sentences, emotionSegments, chunks } = parseDialogueJson(content)
      // 临时调试：确认模型是否输出结构化 dialogue JSON（确认后删除）
      console.log('[ai:parse-json] isDialogueJson=', /"dialogue"\s*:/.test(content), 'chunks=', chunks.length, 'segments=', JSON.stringify(emotionSegments))
      const asstMsg: ChatMessage = { role: 'assistant', content: text, emotion, sentences, emotionSegments, chunks, timestamp: now }
      await appendSessionMessages(sessionId, [userMsg, asstMsg])

      windowManager.broadcastAI('ai:stream-done', { sessionId, message: asstMsg })
      // 立绘/表情驱动策略：
      // - 有语音（voiceId）：立绘由语音块驱动（宠物窗 playLoop 逐块 setEmotion），此处不广播情绪，
      //   避免"文本输出时切一次、语音输出时又切一次"的重叠切换。
      // - 无语音：立绘由文本输出驱动，此处广播归一化情绪。
      if (!card?.voiceId) windowManager.notifyEmotion(emotion)
      return asstMsg
    } catch (err) {
      cancelled = abort.signal.aborted
      const message = err instanceof Error ? err.message : String(err)

      // 出错/取消时也持久化 user 消息与已流出的部分回复，避免 UI 与磁盘状态分叉
      try {
        const extra: ChatMessage[] = [userMsg]
        if (partial) extra.push({ role: 'assistant', content: extractStreamingJsonText(partial), timestamp: Date.now() })
        await appendSessionMessages(sessionId, extra)
      } catch {
        // 持久化失败不影响错误上报
      }

      // 出错/取消前 flush 残余文本，让已流出的部分也上屏
      if (chunkTimer) {
        clearTimeout(chunkTimer)
        chunkTimer = null
      }
      flushChunks()

      windowManager.broadcastAI('ai:stream-error', { sessionId, error: message, cancelled })
      throw err
    } finally {
      if (currentAbort === abort) currentAbort = null
      // 流式结束/出错/取消：清除"进行中的流"标记，避免窗口在之后才就绪时误认领已结束的会话
      windowManager.setActiveStreamingSession(null)
      // 退出"思考中"：无论成功/出错/取消都复位（情绪事件已在成功路径驱动形象）
      windowManager.notifyThinking(false)
    }
  })

  ipcMain.on('ai:cancel', () => {
    currentAbort?.abort()
  })

  ipcMain.handle('ai:test-connection', async () => {
    try {
      const settings = await getSettings()
      const apiKey = await readApiKey()
      if (!apiKey) return { ok: false, error: '未配置 API Key' }
      if (!settings.baseURL.trim()) return { ok: false, error: '未配置 API 地址（baseURL）' }
      const content = await sendChatCompletion([{ role: 'user', content: 'ping' }], {
        model: settings.model.trim() || 'gpt-4o-mini',
        baseURL: settings.baseURL,
        apiKey,
        stream: false,
        maxTokensOverride: 5,
        signal: new AbortController().signal,
      })
      return { ok: true, data: content }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

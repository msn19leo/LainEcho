/**
 * AI 请求 IPC。
 * - 主进程组装 system prompt（人设 + 记忆体）、发起流式请求、持久化消息
 * - API Key 只在主进程内存中解密使用，不经过 IPC 传给渲染进程
 * - 流式 token 通过 webContents 事件推送到发起请求的窗口
 */
import { ipcMain } from 'electron'
import type { AppSettings, ChatMessage, StandardEmotion } from '../../src/types'
import { sendChatCompletion } from '../services/aiClient'
import { parseDialogueJson, extractStreamingJsonText, extractDialogueChunkDelta } from '../services/emotion'
import { buildModelContext, forceCompact, SUMMARY_MAX_TOKENS, toModelMessage } from '../services/context'
import { estimateMessagesTokens } from '../services/token'
import { getTTSConfig } from './tts.ipc'
import { readApiKey } from '../services/crypto'
import { extractMemoriesFromSession } from '../services/memoryExtraction'
import {
  appendSessionMessages,
  buildSystemPrompt,
  getCharacterCard,
  getSession,
  getSettings,
  listConfirmedMemories,
  updateSessionSummary,
} from '../services/repository'
import { windowManager } from '../windows/windowManager'

let currentAbort: AbortController | null = null

/**
 * 上下文收窄（降低首 token / 逐 token 延迟）：
 * - 上下文管理改由 services/context.ts 统一负责（A1 Token 预算装填 + A2 自动摘要压缩），
 *   此处不再按固定条数截断。
 * - MAX_MEMORIES：只注入最近 N 条记忆体，防止 system prompt 过长拖慢生成。
 */
const MAX_MEMORIES = 8
/** 摘要压缩专用 system prompt：独立上下文，绝不混入主对话的 EMOTION_PROMPT JSON 约束 */
const SUMMARY_SYSTEM_PROMPT =
  '你是一个专业的对话总结助手。将用户与角色之间的对话历史压缩成简洁准确的总结，' +
  '保留关键信息、人物关系进展、重要约定与当前话题，忽略无关细节。' +
  '直接输出总结文本本身，不要输出 JSON、不要加任何解释或格式标记。'

/**
 * 构造摘要回调：把旧历史文本交给模型（独立 prompt、非流式）压成摘要文本。
 * 与主对话隔离：绝不混入 EMOTION_PROMPT 的 JSON 输出约束。失败时 throw。
 */
function createSummarizer(settings: AppSettings, apiKey: string, signal?: AbortSignal) {
  return async (olderText: string): Promise<string> => {
    const summary = await sendChatCompletion(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `以下是对话历史：\n${olderText}\n\n请输出总结：` },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.3,
        stream: false,
        maxTokensOverride: SUMMARY_MAX_TOKENS,
        signal,
      },
    )
    const trimmed = (summary ?? '').trim()
    if (!trimmed) throw new Error('摘要为空')
    return trimmed
  }
}

/** 格式化本地时间为 YYYY-MM-DD HH:MM:SS（用户消息本地时间注入用） */
function formatLocalTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
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
      const memories = await listConfirmedMemories(session.characterCardId, MAX_MEMORIES)
      const systemMessage: ChatMessage = {
        role: 'system',
        content: buildSystemPrompt(card, memories, settings.userName),
      }

      // A1+A2 上下文组装：净化消息 → 按 Token 预算装填（A1）；总 token 超阈值时，
      // 旧历史交给独立请求生成摘要并落盘复用（A2）。摘要走独立 prompt，不污染主对话的 JSON 输出约束。
      const summarize = createSummarizer(settings, apiKey, abort.signal)
      const modelMessages = messages.map(toModelMessage)
      // 本地时间注入：仅给发送给模型的当前用户消息加前缀（不污染落盘历史），让角色感知发送时刻
      if (modelMessages.length > 0) {
        const lastMsg = modelMessages[modelMessages.length - 1]!
        if (lastMsg.role === 'user') {
          lastMsg.content = `[本地时间 ${formatLocalTime(new Date())}]\n${lastMsg.content}`
        }
      }
      const ctx = await buildModelContext({
        systemMessage,
        messages: modelMessages,
        contextWindowTokens: settings.contextWindowTokens,
        enableAutoCompact: settings.enableAutoCompact,
        summarize,
      })
      const fullMessages = ctx.messages
      // 摘要落盘复用（失败静默，不影响本轮请求）
      if (ctx.newSummary) {
        await updateSessionSummary(sessionId, ctx.newSummary).catch(() => {})
      }
      // 上下文 token 用量日志（后续可上 UI 展示）
      console.log(
        '[context] system=%d history=%d total=%d (msgs %d->%d, compact=%s)',
        estimateMessagesTokens([systemMessage]),
        estimateMessagesTokens(modelMessages),
        estimateMessagesTokens(fullMessages),
        modelMessages.length,
        fullMessages.length - 1,
        ctx.newSummary ? 'yes' : 'no',
      )
      // 广播上下文 token 用量给桌宠窗显示（会话收放按钮旁）
      windowManager.broadcastAI('ai:context-stats', {
        sessionId,
        system: estimateMessagesTokens([systemMessage]),
        history: estimateMessagesTokens(modelMessages),
        total: estimateMessagesTokens(fullMessages),
        window: settings.contextWindowTokens,
      })

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
      const asstMsg: ChatMessage = { role: 'assistant', content: text, emotion, sentences, emotionSegments, chunks, timestamp: now }
      await appendSessionMessages(sessionId, [userMsg, asstMsg])

      // 记忆自动沉淀（后台，不阻塞）：从本轮对话抽取待确认候选，供用户在设置窗确认/删除
      // 受「自动沉淀记忆」开关控制（关闭时不再发起抽取请求）
      if (settings.enableMemoryExtraction) {
        void extractMemoriesFromSession({
          sessionId,
          cardId: session.characterCardId,
          messages: [...messages, asstMsg],
          settings: { model: settings.model, baseURL: settings.baseURL, apiKey },
        })
      }

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

  /**
   * 只读查询会话上下文 token 用量（不触发摘要、不发消息）。
   * 供桌宠窗切换到已有内容的会话时展示用量并激活手动压缩按钮；
   * 采用 A1 预算装填口径估算「实际会发送的上下文」，enableAutoCompact=false 保证无副作用。
   */
  ipcMain.handle('ai:get-context-stats', async (_event, params: { sessionId: string }) => {
    try {
      const { sessionId } = params ?? {}
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
      const settings = await getSettings()
      const session = await getSession(sessionId)
      const card = await getCharacterCard(session.characterCardId)
      const memories = await listConfirmedMemories(session.characterCardId, MAX_MEMORIES)
      const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(card, memories) }
      const modelMessages = session.messages.map(toModelMessage)
      // 只读预览：关闭自动摘要，仅按 Token 预算装填估算实际发送的上下文（summarize 不会被调用）
      const ctx = await buildModelContext({
        systemMessage,
        messages: modelMessages,
        contextWindowTokens: settings.contextWindowTokens,
        enableAutoCompact: false,
        summarize: async () => {
          throw new Error('预览模式不应触发摘要')
        },
      })
      const stats = {
        sessionId,
        system: estimateMessagesTokens([systemMessage]),
        history: estimateMessagesTokens(modelMessages),
        total: estimateMessagesTokens(ctx.messages),
        window: settings.contextWindowTokens,
      }
      return { ok: true, stats }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  /**
   * 手动压缩当前会话历史：把「最近 20 条之外」的旧历史交给模型生成摘要并落盘复用，
   * 返回最新上下文用量。失败返回 { ok:false, error } 由桌宠窗提示，不抛异常。
   */
  ipcMain.handle('ai:compact-now', async (_event, params: { sessionId: string }) => {
    try {
      const { sessionId } = params ?? {}
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
      const settings = await getSettings()
      const apiKey = await readApiKey()
      if (!apiKey) throw new Error('未配置 API Key')
      if (!settings.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
      if (!settings.model.trim()) throw new Error('未配置模型名（model）')

      const session = await getSession(sessionId)
      const card = await getCharacterCard(session.characterCardId)
      const memories = await listConfirmedMemories(session.characterCardId, MAX_MEMORIES)
      const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(card, memories) }
      const modelMessages = session.messages.map(toModelMessage)

      const result = await forceCompact({
        systemMessage,
        messages: modelMessages,
        summarize: createSummarizer(settings, apiKey),
      })
      if (result.newSummary) {
        await updateSessionSummary(sessionId, result.newSummary)
      }

      const stats = {
        sessionId,
        system: estimateMessagesTokens([systemMessage]),
        history: estimateMessagesTokens(modelMessages),
        total: estimateMessagesTokens(result.messages),
        window: settings.contextWindowTokens,
      }
      // 广播最新用量给桌宠窗（与自动组装后的广播一致，手动压缩后立即刷新显示）
      windowManager.broadcastAI('ai:context-stats', stats)
      console.log('[context] 手动压缩完成 compact=%s', result.newSummary ? 'yes' : 'no')
      return { ok: true, compacted: !!result.newSummary, stats }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[context] 手动压缩失败：', message)
      return { ok: false, error: message }
    }
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

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
    // 首个可读文本块到达后即退出思考立绘（见 flushChunks）的一次性标记
    let needExitThinking = true
    // 语音是否启用（由 onChunk 在 voiceActive 求值后同步，供 flushChunks 闭包安全读取）
    let voiceActiveRef = false

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
        // 未启用语音：思考立绘显示到首个文本开始输出（首个可读文本块即退出）
        if (!voiceActiveRef && needExitThinking) {
          needExitThinking = false
          windowManager.notifyThinking(false)
        }
      }
    }

    const abort = new AbortController()
    currentAbort = abort
    try {
      const settings = await getSettings()
      const ttsCfg = await getTTSConfig()
      // 整段合音：开启时主进程关闭"边生成边读"，流式结束后整段一次合成（音调连贯）；关闭时保持逐句实时朗读
      const mergeSpeech = ttsCfg.mergeSpeech === true
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

      // ---- 语音生成策略（始终跟读文本） ----
      // 启用语音后，桌宠始终"边生成边读"，按音频段随语音逐段显示。
      // 角色卡声音模式：none 不发音；genie 用本地声库(无需参考音频)；mimo 用云端克隆(需 voiceId)
      const effMode = card?.voiceMode ?? (card?.voiceId ? 'mimo' : 'none')
      const voiceEngine: 'genie' | 'mimo' | null =
        effMode === 'genie' ? 'genie' : effMode === 'mimo' ? 'mimo' : null
      const voiceActive =
        effMode === 'genie' ? true : effMode === 'mimo' ? !!card?.voiceId : false
      const genieOverride = effMode === 'genie' ? (card?.genieOverride ?? null) : null
      // 流式一开始即广播本轮语音模式，让宠物窗提前用跟读展示方式
      windowManager.notifyVoiceMode({ voiceEnabled: voiceActive })
      let speechCursor = 0
      let pendingBlock: { texts: string[]; emotion: StandardEmotion } | null = null
      /** 是否已通过流式触发过至少一次语音（用于非流式/分块失败的兜底判定） */
      let speechEmitted = false
      // 结算当前情绪块并触发桌宠语音（语音启用时才发声）
      const flushPendingBlock = () => {
        const b = pendingBlock
        pendingBlock = null
        if (!b || b.texts.length === 0 || !card || !voiceActive) return
        speechEmitted = true
        const text = b.texts.join('\n')
        const langOverride = card.ttsOverride?.language ?? null
        const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
        // 不在此处退出思考立绘：speak 仅代表"发起合成"，此刻语音尚未真正发声。
        // 思考立绘的退出改由渲染端在 lipSync 真正开始播放音频时触发（见 PetStage），
        // 让思考态覆盖到"首个语音/文本真正发声"这一瞬，而非合成发起时。
        windowManager.speak(text, voiceId, langOverride, { chunks: [{ text, emotion: b.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride })
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

      // 【诊断】本轮流式开关实际值：区分非流式(stream=false)还是chunk被合并
      console.log('[diag] settings.stream=', settings.stream)
      const content = await sendChatCompletion(fullMessages, {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        stream: settings.stream,
        signal: abort.signal,
        onChunk: (chunk) => {
          // 同步语音启用标志，供 flushChunks 在首个文本块时正确判断退出思考的时机
          voiceActiveRef = voiceActive
          partial += chunk
          if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
          // 文本流式输出照常（flushChunks）；语音侧：仅未开启整段合音时"边生成边读"，
          // 开启整段合音则等流式结束后整段兜底一次合成，避免逐块独立推理导致语气不连贯
          if (!mergeSpeech) pumpSpeech()
        },
      })

      // 流式结束：清空定时器并 flush 残余文本，保证最后一段也送达
      if (chunkTimer) {
        clearTimeout(chunkTimer)
        chunkTimer = null
      }
      flushChunks()
      // 结算最后一个未闭合的情绪块
      flushPendingBlock()
      // 未触发"边生成边读"时（非流式 / 整段合音开启 / 分块一直未触发）：
      // 兜底在整段文本生成完毕后触发语音。整段合音开启时整段一次 speak；
      // 关闭时保持原逐块兜底（与修改前一致）。
      if (!speechEmitted && voiceActive && card) {
        const parsed = parseDialogueJson(content)
        const langOverride = card.ttsOverride?.language ?? null
        const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
        if (mergeSpeech) {
          // 整段合音：整段文本一次合成（前端按整段朗读，情绪用整体情绪）
          windowManager.speak(parsed.text, voiceId, langOverride, {
            chunks: [{ text: parsed.text, emotion: parsed.emotion }],
            follow: true,
            engine: voiceEngine ?? undefined,
            genieOverride,
          })
        } else {
          for (const c of parsed.chunks) {
            windowManager.speak(c.text, voiceId, langOverride, { chunks: [c], follow: true, engine: voiceEngine ?? undefined, genieOverride })
          }
        }
      }

      // 持久化：user 消息 + assistant 完整回复（解析 JSON dialogue，落盘句子/情绪段供句级同步与联动）
      const now = Date.now()
      // 仅无语音/未发音兜底：内容已解析落定，若仍未退出思考（且本轮无语音发声），在此退出。
      // 关键：有语音时（voiceActive=true），思考立绘必须由渲染端在 lipSync 真正播放音频时
      // 切换为说话立绘；此处绝不能提前 notifyThinking(false)，否则会在语音真正发声前切走思考立绘。
      console.log('[thinking] parseDone needExitThinking=%s voiceActive=%s speechEmitted=%s', needExitThinking, voiceActive, speechEmitted)
      if (needExitThinking && !voiceActive) {
        needExitThinking = false
        console.log('[thinking] no-voice fallback: exit thinking')
        windowManager.notifyThinking(false)
      }
      const { text, emotion, sentences, emotionSegments, chunks } = parseDialogueJson(content)
      // 【诊断】模型原始输出 vs 解析文本：定位空内容是模型层(0)还是解析层(>0但text=0)
      console.log('[diag] content.len=%d parse.text.len=%d chunks=%d | head=%j', (content??0).length, (text??'').length, chunks?.length??0, String(content??'').slice(0,160))
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
      // 关键：判断须用 voiceActive（genie 本地声库时 card.voiceId 为空但确有语音），
      // 否则 genie 模式会误广播 notifyEmotion → 渲染端 unsubEmotion 把思考立绘切回 idle（提前退出思考）。
      if (!voiceActive) windowManager.notifyEmotion(emotion)
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
      // 退出思考立绘：仅无语音场景在此复位。
      // 关键：有语音时语音合成是异步执行、可能晚于此 finally 才真正播放，
      // 若在此无条件 notifyThinking(false)，会在语音真正发声前切走思考立绘。
      // 有语音场景的思考立绘退出由渲染端在 lipSync 真正播放时负责（见 PetStage）。
      console.log('[thinking] finally voiceActiveRef=%s needExitThinking=%s', voiceActiveRef, needExitThinking)
      if (!voiceActiveRef && needExitThinking) {
        needExitThinking = false
        windowManager.notifyThinking(false)
      }
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
      const ttsCfg = await getTTSConfig()
      // 整段合音：开启时主进程关闭"边生成边读"，流式结束后整段一次合成（音调连贯）；关闭时保持逐句实时朗读
      const mergeSpeech = ttsCfg.mergeSpeech === true
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
      const ttsCfg = await getTTSConfig()
      // 整段合音：开启时主进程关闭"边生成边读"，流式结束后整段一次合成（音调连贯）；关闭时保持逐句实时朗读
      const mergeSpeech = ttsCfg.mergeSpeech === true
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

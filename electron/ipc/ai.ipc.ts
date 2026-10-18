/**
 * AI 请求 IPC（薄层）：请求体校验 + 委派 chatTurn 执行。
 * 轮次核心（prompt 组装/流式/语音/持久化/记忆沉淀）在 services/chatTurn.ts，
 * 由用户消息与主动搭话调度器共用。
 * API Key 只在主进程内存中解密使用，不经过 IPC 传给渲染进程。
 */
import { ipcMain } from 'electron'
import type { ChatMessage } from '../../src/types'
import { sendChatCompletion } from '../services/aiClient'
import { runChatTurn, isTurnBusy, cancelCurrentTurn, createSummarizer } from '../services/chatTurn'
import * as turnCoordinator from '../services/turnCoordinator'
import { buildModelContext, forceCompact, toModelMessage } from '../services/context'
import { estimateMessagesTokens } from '../services/token'
import { getTTSConfig } from './tts.ipc'
import { readApiKey } from '../services/crypto'
import {
  buildSystemPrompt,
  deleteLastTurnMessages,
  getCharacterCard,
  getSession,
  getSettings,
  listConfirmedMemories,
  removeFailedDuplicateUser,
  updateSessionSummary,
} from '../services/repository'
import { buildSystemParts } from '../services/prompt/sections'
import { composeSystemPrompt } from '../services/prompt/composer'
import { retrieveMemories } from '../services/memory/retriever'
import { buildSceneSection } from '../services/sceneContext'
import { resolveAuxLlmConfig } from '../services/auxModel'
import { resolveVisionConfig } from '../services/proactive/screenAnalyzer'
import { noteUserMessage } from '../services/proactive/scheduler'
import { windowManager } from '../windows/windowManager'

/** 降级模式的记忆注入条数（与 chatTurn 内一致，仅预览/压缩路径用） */
const MAX_MEMORIES = 8

export function registerAiIpc(): void {
  ipcMain.handle('ai:send-message', async (_event, params: { sessionId: string; messages: ChatMessage[] }) => {
    const { sessionId, messages } = params ?? {}
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('消息内容为空')
    const last = messages[messages.length - 1]
    const content = last?.content ?? ''
    // 并发防护：上一轮（LLM/持久化阶段）未结束前拒绝新消息（重答期间渲染端 streamUser 会
    // 置 streaming，但 rewound→stream-user 的窗口期 streaming 尚未置位，此处兜底）
    if (isTurnBusy()) throw new Error('上一轮回复还在生成中，请稍候')
    // 重发去重：磁盘末条是带 error 的失败 user 且内容与本次相同 → 移除（本次发送替代失败尝试），
    // 否则历史出现相邻重复 user（进入上下文还可能诱发模型输出劣化，2026-10-17 实锤）
    await removeFailedDuplicateUser(sessionId, content).catch(() => {})

    // 通知主动搭话调度器：用户主动发消息 → 兴趣值清零、当日计数重置、更新冷却时间戳
    noteUserMessage(sessionId)

    // 轮次核心执行（流式/语音/持久化/记忆沉淀均在 chatTurn 内完成；错误已广播后 rethrow）
    return runChatTurn({ sessionId, content })
  })

  /**
   * 消息重答（ reroll："截断最后一轮 → 重走正常链路"）：
   * 删除最后一轮（user+assistant）后用原 user 内容（或编辑后文本）重跑 runChatTurn——
   * 流式/语音/持久化/记忆沉淀全部复用，无独立重答管线。
   * 编辑并重发 = editText 非空；重新回答 = editText 为空。
   * 广播 ai:session-rewound 让两窗用磁盘最新消息列表替换本地（旧轮气泡消失），
   * 随后的 ai:stream-user 正常走既有同步链。
   */
  ipcMain.handle('ai:regenerate', async (_event, params: { sessionId: string; editText?: string }) => {
    const { sessionId, editText } = params ?? {}
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
    if (isTurnBusy()) throw new Error('上一轮回复还在生成中，无法重新回答')
    const removedUser = await deleteLastTurnMessages(sessionId)
    if (!removedUser) throw new Error('没有可重新回答的轮次')
    const content = (editText ?? removedUser.content ?? '').trim()
    if (!content) throw new Error('编辑后的消息内容为空')

    // 广播截断结果（先于重跑：两窗立刻丢弃旧轮消息），再按用户活跃刷新调度器
    const session = await getSession(sessionId)
    windowManager.broadcastAI('ai:session-rewound', { sessionId, messages: session.messages })
    noteUserMessage(sessionId)

    return runChatTurn({ sessionId, content })
  })

  ipcMain.on('ai:cancel', () => {
    cancelCurrentTurn()
  })

  // ===== 方案A快照协议（见 docs/方案A-主进程回合文档与幂等快照协议.md）=====
  /** 拉取当前回合文档快照（请求-响应原子读；无文档返回 null。幂等，重复调用无副作用） */
  ipcMain.handle('ai:get-turn-snapshot', () => turnCoordinator.getSnapshot())
  /** 宠物窗上报语音进度（字符口径）：speaking/spoken 累计字符数，单调取 max（主门控） */
  ipcMain.on('ai:turn-progress', (_e, payload: { turnId: string; speakingChars: number; spokenChars: number }) => {
    const { turnId, speakingChars, spokenChars } = payload ?? {}
    if (typeof turnId === 'string') turnCoordinator.markProgress(turnId, Number(speakingChars), Number(spokenChars))
  })
  /** 宠物窗上报：本轮语音/旁白槽位全部消费完 → phase=done（reading 收尾，幂等） */
  ipcMain.on('ai:turn-reading-done', (_e, payload: { turnId: string }) => {
    const { turnId } = payload ?? {}
    if (typeof turnId === 'string') turnCoordinator.markReadingDone(turnId)
  })
  /** 宠物窗工作心跳（合成/播放中周期上行）：喂 reading 看门狗，慢合成不误判链路死亡 */
  ipcMain.on('ai:turn-reading-ping', (_e, payload: { turnId: string }) => {
    const { turnId } = payload ?? {}
    if (typeof turnId === 'string') turnCoordinator.markReadingPing(turnId)
  })

  /**
   * 调试预览：返回指定会话「下次请求实际会发送」的 system prompt 组装报表。
   * 复用 send-message 的记忆检索路径（向量/降级模式一致），列出各段落 id/token/是否注入，
   * 供设置窗排查 token 占用；只读、不触发摘要、不发消息。
   */
  ipcMain.handle('prompt:preview', async (_event, params: { sessionId: string }) => {
    try {
      const { sessionId } = params ?? {}
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
      const settings = await getSettings()
      const session = await getSession(sessionId)
      const card = await getCharacterCard(session.characterCardId)
      const lastUserText = [...session.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const retrieval = await retrieveMemories(session.characterCardId, lastUserText, MAX_MEMORIES)
      const composed = composeSystemPrompt(
        buildSystemParts(card, retrieval.items, retrieval.profileDigest, settings.enableProactive, null, settings.stripParenNarration),
        { userName: settings.userName },
      )
      // 情境 Section（只读预览也如实展示，排查 token 占用时可见）
      const sceneSection = settings.enableSceneDigest ? buildSceneSection(session.sceneDigest) : null
      return { ok: true, mode: retrieval.mode, memoryCount: retrieval.items.length, text: `${sceneSection ? `${sceneSection}\n\n` : ''}${composed.text}`, sections: composed.sections }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
      const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(card, memories, settings.userName, null, false, null, undefined, null, settings.timeAwarenessEnabled, settings.enableSceneDigest ? buildSceneSection(session.sceneDigest) : null) }
      const modelMessages = session.messages.map(toModelMessage)
      // 只读预览：关闭自动摘要，仅按 Token 预算装填估算实际发送的上下文（summarize 不会被调用）
      const ctx = await buildModelContext({
        systemMessage,
        messages: modelMessages,
        contextWindowTokens: settings.contextWindowTokens,
        enableAutoCompact: false,
        timeAwareness: settings.timeAwarenessEnabled,
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
      const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(card, memories, settings.userName, null, false, null, undefined, null, settings.timeAwarenessEnabled, settings.enableSceneDigest ? buildSceneSection(session.sceneDigest) : null) }
      const modelMessages = session.messages.map(toModelMessage)

      const result = await forceCompact({
        systemMessage,
        messages: modelMessages,
        timeAwareness: settings.timeAwarenessEnabled,
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

  /**
   * 测试连接（profile 指定测试对象，按"回落后生效配置"发极简请求）：
   *  - main：主模型（现状语义）
   *  - aux：辅助模型；未配置时回落主模型（与运行时语义一致），文案由面板注明
   *  - vision：视觉模型；独立必填不回落（主模型可能无图像输入能力），未配置直接报错
   */
  ipcMain.handle('ai:test-connection', async (_e, profile: 'main' | 'aux' | 'vision' = 'main') => {
    try {
      const settings = await getSettings()
      let model: string
      let baseURL: string
      let apiKey: string | null
      if (profile === 'vision') {
        const cfg = await resolveVisionConfig()
        if (!cfg) return { ok: false, error: '未配置视觉模型（地址/模型/Key 需全部填写，视觉模型不回落主模型）' }
        model = cfg.model
        baseURL = cfg.baseURL
        apiKey = cfg.apiKey
      } else if (profile === 'aux') {
        const aux = await resolveAuxLlmConfig()
        model = (aux?.model ?? settings.model).trim()
        baseURL = (aux?.baseURL ?? settings.baseURL).trim()
        apiKey = aux?.apiKey || (await readApiKey())
        if (!apiKey) return { ok: false, error: '未配置 API Key' }
        if (!baseURL) return { ok: false, error: '未配置 API 地址（baseURL）' }
        if (!model) return { ok: false, error: '未配置模型名（model）' }
      } else {
        apiKey = await readApiKey()
        if (!apiKey) return { ok: false, error: '未配置 API Key' }
        if (!settings.baseURL.trim()) return { ok: false, error: '未配置 API 地址（baseURL）' }
        model = settings.model.trim() || 'gpt-4o-mini'
        baseURL = settings.baseURL
      }
      const content = await sendChatCompletion([{ role: 'user', content: 'ping' }], {
        model,
        baseURL,
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

/**
 * AI 请求 IPC（薄层）：请求体校验 + 委派 chatTurn 执行。
 * 轮次核心（prompt 组装/流式/语音/持久化/记忆沉淀）在 services/chatTurn.ts，
 * 由用户消息与主动搭话调度器共用。
 * API Key 只在主进程内存中解密使用，不经过 IPC 传给渲染进程。
 */
import { ipcMain } from 'electron'
import type { ChatMessage } from '../../src/types'
import { sendChatCompletion } from '../services/aiClient'
import { runChatTurn, cancelCurrentTurn, createSummarizer } from '../services/chatTurn'
import { buildModelContext, forceCompact, toModelMessage } from '../services/context'
import { estimateMessagesTokens } from '../services/token'
import { getTTSConfig } from './tts.ipc'
import { readApiKey } from '../services/crypto'
import {
  buildSystemPrompt,
  getCharacterCard,
  getSession,
  getSettings,
  listConfirmedMemories,
  updateSessionSummary,
} from '../services/repository'
import { buildSystemParts } from '../services/prompt/sections'
import { composeSystemPrompt } from '../services/prompt/composer'
import { retrieveMemories } from '../services/memory/retriever'
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

    // 通知主动搭话调度器：用户主动发消息 → 兴趣值清零、当日计数重置、更新冷却时间戳
    noteUserMessage(sessionId)

    // 轮次核心执行（流式/语音/持久化/记忆沉淀均在 chatTurn 内完成；错误已广播后 rethrow）
    return runChatTurn({ sessionId, content })
  })

  ipcMain.on('ai:cancel', () => {
    cancelCurrentTurn()
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
        buildSystemParts(card, retrieval.items, retrieval.profileDigest, settings.enableProactive),
        { userName: settings.userName },
      )
      return { ok: true, mode: retrieval.mode, memoryCount: retrieval.items.length, text: composed.text, sections: composed.sections }
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

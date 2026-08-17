/**
 * AI 请求 IPC。
 * - 主进程组装 system prompt（人设 + 记忆体）、发起流式请求、持久化消息
 * - API Key 只在主进程内存中解密使用，不经过 IPC 传给渲染进程
 * - 流式 token 通过 webContents 事件推送到发起请求的窗口
 */
import { ipcMain } from 'electron'
import type { ChatMessage } from '../../src/types'
import { sendChatCompletion } from '../services/aiClient'
import { readApiKey } from '../services/crypto'
import {
  appendSessionMessages,
  buildSystemPrompt,
  getCharacterCard,
  getSession,
  getSettings,
  listMemories,
} from '../services/repository'

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

export function registerAiIpc(): void {
  ipcMain.handle('ai:send-message', async (event, params: { sessionId: string; messages: ChatMessage[] }) => {
    const { sessionId, messages } = params ?? {}
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('消息内容为空')
    const sender = event.sender
    const last = messages[messages.length - 1]
    const userMsg: ChatMessage = { role: 'user', content: last?.content ?? '', timestamp: Date.now() }
    let partial = ''
    let cancelled = false

    // 合并推送：累积待发送文本，按 CHUNK_FLUSH_MS 窗口一次性 send，减少 IPC 往返
    let pendingChunk = ''
    let chunkTimer: NodeJS.Timeout | null = null
    const flushChunks = () => {
      chunkTimer = null
      if (pendingChunk && !sender.isDestroyed()) {
        sender.send('ai:stream-chunk', pendingChunk)
      }
      pendingChunk = ''
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
          pendingChunk += chunk
          if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
        },
      })

      // 流式结束：清空定时器并 flush 残余文本，保证最后一段也送达
      if (chunkTimer) {
        clearTimeout(chunkTimer)
        chunkTimer = null
      }
      flushChunks()

      // 持久化：user 消息 + assistant 完整回复
      const now = Date.now()
      const asstMsg: ChatMessage = { role: 'assistant', content, timestamp: now }
      await appendSessionMessages(sessionId, [userMsg, asstMsg])

      if (!sender.isDestroyed()) sender.send('ai:stream-done', { sessionId, message: asstMsg })
      return asstMsg
    } catch (err) {
      cancelled = abort.signal.aborted
      const message = err instanceof Error ? err.message : String(err)

      // 出错/取消时也持久化 user 消息与已流出的部分回复，避免 UI 与磁盘状态分叉
      try {
        const extra: ChatMessage[] = [userMsg]
        if (partial) extra.push({ role: 'assistant', content: partial, timestamp: Date.now() })
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

      if (!sender.isDestroyed()) sender.send('ai:stream-error', { sessionId, error: message, cancelled })
      throw err
    } finally {
      if (currentAbort === abort) currentAbort = null
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

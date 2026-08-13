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

export function registerAiIpc(): void {
  ipcMain.handle('ai:send-message', async (event, params: { sessionId: string; messages: ChatMessage[] }) => {
    const { sessionId, messages } = params ?? {}
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('消息内容为空')
    const sender = event.sender
    const last = messages[messages.length - 1]
    const userMsg: ChatMessage = { role: 'user', content: last?.content ?? '', timestamp: Date.now() }
    let partial = ''
    let cancelled = false

    const abort = new AbortController()
    currentAbort = abort
    try {
      const settings = await getSettings()
      const apiKey = await readApiKey()
      if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI API 配置」中填写')
      if (!settings.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
      if (!settings.model.trim()) throw new Error('未配置模型名（model）')

      // 组装 system prompt：人设字段 + 示例对话 + 全局记忆体（每次请求前实时读取，保证记忆更新即时生效）
      const session = await getSession(sessionId)
      const card = await getCharacterCard(session.characterCardId)
      const memories = await listMemories()
      const systemMessage: ChatMessage = {
        role: 'system',
        content: buildSystemPrompt(card, memories),
      }
      const fullMessages: ChatMessage[] = [systemMessage, ...messages]

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
          if (!sender.isDestroyed()) sender.send('ai:stream-chunk', chunk)
        },
      })

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

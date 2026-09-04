/**
 * 聊天窗"语音朗读到当前段"文本 store。
 * 宠物窗朗读时逐段上报经主进程转发，聊天窗据此随语音段段显示（非流式一次性整段文本）。
 * 供 MessageList 的 StreamingBubble 读取：有朗读文本用朗读文本，否则退回流式打字机。
 */
import { create } from 'zustand'

interface ChatReadingState {
  /** 宠物窗当前已朗读到的段落累积文本（含当前位置段全文），与宠物窗内容框完全一致 */
  text: string
  /** 本轮是否语音跟读（有语音且开启跟读）：是则气泡显示段落文本，否则退回流式打字机 */
  followReading: boolean
  /** 语音朗读是否进行中（控制跳动光标显隐） */
  readingActive: boolean
  setText: (t: string) => void
  setFollowReading: (v: boolean) => void
  setReadingActive: (v: boolean) => void
  clear: () => void
}

export const useChatReadingStore = create<ChatReadingState>((set) => ({
  text: '',
  followReading: false,
  readingActive: false,
  setText: (t) => set({ text: t }),
  setFollowReading: (v) => set({ followReading: v }),
  setReadingActive: (v) => set({ readingActive: v }),
  clear: () => set({ text: '' }),
}))
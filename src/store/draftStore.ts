/**
 * 输入框草稿（文字 + 已添加但未发送的图片），按会话隔离。
 *
 * 为什么不能放组件 state：
 * - 聊天窗折叠（左上角图标）走 FloatingDock 的 AnimatePresence，面板被卸载，
 *   局部 state 随之销毁，但渲染进程还活着 → 提升到 store 即可保住；
 * - 聊天窗关闭（右上角 ×）走 win.close()，窗口被销毁，重开时整进程重建
 *   （windowManager.showChat 检测 isDestroyed 后重新 createChatWindow）
 *   → 光有 store 不够，还要落 localStorage。
 *
 * 未创建会话时用 `__new__` 作为键；会话创建后由调用方 migrate 迁移。
 * 图片只存路径（ChatImage），文件本身早已落盘，恢复时不存在由 ChatImageThumb 降级。
 */
import { create } from 'zustand'
import type { ChatImage } from '../types'

const STORAGE_KEY = 'lainecho.chat-draft.v1'
/** 尚未创建会话时的草稿键 */
export const NEW_SESSION_DRAFT_KEY = '__new__'
/** 落盘节流：连续输入不必每敲一个字都写一次 localStorage */
const PERSIST_DELAY_MS = 300

export interface Draft {
  text: string
  images: ChatImage[]
}

const EMPTY_DRAFT: Draft = { text: '', images: [] }

/** 从 localStorage 读取（字段逐项校验，损坏数据直接丢弃而不是让面板崩掉） */
function loadDrafts(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, Draft> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const d = value as Partial<Draft>
      out[key] = {
        text: typeof d.text === 'string' ? d.text : '',
        images: Array.isArray(d.images)
          ? (d.images as ChatImage[]).filter((i): i is ChatImage => !!i && typeof i.path === 'string')
          : [],
      }
    }
    return out
  } catch {
    return {}
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingDrafts: Record<string, Draft> = {}

/** 节流落盘：多次变更合并成一次写入 */
function schedulePersist(drafts: Record<string, Draft>) {
  pendingDrafts = drafts
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingDrafts))
    } catch {
      // 配额满/隐私模式：草稿丢失不影响主流程
    }
  }, PERSIST_DELAY_MS)
}

interface DraftState {
  drafts: Record<string, Draft>
  /** 读取草稿（缺失时返回空草稿，调用方无需判空） */
  get: (key: string) => Draft
  /** 合并写入（只传变化的字段） */
  patch: (key: string, patch: Partial<Draft>) => void
  /** 清空某个会话的草稿（发送成功 / 用户手动清空） */
  clear: (key: string) => void
  /** 会话创建后把 `__new__` 草稿迁移到真实会话 id（目标已有草稿时不覆盖） */
  migrate: (from: string, to: string) => void
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: loadDrafts(),

  get: (key) => get().drafts[key] ?? EMPTY_DRAFT,

  patch: (key, patch) =>
    set((s) => {
      const prev = s.drafts[key] ?? EMPTY_DRAFT
      const drafts = { ...s.drafts, [key]: { ...prev, ...patch } }
      schedulePersist(drafts)
      return { drafts }
    }),

  clear: (key) =>
    set((s) => {
      if (!s.drafts[key]) return s
      const drafts = { ...s.drafts }
      delete drafts[key]
      schedulePersist(drafts)
      return { drafts }
    }),

  migrate: (from, to) =>
    set((s) => {
      const src = s.drafts[from]
      if (!src) return s
      if (src.text === '' && src.images.length === 0) return s
      if (s.drafts[to]) return s
      const drafts = { ...s.drafts, [to]: src }
      delete drafts[from]
      schedulePersist(drafts)
      return { drafts }
    }),
}))

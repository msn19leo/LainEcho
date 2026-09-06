import { create } from 'zustand'
import { api } from '../api'
import type { MemoryCategory, MemoryItem } from '../types'

interface MemoryState {
  /** 已确认记忆（手动添加 + 已确认候选；注入 system prompt） */
  items: MemoryItem[]
  /** 待确认候选（自动沉淀产物，未注入） */
  pendingItems: MemoryItem[]
  loading: boolean
  pendingLoading: boolean
  load: () => Promise<void>
  loadPending: () => Promise<void>
  /** 手动新增（confirmed=true），输入内容/分类/归属角色（null=全局背景） */
  add: (input: { content: string; category: MemoryCategory; characterCardId: string | null }) => Promise<boolean>
  update: (id: string, patch: { content?: string; category?: MemoryCategory }) => Promise<boolean>
  /** 确认待确认候选 → 移入已确认 */
  confirm: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  pendingItems: [],
  loading: false,
  pendingLoading: false,
  load: async () => {
    set({ loading: true })
    try {
      const items = await api.memory.list()
      set({ items: items.filter((m) => m.confirmed), loading: false })
    } catch (err) {
      set({ loading: false })
      console.error('加载记忆体失败', err)
    }
  },
  loadPending: async () => {
    set({ pendingLoading: true })
    try {
      const pendingItems = await api.memory.listPending()
      set({ pendingItems, pendingLoading: false })
    } catch (err) {
      set({ pendingLoading: false })
      console.error('加载待确认记忆失败', err)
    }
  },
  add: async (input) => {
    try {
      const item = await api.memory.add(input)
      set({ items: [item, ...get().items] })
      return true
    } catch (err) {
      console.error('添加记忆失败', err)
      return false
    }
  },
  update: async (id, patch) => {
    try {
      await api.memory.update(id, patch)
      set({ items: get().items.map((m) => (m.id === id ? { ...m, ...patch } : m)) })
      return true
    } catch (err) {
      console.error('更新记忆失败', err)
      return false
    }
  },
  confirm: async (id) => {
    try {
      await api.memory.confirm(id)
      const item = get().pendingItems.find((m) => m.id === id)
      set({
        pendingItems: get().pendingItems.filter((m) => m.id !== id),
        items: item ? [{ ...item, confirmed: true }, ...get().items] : get().items,
      })
      return true
    } catch (err) {
      console.error('确认记忆失败', err)
      return false
    }
  },
  remove: async (id) => {
    try {
      await api.memory.remove(id)
      set({
        items: get().items.filter((m) => m.id !== id),
        pendingItems: get().pendingItems.filter((m) => m.id !== id),
      })
      return true
    } catch (err) {
      console.error('删除记忆失败', err)
      return false
    }
  },
}))

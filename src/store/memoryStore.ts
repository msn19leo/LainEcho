import { create } from 'zustand'
import { api } from '../api'
import type { MemoryItem } from '../types'

interface MemoryState {
  items: MemoryItem[]
  loading: boolean
  load: () => Promise<void>
  add: (content: string) => Promise<boolean>
  update: (id: string, content: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  loading: false,
  load: async () => {
    set({ loading: true })
    try {
      const items = await api.memory.list()
      set({ items, loading: false })
    } catch (err) {
      set({ loading: false })
      console.error('加载记忆体失败', err)
    }
  },
  add: async (content) => {
    try {
      const item = await api.memory.add(content)
      set({ items: [item, ...get().items] })
      return true
    } catch (err) {
      console.error('添加记忆失败', err)
      return false
    }
  },
  update: async (id, content) => {
    try {
      await api.memory.update(id, content)
      set({ items: get().items.map((m) => (m.id === id ? { ...m, content } : m)) })
      return true
    } catch (err) {
      console.error('更新记忆失败', err)
      return false
    }
  },
  remove: async (id) => {
    try {
      await api.memory.remove(id)
      set({ items: get().items.filter((m) => m.id !== id) })
      return true
    } catch (err) {
      console.error('删除记忆失败', err)
      return false
    }
  },
}))

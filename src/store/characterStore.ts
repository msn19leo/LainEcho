import { create } from 'zustand'
import { api } from '../api'
import type { CharacterCard } from '../types'

interface CharacterState {
  cards: CharacterCard[]
  loading: boolean
  /** 聊天窗口当前选中的角色卡 */
  currentCardId: string | null
  load: () => Promise<void>
  setCurrentCard: (id: string | null) => void
}

export const useCharacterStore = create<CharacterState>((set) => ({
  cards: [],
  loading: false,
  currentCardId: null,
  load: async () => {
    set({ loading: true })
    try {
      const cards = await api.characterCard.list()
      set((s) => {
        const currentStillExists = s.currentCardId && cards.some((c) => c.id === s.currentCardId)
        return {
          cards,
          loading: false,
          currentCardId: currentStillExists ? s.currentCardId : (cards[0]?.id ?? null),
        }
      })
    } catch (err) {
      set({ loading: false })
      console.error('加载角色卡失败', err)
    }
  },
  setCurrentCard: (id) => set({ currentCardId: id }),
}))

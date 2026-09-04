/**
 * 桌宠"朗读"状态 store（追加式）。
 *
 * 语音跟读的核心：只维护一个 `displayedText`，随语音段落推进**只增不减地追加**完整段落，
 * 宠物窗与聊天窗都对该文本用 Typewriter 流式打字（追加不替换 → 天然不闪烁、不全出、
 * 不分段突变）；旁白（（））因所在 dialogue 项顺序与定型一致，位置一致。
 *
 * `active`：本轮语音跟读流程是否仍在进行（从确认有语音持续到最后一语音段播完）。
 * 宠物窗据此在语音期间用语音气泡、隐藏已落定的完整定型消息，避免 LLM 生成快于语音时
 * 先露出整段完整文本再"消失"。
 *
 * mode 三态（仅用 typewriter/follow）：'typewriter'=无语音流式打字；'follow'=语音段落跟读打字。
 */
import { create } from 'zustand'

export type PetRevealMode = 'typewriter' | 'immediate' | 'follow'

interface PetReadingState {
  mode: PetRevealMode
  /** 已追加进入"正在朗读/已朗读"的完整段落文本（追加式，\n 分段，含旁白） */
  displayedText: string
  /** 本轮语音跟读流程是否进行中 */
  active: boolean
  /** 是否有语音正在播放 */
  playing: boolean

  setMode: (m: PetRevealMode) => void
  setActive: (active: boolean) => void
  /** 语音进入某段时追加其完整段落文本（段随语音推进） */
  appendText: (text: string) => void
  /** 新一轮开始：仅清空已显示文本（保留 mode/active），避免把上一轮残留文本透给聊天窗 */
  clearText: () => void
  setPlaying: (playing: boolean) => void
  /** 新一轮流式：清空已显示文本与流程/播放态（保留 mode） */
  reset: () => void
}

export const usePetReadingStore = create<PetReadingState>((set) => ({
  mode: 'typewriter',
  displayedText: '',
  active: false,
  playing: false,

  setMode: (m) => set({ mode: m }),
  setActive: (a) => set({ active: a }),

  appendText: (text) =>
    set((s) => {
      // 压平连续换行为单个换行并去掉首尾换行，与定型消息的换行压制一致，
      // 确保任何窗口/任何阶段都不出现空行
      const cleaned = (text || '').replace(/\n+/g, '\n').trim()
      if (!cleaned) return s
      return {
        displayedText: s.displayedText ? `${s.displayedText}\n${cleaned}` : cleaned,
      }
    }),

  setPlaying: (playing) => set({ playing }),

  clearText: () => set({ displayedText: '' }),

  reset: () => set({ displayedText: '', active: false, playing: false }),
}))
/**
 * 桌宠"朗读"流程态 store（方案A精简版）。
 *
 * 方案A单源切换后，直播文本显示由 turnDocStore 快照驱动（src/store/turnDocStore.ts），
 * 本 store 只剩**语音链内部流程态**职责：
 *  - mode：本轮展示方式（follow=语音跟读；typewriter=无语音流式）——播放循环据此决定
 *    是否把块文本追加进跟读镜像；
 *  - segments/displayedText：宠物窗内容框的跟读镜像（appendText 只增不减），与快照渲染
 *    并行存在，供 PetApp 内部消费（不再跨窗转发——旧 chat:reading-* 链已退役）；
 *  - active/playing：收尾检查（maybeFinalizeReading）判断跟读流程是否仍挂着。
 */
import { create } from 'zustand'
import { inferChunkKind } from '../types'

export type PetRevealMode = 'typewriter' | 'immediate' | 'follow'

export interface ReadingSegment {
  text: string
  kind: 'speak' | 'narr'
}

interface PetReadingState {
  mode: PetRevealMode
  /** 已追加进入"正在朗读/已朗读"的完整段落文本（追加式，\n 分段，含旁白） */
  displayedText: string
  /** 结构化分段（与 displayedText 同步增长；跟读镜像按 kind 渲染旁白样式） */
  segments: ReadingSegment[]
  /** 本轮语音跟读流程是否进行中 */
  active: boolean
  /** 是否有语音正在播放 */
  playing: boolean

  setMode: (m: PetRevealMode) => void
  setActive: (active: boolean) => void
  /** 语音进入某段时追加其完整段落文本（段随语音推进）；kind 缺省按（）包裹推断 */
  appendText: (text: string, kind?: 'speak' | 'narr') => void
  /** 新一轮开始：仅清空已显示文本（保留 mode/active），避免把上一轮残留文本透给聊天窗 */
  clearText: () => void
  setPlaying: (playing: boolean) => void
  /** 新一轮流式：清空已显示文本与流程/播放态（保留 mode） */
  reset: () => void
}

export const usePetReadingStore = create<PetReadingState>((set) => ({
  mode: 'typewriter',
  displayedText: '',
  segments: [],
  active: false,
  playing: false,

  setMode: (m) => set({ mode: m }),
  setActive: (a) => set({ active: a }),

  appendText: (text, kind) =>
    set((s) => {
      // 压平连续换行为单个换行并去掉首尾换行，与定型消息的换行压制一致，
      // 确保任何窗口/任何阶段都不出现空行
      const cleaned = (text || '').replace(/\n+/g, '\n').trim()
      if (!cleaned) return s
      const seg: ReadingSegment = { text: cleaned, kind: kind ?? inferChunkKind({ text: cleaned }) }
      const segments = [...s.segments]
      // 与相邻同类型段合并（与定型多气泡的合并口径一致，避免每段一个泡的碎裂观感）
      const last = segments[segments.length - 1]
      if (last && last.kind === seg.kind) last.text = `${last.text}\n${cleaned}`
      else segments.push(seg)
      return {
        displayedText: s.displayedText ? `${s.displayedText}\n${cleaned}` : cleaned,
        segments,
      }
    }),

  setPlaying: (playing) => set({ playing }),

  clearText: () => set({ displayedText: '', segments: [] }),

  reset: () => set({ displayedText: '', segments: [], active: false, playing: false }),
}))

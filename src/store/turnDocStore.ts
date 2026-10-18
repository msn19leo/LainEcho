/**
 * 方案A：回合文档 store（两窗共用的快照消费者）。
 *
 * 渲染端"整体替换最近一次快照"——幂等：拿多少次、什么顺序、丢了重拿，结果一致。
 * 三个直播 store（sessionStore.streamingContent / petReadingStore.segments / chatReadingStore）
 * 的"直播阶段"职责由本 store 承接（见 docs/方案A-主进程回合文档与幂等快照协议.md §7）。
 *
 * 派生选择器：
 *  - liveSegments：显示用分段序列（closed/speaking 段全文 + speaking 段按 needsTypewriter 由
 *    调用方打字机揭示；spoken 段全文）——与定型多气泡同构（kind 驱动旁白/台词样式）；
 *  - userContent：进行中轮次的用户消息（认领补气泡权威源）；
 *  - phase：渲染分支依据（generating / reading / done）。
 */
import { create } from 'zustand'
import type { TurnDocument, TurnSegment } from '../types'

interface TurnDocState {
  /** 最近一次快照（null = 无进行中/刚结束的回合） */
  doc: TurnDocument | null
  /** 快照到达序号（单调递增，组件依赖刷新用） */
  seq: number

  /** 整体替换（幂等；turnId 相同也替换——segments/state 可能更新） */
  adopt: (doc: TurnDocument) => void
  /** 清空（新一轮 turn-start / 会话切换时由调用方触发；一般无需手动调用——新 turnId 自动换代） */
  clear: () => void
}

export const useTurnDocStore = create<TurnDocState>((set) => ({
  doc: null,
  seq: 0,
  adopt: (doc) => set((s) => ({ doc, seq: s.seq + 1 })),
  clear: () => set({ doc: null, seq: 0 }),
}))

/** 显示用分段视图：segments + trailing 拼接（trailing 挂在最后一段之后作为独立显示尾段） */
export interface TurnLiveSegment {
  text: string
  kind: 'speak' | 'narr'
  /** 语音进度（trailing 尾段为 closed） */
  state: 'closed' | 'speaking' | 'spoken'
}

export function liveSegmentsOf(doc: TurnDocument | null): TurnLiveSegment[] {
  if (!doc) return []
  const out: TurnLiveSegment[] = doc.segments.map((s: TurnSegment) => ({ text: s.text, kind: s.kind, state: s.state }))
  if (doc.trailing.trim()) out.push({ text: doc.trailing, kind: 'speak', state: 'closed' })
  return out
}

/**
 * 事件字段描述表（7.6 可视化编辑器）：表单渲染的唯一 UI 数据源。
 * 与 electron/services/storyEngine/schema.ts 的 validateEvent 保持同步——
 * 新增/修改事件字段时两处必须同时更新（test:story 端到端 + 本表）。
 * 复杂结构（choices.options / chapter_end.branches / aiJudge）由 EditorApp 专用编辑器处理，不进通用字段表。
 */
import type { StandardEmotion, StoryEvent } from '../types'

export type FieldKind = 'string' | 'text' | 'number' | 'boolean' | 'emotion' | 'chapter'

export interface FieldDesc {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  placeholder?: string
  help?: string
}

export interface EventTypeDesc {
  type: StoryEvent['type']
  label: string
  /** 通用字段（按 kind 渲染）；复杂结构由专用编辑器处理 */
  fields: FieldDesc[]
  /** 该事件是否有专用结构编辑器（choices / chapter_end） */
  custom?: boolean
}

export const STANDARD_EMOTION_OPTIONS: StandardEmotion[] = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy']

export const EVENT_DESCRIPTORS: EventTypeDesc[] = [
  { type: 'narration', label: '旁白', fields: [{ key: 'text', label: '旁白文本', kind: 'text', required: true }] },
  { type: 'player', label: '玩家独白', fields: [{ key: 'text', label: '独白文本', kind: 'text', required: true }] },
  { type: 'dialogue', label: '角色台词', fields: [{ key: 'text', label: '台词文本', kind: 'text', required: true }, { key: 'emotion', label: '情绪', kind: 'emotion' }] },
  { type: 'ai_dialogue', label: 'AI 自由演绎', fields: [{ key: 'prompt', label: '导演指令（这段演出的要求）', kind: 'text', required: true }] },
  { type: 'background', label: '切换背景', fields: [{ key: 'image', label: '背景图（剧本内相对路径 或 user:背景库文件名）', kind: 'string', required: true }] },
  { type: 'music', label: '音乐', fields: [{ key: 'file', label: '音乐文件（剧本内相对路径）', kind: 'string' }, { key: 'loop', label: '循环播放', kind: 'boolean' }, { key: 'stop', label: '停止当前音乐', kind: 'boolean' }] },
  { type: 'modify_character', label: '切换立绘情绪', fields: [{ key: 'emotion', label: '情绪', kind: 'emotion', required: true }] },
  { type: 'set_var', label: '设置变量', fields: [{ key: 'name', label: '变量名', kind: 'string', required: true }, { key: 'value', label: '值', kind: 'string', required: true }], custom: true },
  { type: 'free_dialogue', label: '自由对话', fields: [{ key: 'maxRounds', label: '最大轮数', kind: 'number' }, { key: 'endHint', label: '结束语（旁白）', kind: 'text' }] },
  { type: 'choices', label: '选项', fields: [], custom: true },
  { type: 'input', label: '自由输入', fields: [], custom: true },
  { type: 'chapter_end', label: '章节结束', fields: [], custom: true },
]

export function descriptorOf(type: string): EventTypeDesc | null {
  return EVENT_DESCRIPTORS.find((d) => d.type === type) ?? null
}

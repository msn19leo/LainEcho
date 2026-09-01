/**
 * 情绪 → 资源 映射编辑组件与工具函数（立绘集 / 角色卡 共用）。
 * 8 个标准情绪各一行，每行一个下拉选择对应资源（立绘图文件名 / exp3 表情名）。
 * 值为空串表示"不配置"（运行时回退 neutral / 覆盖 / 全局）。
 */
import { STANDARD_EMOTIONS, type StandardEmotion } from '../types'
import { Select } from './ui'

/** 情绪中文名（UI 展示），顺序与 STANDARD_EMOTIONS 对齐 */
export const EMOTION_LABELS: Record<StandardEmotion, string> = {
  neutral: '平静',
  happy: '开心',
  sad: '难过',
  angry: '生气',
  surprised: '惊讶',
  shy: '害羞',
}

/** 生成全为空的情绪映射（编辑器用） */
export function emptyEmotionMap(): Record<StandardEmotion, string> {
  const map = {} as Record<StandardEmotion, string>
  for (const emo of STANDARD_EMOTIONS) map[emo] = ''
  return map
}

/** 角色卡/立绘集情绪映射（Partial / null）→ 编辑器状态（空串 = 未配置） */
export function emotionMapToEditor(
  map: Partial<Record<StandardEmotion, string>> | null,
): Record<StandardEmotion, string> {
  const out = emptyEmotionMap()
  for (const emo of STANDARD_EMOTIONS) {
    const v = map?.[emo]
    out[emo] = v ?? ''
  }
  return out
}

/** 编辑器情绪映射 → 存储字段：仅保留非空的项，全空则为 null */
export function editorToEmotionMap(
  map: Record<StandardEmotion, string>,
): Partial<Record<StandardEmotion, string>> | null {
  const out: Partial<Record<StandardEmotion, string>> = {}
  let any = false
  for (const emo of STANDARD_EMOTIONS) {
    const v = map[emo]
    if (v) {
      out[emo] = v
      any = true
    }
  }
  return any ? out : null
}

/**
 * 情绪映射编辑器。
 * @param options 可选的资源（值 = 存储的文件名/表情名）
 * @param map 当前编辑中的映射（全量 8 情绪）
 */
export function EmotionMapEditor({
  title,
  hint,
  options,
  map,
  onChange,
  placeholder,
}: {
  title: string
  hint?: string
  options: { value: string; label: string }[]
  map: Record<StandardEmotion, string>
  onChange: (m: Record<StandardEmotion, string>) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
      <div className="text-[13px] font-medium text-text-2">{title}</div>
      {hint && <p className="mb-2 text-xs text-text-muted">{hint}</p>}
      {STANDARD_EMOTIONS.map((emo) => (
        <div key={emo} className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-text-muted">{EMOTION_LABELS[emo]}</span>
          <Select value={map[emo]} onChange={(e) => onChange({ ...map, [emo]: e.target.value })}>
            <option value="">{placeholder ?? '不配置'}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  )
}
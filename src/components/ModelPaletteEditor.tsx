/**
 * Live2D 模型情绪词表编辑器（模型侧演出词表，纯「词→表情」映射，与立绘集词表双轨对等）。
 *
 * - 词条行：情绪词 / 释义（注入 prompt 供 AI 理解）/ Live2D 表情联动（exp3.json 的 Name，可选）；
 * - 无默认情绪概念：AI 输出词未命中词条 → 不联动表情（回落全局静态表情）；
 * - 词表为空 = 运行时按内置最小词表（仅"平静"）处理：无表情联动；
 * - 保存经 model:updatePalette(modelId, { entries }) 全量写回 data/model-palettes.json。
 *   演出形象二选一：Live2D 模式用本词表，sprite 模式用立绘集词表，两个世界的词互不干扰。
 */
import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import type { Live2DModelMeta, ModelPaletteEntry } from '../types'
import { Button } from './ui'
import { SelectMenu } from './DropdownMenu'
import { toast } from './toast'

export function ModelPaletteEditor({ model, onClose, onSaved }: {
  model: Live2DModelMeta | null
  onClose: () => void
  /** 保存成功后回调 */
  onSaved: () => void
}) {
  const [entries, setEntries] = useState<ModelPaletteEntry[]>([])
  const [expressionNames, setExpressionNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // 打开时：加载该模型已配置的词表（无 = 空）+ 该模型的表情名列表
  useEffect(() => {
    if (!model) return
    void (async () => {
      try {
        const [palette, exprList] = await Promise.all([
          api.model.getPalette(model.id),
          api.model.expressionList(model.id),
        ])
        setEntries(palette ? palette.entries.map((e) => ({ ...e })) : [])
        setExpressionNames(exprList.map((e) => e.name))
      } catch {
        setEntries([])
        setExpressionNames([])
      }
    })()
  }, [model?.id])

  const patch = (i: number, p: Partial<ModelPaletteEntry>) =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...p } : e)))

  /** 保存前校验：词名唯一非空 */
  const validate = (): string | null => {
    const names = new Set<string>()
    for (const e of entries) {
      const name = e.name.trim()
      if (!name) return '情绪词不能为空'
      if (names.has(name)) return `情绪词重复：「${name}」`
      names.add(name)
    }
    return null
  }

  const save = async () => {
    if (!model || saving) return
    const problem = validate()
    if (problem) {
      toast(problem, 'error')
      return
    }
    setSaving(true)
    try {
      // 词表为空 = 删除该模型的词表配置（运行时落内置最小词表）；expression 空值剥离（不联动）
      const cleaned = entries
        .map((e) => ({
          name: e.name.trim(),
          gloss: e.gloss.trim(),
          ...(e.expression?.trim() ? { expression: e.expression.trim() } : {}),
        }))
        .filter((e) => e.name)
      await api.model.updatePalette(model.id, { entries: cleaned })
      toast('模型情绪词表已保存')
      onSaved()
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const expressionOptions = [
    { value: '', label: expressionNames.length > 0 ? '不联动表情' : '该模型无可用的 exp3.json 表情' },
    ...expressionNames.map((n) => ({ value: n, label: n })),
  ]

  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed text-text-muted">
        模型情绪词表决定 Live2D 模式下 AI 的 emotion 值域与表情联动：对话情绪命中词条时，形象平滑切换到绑定的表情；未配置的词回落全局静态表情。词表为空时按内置最小词表（仅"平静"）处理。释义会随词注入 prompt，帮 AI 判断什么场面用哪个词。
      </p>

      <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
        {entries.length > 0 && (
          <div className="grid grid-cols-[92px_1fr_150px_auto] items-center gap-1.5 px-0.5">
            <span className="text-[11px] text-text-muted">情绪词</span>
            <span className="text-[11px] text-text-muted">释义（注入 prompt 供 AI 理解）</span>
            <span className="text-[11px] text-text-muted">Live2D 表情</span>
            <span />
          </div>
        )}
        {entries.length === 0 && (
          <div className="rounded-[var(--radius-md)] border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
            词表为空。「添加词条」手动配置情绪词与表情联动。
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="grid grid-cols-[92px_1fr_150px_auto] items-center gap-1.5">
            <input
              value={e.name}
              onChange={(ev) => patch(i, { name: ev.target.value })}
              placeholder="情绪词"
              className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none"
            />
            <input
              value={e.gloss}
              onChange={(ev) => patch(i, { gloss: ev.target.value })}
              placeholder="释义（注入 prompt）"
              className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none"
            />
            <SelectMenu
              value={e.expression ?? ''}
              onChange={(v) => patch(i, { expression: v || undefined })}
              options={expressionOptions}
            />
            <button
              onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
              className="rounded-[var(--radius-md)] p-1.5 text-text-2 hover:bg-card-hover hover:text-red-400"
              title="删除词条"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <Button variant="ghost" size="sm" onClick={() => setEntries((prev) => [...prev, { name: '', gloss: '' }])}>
          <Plus size={14} /> 添加词条
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? (
            <>
              <Loader2 size={13} className="animate-spin" /> 保存中…
            </>
          ) : (
            '保存词表'
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * 状态演出编辑器（Live2D 模型侧，与立绘集词表双轨对等）。
 *
 * 核心约定：**一个编号 = 一条标签 = 一个表情**。
 *
 * - 编号由 AI 输出，用它决定切到哪个表情；编号顺序 = 表格行顺序，
 *   保存时按行序落盘（`entries` 数组顺序即编号）；
 * - **默认表情常驻编号 1**：它不绑具体表情，长相取「角色模型 → 外观」里的静态表情，
 *   相当于"没有专属表情"的那一档；其余行按添加顺序排；
 * - 标签是**一个整体**，可含「，」分隔的多段同义词（`害羞，心动`），一个表情只占一个编号；
 * - 一个表情只能被一行占用（否则两个编号对应同一张脸，AI 无法区分）；
 * - 未使用的表情不出现在表里，收在「添加表情」下拉中。
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { api } from '../api'
import { normalizeLabel, type Live2DModelMeta, type ModelPaletteEntry } from '../types'
import { Button } from './ui'
import { SelectMenu } from './DropdownMenu'
import { toast } from './toast'

/** 默认表情行：expression 为空，编号恒为 1 */
const DEFAULT_ROW: ModelPaletteEntry = { name: '平静' }

export function ModelPaletteEditor({ model, onClose, onSaved, onDirtyChange }: {
  model: Live2DModelMeta | null
  /** 保存成功后由编辑器主动关闭（绕过父级的"未保存"守卫） */
  onClose: () => void
  /** 保存成功后回调 */
  onSaved: () => void
  /** 草稿脏标记回调：父级据此决定关闭时是否需要"放弃未保存修改"确认 */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [entries, setEntries] = useState<ModelPaletteEntry[]>([])
  const [expressionNames, setExpressionNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  /** 打开时的签名快照（脏标记基准）：顺序也参与比较——行序就是编号 */
  const [baseSig, setBaseSig] = useState('')

  // 打开时：加载该模型已配置的词表（无 = 空）+ 该模型的表情名列表
  useEffect(() => {
    if (!model) return
    void (async () => {
      try {
        const [palette, exprList] = await Promise.all([
          api.model.getPalette(model.id),
          api.model.expressionList(model.id),
        ])
        const loaded = palette ? palette.entries.map((e) => ({ ...e })) : []
        // 默认行常驻编号 1：旧数据可能没有（或不在首位），这里补齐并置顶
        const def = loaded.find((e) => !e.expression?.trim())
        const rest = loaded.filter((e) => !!e.expression?.trim())
        const next = [def ?? { ...DEFAULT_ROW }, ...rest]
        setEntries(next)
        setBaseSig(signature(next))
        setExpressionNames(exprList.map((e) => e.name))
      } catch {
        const next = [{ ...DEFAULT_ROW }]
        setEntries(next)
        setBaseSig(signature(next))
        setExpressionNames([])
      }
    })()
  }, [model?.id])

  /** 行序即编号：签名里保留数组顺序，任何顺序变化都算改动 */
  function signature(list: ModelPaletteEntry[]): string {
    return JSON.stringify(
      list
        .map((e) => ({ n: normalizeLabel(e.name), x: (e.expression ?? '').trim() }))
        .filter((e) => e.n),
    )
  }

  const dirty = baseSig !== '' && signature(entries) !== baseSig
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const patch = (i: number, p: Partial<ModelPaletteEntry>) =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...p } : e)))

  /** 行 i 的表情是否可改：默认行锁定，其余可选未被占用的表情（含自己当前的） */
  const optionsFor = (i: number) => {
    const used = new Set(entries.filter((_, j) => j !== i).map((e) => e.expression?.trim() ?? ''))
    return [
      ...expressionNames
        .filter((n) => !used.has(n))
        .map((n) => ({ value: n, label: n })),
    ]
  }

  /** 还没被任何行占用的表情（用于「添加表情」） */
  const unusedExpressions = useMemo(() => {
    const used = new Set(entries.map((e) => e.expression?.trim() ?? ''))
    return expressionNames.filter((n) => !used.has(n))
  }, [entries, expressionNames])

  const addRow = (expression: string) => {
    if (!expression) return
    setEntries((prev) => [...prev, { name: '', expression }])
  }

  /**
   * 保存前校验：只有**整条标签完全相同**才算重复（部分重合合法——同一情绪可以配不同表情，
   * AI 输出的是编号，文字相近不会混淆）；一个表情仍只能占一行。
   */
  const validate = (): string | null => {
    const kept = entries.filter((e) => normalizeLabel(e.name))
    const seen = new Map<string, number>()
    for (let i = 0; i < kept.length; i++) {
      const name = normalizeLabel(kept[i]!.name)
      const prev = seen.get(name)
      if (prev !== undefined) return `编号 ${i + 1} 与编号 ${prev + 1} 的状态词相同：「${name}」`
      seen.set(name, i)
    }
    const exprs = new Set<string>()
    for (const e of kept) {
      const key = e.expression?.trim() ?? ''
      if (exprs.has(key)) return key ? `表情「${key}」被配置了多行，请合并成一行` : '默认表情只能有一行'
      exprs.add(key)
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
      // 行序即编号：默认行固定首行；空标签的行直接丢弃（等于不参与演出）
      const cleaned = entries
        .map((e) => ({
          name: normalizeLabel(e.name),
          ...(e.expression?.trim() ? { expression: e.expression.trim() } : {}),
        }))
        .filter((e) => e.name)
      await api.model.updatePalette(model.id, { entries: cleaned })
      toast('模型状态词表已保存')
      onSaved()
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const withLabel = entries.filter((e) => normalizeLabel(e.name))

  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed text-text-muted">
        一个编号对应一个表情：编号由 AI 输出，用它决定切到哪个表情。默认表情常驻编号 1（长相取「角色模型 → 外观」里的静态表情），
        其余表情按添加顺序编号。同一表情可以填多个词（用「，」分隔），它们是一个整体、共用一个编号。
      </p>

      <div className="max-h-[340px] space-y-1.5 overflow-y-auto pr-1">
        <div className="grid grid-cols-[34px_150px_1fr_28px] items-center gap-1.5 px-0.5">
          <span className="text-[11px] text-text-muted">编号</span>
          <span className="text-[11px] text-text-muted">表情</span>
          <span className="text-[11px] text-text-muted">状态词（多个用「，」分隔）</span>
          <span />
        </div>

        {entries.map((e, i) => {
          const isDefault = !e.expression?.trim()
          // 编号按"有标签的行"计数（保存时空行会被丢弃），与 AI 实际看到的编号一致
          const num = normalizeLabel(e.name)
            ? entries.slice(0, i).filter((x) => normalizeLabel(x.name)).length + 1
            : null
          return (
            <div key={i} className="grid grid-cols-[34px_150px_1fr_28px] items-center gap-1.5">
              <span className="text-center text-[11px] tabular-nums text-text-muted">{num ?? '—'}</span>
              {isDefault ? (
                <span
                  className="rounded-[var(--radius-md)] border border-dashed border-border px-2 py-1 text-[11px] text-text-muted"
                  title="沿用「角色模型 → 外观」里设置的静态表情"
                >
                  默认表情
                </span>
              ) : (
                <SelectMenu
                  value={e.expression ?? ''}
                  onChange={(v) => patch(i, { expression: v || undefined })}
                  options={optionsFor(i)}
                />
              )}
              <input
                value={e.name}
                onChange={(ev) => patch(i, { name: ev.target.value })}
                placeholder={isDefault ? '如：平静（不切表情的那一档）' : '如：害羞，心动'}
                className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none focus:border-[var(--border-strong)]"
              />
              {isDefault ? (
                <span />
              ) : (
                <button
                  onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded-[var(--radius-md)] p-1.5 text-text-2 hover:bg-card-hover hover:text-red-400"
                  title="删除该行（对应表情回到未使用）"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <div className="w-[190px]">
          <SelectMenu
            value=""
            onChange={(v) => addRow(v)}
            options={[
              {
                value: '',
                label: unusedExpressions.length > 0 ? `+ 添加表情（未使用 ${unusedExpressions.length}）` : expressionNames.length > 0 ? '全部表情已使用' : '该模型无 exp3.json 表情',
              },
              ...unusedExpressions.map((n) => ({ value: n, label: n })),
            ]}
          />
        </div>
        <span className="text-[11px] text-text-muted">
          {withLabel.length} 个编号 · 未使用 {unusedExpressions.length} 个表情
        </span>
        <div className="ml-auto">
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

      {/* AI 视角预览：真实注入的编号清单 */}
      <details className="rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] text-text-muted">AI 视角预览（{withLabel.length} 个编号）</summary>
        <ol className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-4 text-text-2">
          {entries.map((e) => (normalizeLabel(e.name) ? e : null)).filter(Boolean).map((e, i) => (
            <li key={i}>
              {i + 1}. {normalizeLabel(e!.name)}
              {!e!.expression?.trim() && <span className="text-amber-400">（默认表情）</span>}
            </li>
          ))}
          {withLabel.length === 0 && <li className="text-text-muted">（空：AI 只能选内置的「平静」）</li>}
        </ol>
      </details>

      <p className="text-[11px] leading-relaxed text-text-muted">
        编号只是 AI 的输出约定，不落盘：消息与剧本里记录的是状态词本身。新增一个表情插在末尾，不影响已有编号的含义；
        未使用的表情不占编号。
      </p>
    </div>
  )
}

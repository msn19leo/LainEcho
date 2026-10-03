/**
 * 情绪词表编辑器（立绘集用，词表方案唯一情绪配置入口）。
 *
 * - 词条行：情绪词 / 释义（注入 prompt 供 AI 理解）/ 对应立绘图（必填）；
 * - 默认情绪：词表内选一词作兜底终点（系统唯一保留字，亦是空闲/重置时的默认展示）；
 * - 说话/思考立绘：系统演出态图（不进词表）；
 * - 视觉打标：一键调用视觉模型逐张生成建议，按词归并回填草稿（产物不落库，保存才生效）；
 * - 保存经 sprite:update({ emotions, defaultEmotion, speakingImage, thinkingImage }) 一次写回。
 *   注意：条目的 expression（Live2D 表情联动）在 Live2D 模型卡的「表情联动」弹窗维护，
 *   此处保存时原样透传，防止全量重建抹掉绑定。
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../api'
import type { CharacterSprite, SpritePaletteEntry } from '../types'
import { Button } from './ui'
import { SelectMenu } from './DropdownMenu'

export function SpritePaletteEditor({ sprite, onSaved }: {
  sprite: CharacterSprite
  /** 保存成功后回调（父级刷新立绘集列表） */
  onSaved: () => void
}) {
  const [entries, setEntries] = useState<SpritePaletteEntry[]>([])
  const [defaultEmotion, setDefaultEmotion] = useState('')
  const [speakingImage, setSpeakingImage] = useState('')
  const [thinkingImage, setThinkingImage] = useState('')
  const [annotating, setAnnotating] = useState(false)
  const [saving, setSaving] = useState(false)

  // 打开/切换立绘集时从当前配置初始化草稿
  useEffect(() => {
    setEntries(sprite.emotions.map((e) => ({ ...e })))
    setDefaultEmotion(sprite.defaultEmotion || sprite.emotions[0]?.name || '')
    setSpeakingImage(sprite.speakingImage ?? '')
    setThinkingImage(sprite.thinkingImage ?? '')
  }, [sprite.id, sprite.emotions, sprite.defaultEmotion, sprite.speakingImage, sprite.thinkingImage])

  const imageOptions = useMemo(
    () => sprite.images.map((i) => ({ value: i.filePath, label: i.filePath })),
    [sprite.images],
  )

  /** 视觉打标：建议按词归并回填草稿；已有同名词不覆盖（保护用户手动配置） */
  const runAnnotate = async () => {
    if (annotating) return
    setAnnotating(true)
    try {
      const res = await api.sprite.annotate(sprite.id)
      if (!res.ok || !res.suggestions) {
        toast.error(res.error ?? '打标失败')
        return
      }
      let added = 0
      setEntries((prev) => {
        const next = [...prev]
        const seen = new Set(next.map((e) => e.name))
        for (const s of res.suggestions!) {
          if (seen.has(s.name)) continue // 同名已存在：保留用户配置
          seen.add(s.name)
          next.push({ name: s.name, gloss: s.desc, image: s.filePath })
          added++
        }
        return next
      })
      setDefaultEmotion((d) => d || res.suggestions![0]?.name || '')
      toast.success(`打标完成：新增 ${added} 条建议（${res.failed ?? 0} 张失败）；确认后点"保存词表"生效`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打标失败')
    } finally {
      setAnnotating(false)
    }
  }

  /** 保存前校验：词名唯一非空 / 图必选 / 默认词在表内 */
  const validate = (): string | null => {
    const names = new Set<string>()
    for (const e of entries) {
      const name = e.name.trim()
      if (!name) return '情绪词不能为空'
      if (names.has(name)) return `情绪词重复：「${name}」`
      names.add(name)
      if (!e.image) return `情绪词「${name}」未选择立绘图`
    }
    if (entries.length > 0 && !names.has(defaultEmotion)) return '默认情绪必须是词表中的词'
    return null
  }

  const save = async () => {
    if (saving) return
    const problem = validate()
    if (problem) {
      toast.error(problem)
      return
    }
    setSaving(true)
    try {
      // 词表为空 = 未打标（运行时按内置最小词表"平静"处理），defaultEmotion 一并清空；
      // 显式重建三要素字段，剥离存量数据可能残留的旧软链字段与旧表情联动字段
      // （Live2D 表情联动已随演出词表双轨迁移到模型词表 data/model-palettes.json，立绘词表不再承载）
      const cleaned = entries.map((e) => ({
        name: e.name.trim(),
        gloss: e.gloss.trim(),
        image: e.image,
      }))
      await api.sprite.update(sprite.id, {
        emotions: cleaned,
        defaultEmotion: cleaned.length > 0 ? defaultEmotion : '',
        speakingImage: speakingImage || null,
        thinkingImage: thinkingImage || null,
      })
      toast.success('情绪词表已保存')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const patch = (i: number, p: Partial<SpritePaletteEntry>) =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...p } : e)))

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-text-muted">
          情绪词表决定 AI 的 emotion 值域与立绘切换：词命中 → 默认情绪。说话图仅在「情绪=平静」的说话态让位。未打标的立绘集按内置最小词表（仅"平静"）处理，解析落首图。释义会随词注入 prompt，帮 AI 判断什么场面用哪个词。
        </p>
        <Button variant="outline" size="sm" onClick={() => void runAnnotate()} disabled={annotating}>
          {annotating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {annotating ? '打标中…' : '视觉打标'}
        </Button>
      </div>

      <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
        {entries.length > 0 && (
          <div className="grid grid-cols-[92px_1fr_1.15fr_auto] items-center gap-1.5 px-0.5">
            <span className="text-[11px] text-text-muted">情绪词</span>
            <span className="text-[11px] text-text-muted">释义（注入 prompt 供 AI 理解）</span>
            <span className="text-[11px] text-text-muted">立绘图</span>
            <span />
          </div>
        )}
        {entries.length === 0 && (
          <div className="rounded-[var(--radius-md)] border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
            词表为空。点「视觉打标」自动生成建议，或「添加词条」手动配置。
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="grid grid-cols-[92px_1fr_1.15fr_auto] items-center gap-1.5">
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
              value={e.image}
              onChange={(v) => patch(i, { image: v })}
              options={[{ value: '', label: '选择立绘图' }, ...imageOptions]}
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

      <div className="space-y-2 border-t border-border pt-2">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-text-muted">说话立绘</span>
          <SelectMenu
            value={speakingImage}
            onChange={setSpeakingImage}
            options={[{ value: '', label: '不配置' }, ...imageOptions]}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-text-muted">思考立绘</span>
          <SelectMenu
            value={thinkingImage}
            onChange={setThinkingImage}
            options={[{ value: '', label: '不配置' }, ...imageOptions]}
          />
        </div>
        <p className="text-[11px] text-text-muted">
          说话图在「正在说话且情绪=平静」时使用（默认情绪可设为其它情绪，说话时显示该情绪的图）；思考图在 AI 准备回答期间使用。二者为系统演出态，不属于词表。
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEntries((prev) => [...prev, { name: '', gloss: '', image: '' }])}>
          <Plus size={14} /> 添加词条
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">默认情绪</span>
          <div className="w-32">
            <SelectMenu
              value={defaultEmotion}
              onChange={setDefaultEmotion}
              options={entries.filter((e) => e.name.trim()).map((e) => ({ value: e.name.trim(), label: e.name.trim() }))}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={saving || entries.length === 0}>
            {saving ? '保存中…' : '保存词表'}
          </Button>
        </div>
      </div>
    </div>
  )
}

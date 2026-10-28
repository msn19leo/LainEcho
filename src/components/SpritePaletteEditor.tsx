/**
 * 状态词表编辑器（立绘集用，词表方案唯一状态配置入口）。
 *
 * - 以图为中心的所见即所得编辑：左侧立绘缩略图网格（完整显示+滚动），
 *   点选缩略图 → 右侧大图预览 + 编辑挂在该图上的状态词列表（一图可挂多词，如"中性 平静"）；
 * - 词表数据模型不变（词 → 图：SpritePaletteEntry{name, gloss, image}，多词可指向同一图），
 *   "图为中心"只是编辑视角反转——prompt 注入 / AI 解析 / 渲染链零改动；
 * - 孤立词条兜底：无绑定图的存量词条显示在右区「未绑定立绘图」分组，可编辑或一键绑定到当前图；
 * - 默认状态：词表内选一词作兜底终点（系统唯一保留字，亦是空闲/重置时的默认展示）；
 * - 说话/思考立绘：系统演出态图（不进词表），选中缩略图后一键设置，带缩略预览与清除；
 * - 视觉打标：一键调用视觉模型逐张生成建议，按词归并回填草稿（产物不落盘，保存才生效）；
 * - 保存经 sprite:update({ emotions, defaultEmotion, speakingImage, thinkingImage }) 一次写回。
 *   注意：条目的 expression（Live2D 表情联动）在 Live2D 模型卡的「表情联动」弹窗维护，
 *   此处保存时原样透传，防止全量重建抹掉绑定。
 */
import { useEffect, useMemo, useState } from 'react'
import { ImageOff, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../api'
import type { CharacterSprite, SpritePaletteEntry } from '../types'
import { Button } from './ui'
import { SelectMenu } from './DropdownMenu'
import { cn } from '../lib/utils'

export function SpritePaletteEditor({ sprite, onSaved, onEntriesChange }: {
  sprite: CharacterSprite
  /** 保存成功后回调（父级刷新立绘集列表） */
  onSaved: () => void
  /** 词条数量变化回调（弹窗标题的状态词数量实时同步，增删即更新） */
  onEntriesChange?: (count: number) => void
}) {
  const [entries, setEntries] = useState<SpritePaletteEntry[]>([])
  const [defaultEmotion, setDefaultEmotion] = useState('')
  const [speakingImage, setSpeakingImage] = useState('')
  const [thinkingImage, setThinkingImage] = useState('')
  const [observingImage, setObservingImage] = useState('')
  const [annotating, setAnnotating] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 当前选中的缩略图（右区大图预览与挂词编辑的作用对象；默认第一张） */
  const [selectedImage, setSelectedImage] = useState('')

  // 打开/切换立绘集时从当前配置初始化草稿
  useEffect(() => {
    setEntries(sprite.emotions.map((e) => ({ ...e })))
    setDefaultEmotion(sprite.defaultEmotion || sprite.emotions[0]?.name || '')
    setSpeakingImage(sprite.speakingImage ?? '')
    setThinkingImage(sprite.thinkingImage ?? '')
    setObservingImage(sprite.observingImage ?? '')
    setSelectedImage(sprite.images[0]?.filePath ?? '')
  }, [sprite.id, sprite.emotions, sprite.defaultEmotion, sprite.speakingImage, sprite.thinkingImage, sprite.observingImage])

  // 词条数量变化 → 回调父级（弹窗标题实时同步）
  useEffect(() => {
    onEntriesChange?.(entries.length)
  }, [entries.length, onEntriesChange])

  /** 立绘图预览 URL（pet-res:// 协议，设置窗可直接访问） */
  const imageUrl = useMemo(
    () => (file: string) => (file ? api.pet.spriteUrl(sprite.id, file) : ''),
    [sprite.id],
  )

  /** 当前选中图挂着的词条（原索引随行，编辑/删除按原索引操作） */
  const boundEntries = useMemo(
    () =>
      entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.image === selectedImage),
    [entries, selectedImage],
  )

  /** 未绑定任何图的孤立词条（存量数据兜底；图为中心视图下它们不会出现在任何图下方） */
  const unboundEntries = useMemo(
    () =>
      entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !e.image),
    [entries],
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
      if (!name) return '状态词不能为空'
      if (names.has(name)) return `状态词重复：「${name}」`
      names.add(name)
      if (!e.image) return `状态词「${name}」未选择立绘图`
    }
    if (entries.length > 0 && !names.has(defaultEmotion)) return '默认状态必须是词表中的词'
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
        observingImage: observingImage || null,
      })
      toast.success('状态词表已保存')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const patch = (i: number, p: Partial<SpritePaletteEntry>) =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...p } : e)))

  /** 删除词条（索引按 entries 原始下标） */
  const removeEntry = (i: number) => setEntries((prev) => prev.filter((_, j) => j !== i))

  /** 为当前选中图添加一个状态词（新词条直接绑定该图） */
  const addEntryToSelected = () => {
    if (!selectedImage) {
      toast.error('请先在左侧选择一张立绘图')
      return
    }
    setEntries((prev) => [...prev, { name: '', gloss: '', image: selectedImage }])
  }

  /** 词行（状态词 + 可选释义 + 删除）：图为中心视图下的基本编辑单元 */
  const wordRow = (e: SpritePaletteEntry, i: number) => (
    <div key={i} className="grid grid-cols-[96px_minmax(0,1fr)_26px] items-center gap-1.5">
      <input
        value={e.name}
        onChange={(ev) => patch(i, { name: ev.target.value })}
        placeholder="状态词"
        className="w-full rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none"
      />
      <input
        value={e.gloss}
        onChange={(ev) => patch(i, { gloss: ev.target.value })}
        placeholder="释义（可选，注入 prompt）"
        className="w-full rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none"
      />
      <button
        onClick={() => removeEntry(i)}
        className="rounded-[var(--radius-sm)] p-1.5 text-text-2 hover:bg-card-hover hover:text-red-400"
        title="删除该状态词"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
          状态词表决定 AI 的 emotion 值域与立绘切换：词命中 → 默认状态。说话图仅在「状态=平静/默认状态」的说话态让位。
          左侧点选立绘 → 右侧大图下编辑挂在该图上的状态词（一图可挂多词）。未打标的立绘集按内置最小词表（仅"平静"）处理。
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 whitespace-nowrap"
          onClick={() => void runAnnotate()}
          disabled={annotating}
        >
          {annotating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {annotating ? '打标中…' : '视觉打标'}
        </Button>
      </div>

      {/* 上区：左缩略图网格 + 右大图预览/挂词编辑 */}
      <div className="flex items-stretch gap-3">
        {/* 左：缩略图网格（object-contain 完整显示立绘；内部滚动） */}
        <div className="min-w-0 flex-1">
          <div className="grid max-h-[464px] grid-cols-3 gap-1.5 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-bg-panel p-1.5 pr-1">
            {sprite.images.map((img) => {
              const bound = entries.filter((e) => e.image === img.filePath).map((e) => e.name.trim() || '（未命名）')
              const isSpeaking = speakingImage === img.filePath
              const isThinking = thinkingImage === img.filePath
              const isObserving = observingImage === img.filePath
              return (
                <button
                  key={img.filePath}
                  onClick={() => setSelectedImage(img.filePath)}
                  className={cn(
                    'flex flex-col overflow-hidden rounded border transition-all',
                    selectedImage === img.filePath
                      ? 'border-[var(--primary-400)] ring-1 ring-[var(--primary-400)]'
                      : 'border-border hover:border-[var(--border-strong)]',
                  )}
                  title={img.filePath}
                >
                  <span className="flex h-[104px] items-center justify-center bg-surface-2">
                    <img src={imageUrl(img.filePath)} alt={img.filePath} className="h-full w-full object-contain" />
                  </span>
                  <span
                    className={cn(
                      'block truncate px-0.5 text-center text-[10px] leading-5',
                      bound.length > 0 || isSpeaking || isThinking || isObserving ? 'text-[var(--primary-400)]' : 'text-text-muted',
                    )}
                  >
                    {bound.length > 0 ? bound.join('·') : '未标注'}
                    {isSpeaking && <span className="text-amber-400"> · 说话图</span>}
                    {isThinking && <span className="text-violet-400"> · 思考图</span>}
                    {isObserving && <span className="text-sky-400"> · 观察图</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：大图预览 + 该图的挂词编辑 + 说话/思考图设置 */}
        <div className="flex w-[364px] shrink-0 flex-col gap-2">
          <div className="flex h-80 items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface-2">
            {selectedImage ? (
              <img src={imageUrl(selectedImage)} alt={selectedImage} className="h-full w-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-text-muted">
                <ImageOff size={20} strokeWidth={1.5} />
                <span className="text-[11px]">点左侧缩略图预览</span>
              </div>
            )}
          </div>

          {/* 该图挂着的状态词（词 + 可选释义 + 删除；一图多词） */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted">该图的状态词（一图可挂多词）</span>
              <button
                onClick={addEntryToSelected}
                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-[var(--primary-400)] hover:bg-card-hover"
                title="在这张图上添加一个新状态词"
              >
                <Plus size={11} /> 为该图添加状态词
              </button>
            </div>
            <div className="max-h-[150px] space-y-1 overflow-y-auto pr-0.5">
              {boundEntries.length === 0 && (
                <div className="rounded-[var(--radius-md)] border border-dashed border-border px-2 py-3 text-center text-[11px] text-text-muted">
                  这张图还没有状态词，点上方「为该图添加状态词」
                </div>
              )}
              {boundEntries.map(({ e, i }) => wordRow(e, i))}
            </div>
          </div>

          {/* 孤立词条兜底：无绑定图的存量词条（不出现在任何图下方，在此编辑/绑定） */}
          {unboundEntries.length > 0 && (
            <div className="space-y-1 rounded-[var(--radius-md)] border border-dashed border-border p-1.5">
              <div className="text-[11px] text-text-muted">未绑定立绘图的词条（点「绑到当前图」修复）</div>
              <div className="max-h-[96px] space-y-1 overflow-y-auto pr-0.5">
                {unboundEntries.map(({ e, i }) => (
                  <div key={i} className="grid grid-cols-[96px_minmax(0,1fr)_26px] items-center gap-1.5">
                    <input
                      value={e.name}
                      onChange={(ev) => patch(i, { name: ev.target.value })}
                      placeholder="状态词"
                      className="w-full rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs outline-none"
                    />
                    <button
                      onClick={() => patch(i, { image: selectedImage })}
                      disabled={!selectedImage}
                      className="rounded-[var(--radius-sm)] border border-border px-1 py-1 text-[10px] text-[var(--primary-400)] hover:bg-card-hover disabled:opacity-40"
                      title="把该词条绑定到当前选中的立绘图"
                    >
                      绑到当前图
                    </button>
                    <button
                      onClick={() => removeEntry(i)}
                      className="rounded-[var(--radius-sm)] p-1.5 text-text-2 hover:bg-card-hover hover:text-red-400"
                      title="删除该词条"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 说话/思考/观察图：一键作用于当前选中的图 + 缩略预览与清除 */}
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 px-1.5 text-[11px]"
              disabled={!selectedImage}
              onClick={() => setSpeakingImage(selectedImage)}
              title="把选中的立绘图设为说话立绘（状态=平静的说话态使用）"
            >
              设为说话图
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 px-1.5 text-[11px]"
              disabled={!selectedImage}
              onClick={() => setThinkingImage(selectedImage)}
              title="把选中的立绘图设为思考立绘（AI 准备回答期间使用）"
            >
              设为思考图
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 px-1.5 text-[11px]"
              disabled={!selectedImage}
              onClick={() => setObservingImage(selectedImage)}
              title="把选中的立绘图设为观察立绘（点桌宠眼睛看屏幕的那几秒使用）"
            >
              设为观察图
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-text-muted">说话图</span>
              {speakingImage ? (
                <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded border border-border">
                  <img src={imageUrl(speakingImage)} alt="说话图" className="h-full w-full object-cover" />
                  <button
                    onClick={() => setSpeakingImage('')}
                    className="absolute inset-y-0 right-0 flex w-3 items-center justify-center bg-black/50 text-white"
                    title="清除说话图"
                  >
                    <X size={8} />
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-text-muted">未配置</span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-text-muted">思考图</span>
              {thinkingImage ? (
                <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded border border-border">
                  <img src={imageUrl(thinkingImage)} alt="思考图" className="h-full w-full object-cover" />
                  <button
                    onClick={() => setThinkingImage('')}
                    className="absolute inset-y-0 right-0 flex w-3 items-center justify-center bg-black/50 text-white"
                    title="清除思考图"
                  >
                    <X size={8} />
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-text-muted">未配置</span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-text-muted">观察图</span>
              {observingImage ? (
                <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded border border-border">
                  <img src={imageUrl(observingImage)} alt="观察图" className="h-full w-full object-cover" />
                  <button
                    onClick={() => setObservingImage('')}
                    className="absolute inset-y-0 right-0 flex w-3 items-center justify-center bg-black/50 text-white"
                    title="清除观察图"
                  >
                    <X size={8} />
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-text-muted">未配置</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-text-muted">
        说话图在「正在说话且状态=平静/默认状态」时使用（默认状态可设为其它词，说话时显示该状态的图）；思考图在 AI
        准备回答期间使用；观察图在你点桌宠眼睛、角色看屏幕的那几秒使用，未配置时回落思考图。
        三者为系统演出态，不属于词表，且只作用于桌面端（剧情窗不参与观察图）。释义可选：不填时 prompt 只注入状态词本身。
      </p>

      {/* 底部：默认状态 + 保存 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-muted">
          共 {sprite.images.length} 张图 · {entries.length} 个状态词
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">默认状态</span>
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

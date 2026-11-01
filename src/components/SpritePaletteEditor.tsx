/**
 * 状态演出编辑器（立绘集用，状态配置唯一入口）。
 *
 * 核心约定：**一个编号 = 一条标签 = 一张图**。
 *
 * - 标签是**一个整体**，可以含「，」分隔的多段同义描述（`害羞，心动，脸红`），
 *   它是一个字符串、一个编号，不是三个独立状态——prompt 里也只占一行；
 * - 所以每张图只有一个输入框：清空即表示这张图不参与状态演出（不占编号）；
 * - 编号按**图片列表顺序**生成（跳过没有标签的图），与左侧网格的阅读顺序一致；
 * - 默认状态作用于**一条标签**（点缩略图右上角星标），不是词表里的某个"词"；
 * - 说话/思考/观察图是系统演出态，不进词表、不占编号，单独一栏配置；
 * - 视觉打标一次为每张图生成 2~4 个词，直接拼成一条标签写入草稿（保存才生效）。
 */
import { useEffect, useMemo, useState } from 'react'
import { ImageOff, Loader2, Sparkles, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../api'
import { normalizeLabel, type CharacterSprite, type SpritePaletteEntry } from '../types'
import { Button, Switch } from './ui'
import { cn } from '../lib/utils'

export function SpritePaletteEditor({ sprite, onSaved, onEntriesChange, onDirtyChange }: {
  sprite: CharacterSprite
  /** 保存成功后回调（父级刷新立绘集列表） */
  onSaved: () => void
  /** 标签数量变化回调（弹窗标题实时同步，增删即更新） */
  onEntriesChange?: (count: number) => void
  /** 草稿脏标记回调：父级据此决定关闭时是否需要"放弃未保存修改"确认 */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [entries, setEntries] = useState<SpritePaletteEntry[]>([])
  /** 默认状态 = 哪一张图（文件名），不是标签文字：标签可能重复，图不会 */
  const [defaultImage, setDefaultImage] = useState('')
  const [speakingImage, setSpeakingImage] = useState('')
  const [thinkingImage, setThinkingImage] = useState('')
  const [observingImage, setObservingImage] = useState('')
  const [annotating, setAnnotating] = useState(false)
  /** 仅补未标注：跳过已有状态词的图（打标通常只补缺口，没必要重跑已配好的图） */
  const [onlyUnlabelled, setOnlyUnlabelled] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 当前选中的缩略图（右区大图预览与标签编辑的作用对象；默认第一张） */
  const [selectedImage, setSelectedImage] = useState('')
  /**
   * 保存成功后的"基线覆盖"：父级刷新 props 是异步的（要重读列表），
   * 这段空窗里草稿与旧 props 不同，若不覆盖会被误判成未保存 → 点 ✕ 白问一次。
   */
  const [savedSigOverride, setSavedSigOverride] = useState<string | null>(null)

  // 打开/切换立绘集时从当前配置初始化草稿
  useEffect(() => {
    setEntries(sprite.emotions.map((e) => ({ ...e })))
    setDefaultImage(sprite.defaultImage || sprite.emotions[0]?.image || '')
    setSpeakingImage(sprite.speakingImage ?? '')
    setThinkingImage(sprite.thinkingImage ?? '')
    setObservingImage(sprite.observingImage ?? '')
    setSelectedImage(sprite.images[0]?.filePath ?? '')
    setSavedSigOverride(null)
  }, [sprite.id, sprite.emotions, sprite.defaultImage, sprite.speakingImage, sprite.thinkingImage, sprite.observingImage])

  useEffect(() => {
    onEntriesChange?.(entries.length)
  }, [entries.length, onEntriesChange])

  /**
   * 草稿签名：与"已保存值"用**同一个函数**归一化后比较，避免因排序/分隔符差异误判为脏。
   * 只有真正会落盘的四类字段进签名：标签（图 → 标签）、默认状态、说话/思考/观察图。
   */
  const signature = (
    list: SpritePaletteEntry[],
    def: string,
    speaking: string,
    thinking: string,
    observing: string,
  ) => {
    // def 是图片文件名，不需要归一化
    const byImage = new Map(list.map((e) => [e.image, e]))
    const labels = sprite.images
      .map((img) => {
        const name = normalizeLabel(byImage.get(img.filePath)?.name ?? '')
        return name ? `${img.filePath}|${name}` : ''
      })
      .filter(Boolean)
    return JSON.stringify({ labels, def, speaking, thinking, observing })
  }

  const draftSig = signature(entries, defaultImage, speakingImage, thinkingImage, observingImage)
  const savedSig = signature(
    sprite.emotions,
    sprite.defaultImage ?? '',
    sprite.speakingImage ?? '',
    sprite.thinkingImage ?? '',
    sprite.observingImage ?? '',
  )
  const dirty = draftSig !== (savedSigOverride ?? savedSig)
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  /** 立绘图预览 URL（pet-res:// 协议，设置窗可直接访问） */
  const imageUrl = useMemo(
    () => (file: string) => (file ? api.pet.spriteUrl(sprite.id, file) : ''),
    [sprite.id],
  )

  /**
   * 按图片顺序排列的条目：**数组下标即编号**（保存时后端也按这个顺序落盘）。
   * 对外一律用归一化后的标签——输入框里允许存在半成品（"害羞，"），编号与校验只看成品。
   */
  const ordered = useMemo(() => {
    const byImage = new Map(entries.map((e) => [e.image, e]))
    return sprite.images
      .map((img) => byImage.get(img.filePath))
      .map((e) => (e ? { name: normalizeLabel(e.name), image: e.image } : null))
      .filter((e): e is SpritePaletteEntry => !!e && !!e.name)
  }, [entries, sprite.images])

  /** 图 → 编号（没有标签的图不在表内） */
  const numberOf = useMemo(() => {
    const map = new Map<string, number>()
    ordered.forEach((e, i) => map.set(e.image, i + 1))
    return map
  }, [ordered])

  const labelOf = (image: string) => entries.find((e) => e.image === image)?.name ?? ''

  /**
   * 写入某张图的标签：清空即删除该图的状态（图仍在，只是不占编号）。
   * 这里刻意**不做逐字归一化**——否则用户敲下「，」的瞬间就被吃掉，永远打不出第二个词；
   * 归一化放在失焦（commitLabel）与保存（后端）两处。
   */
  const setLabel = (image: string, text: string) => {
    setEntries((prev) => {
      const rest = prev.filter((e) => e.image !== image)
      return text.trim() ? [...rest, { name: text, image }] : rest
    })
  }

  /** 失焦整理：去掉多余分隔符与空白（输入过程中的半成品在这里收口） */
  const commitLabel = (image: string) => {
    const raw = labelOf(image)
    const name = normalizeLabel(raw)
    if (name === raw) return
    setEntries((prev) => {
      const rest = prev.filter((e) => e.image !== image)
      return name ? [...rest, { name, image }] : rest
    })
  }

  /** 设为默认状态（点星标）：记住的是**这张图**，与标签文字无关 */
  const setDefaultFromImage = (image: string) => {
    if (!normalizeLabel(labelOf(image))) {
      toast.error('这张图还没有状态词，先填写再设为默认')
      return
    }
    setDefaultImage(image)
  }

  /** 视觉打标：按图回填标签（已有标签的图不覆盖，保护手动配置） */
  const runAnnotate = async () => {
    if (annotating) return
    setAnnotating(true)
    try {
      // 已有状态词的图直接跳过（用当前草稿判断，未保存的改动也算数）
      const skipImages = onlyUnlabelled ? ordered.map((e) => e.image) : []
      const res = await api.sprite.annotate(sprite.id, skipImages.length > 0 ? { skipImages } : undefined)
      if (!res.ok) {
        toast.error(res.error ?? '打标失败')
        return
      }
      if (!res.suggestions || res.suggestions.length === 0) {
        toast.success(`没有需要补标的图片（跳过 ${res.skipped ?? 0} 张已有状态词）`)
        return
      }
      // 合并到草稿：同一标签只允许出现在一张图上（编号靠文字区分，重复就没法选）
      const next = [...entries]
      const suggestions = res.suggestions ?? []
      const usedLabels = new Set(next.map((e) => normalizeLabel(e.name)).filter(Boolean))
      let added = 0
      let collided = 0
      for (const s of suggestions) {
        const label = normalizeLabel(s.name)
        if (!label) continue
        if (usedLabels.has(label)) {
          collided++
          continue
        }
        const idx = next.findIndex((e) => e.image === s.filePath)
        if (idx >= 0 && normalizeLabel(next[idx]?.name ?? '')) {
          // 该图已有标签：保留用户配置
          collided++
          continue
        }
        usedLabels.add(label)
        if (idx >= 0) next[idx] = { name: label, image: s.filePath }
        else next.push({ name: label, image: s.filePath })
        added++
      }
      setEntries(next)
      // 还没有默认图时，把第一条建议的图设为默认
      setDefaultImage((d) => d || suggestions[0]?.filePath || '')
      const skipped = res.skipped ?? 0
      const dup = (res.duplicated ?? 0) + collided
      toast.success(
        `打标完成：新增 ${added} 条标签（失败 ${res.failed ?? 0} 张${skipped > 0 ? `，跳过 ${skipped} 张已有` : ''}${dup > 0 ? `，${dup} 张标签重复已留空` : ''}）；确认后点"保存词表"生效`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打标失败')
    } finally {
      setAnnotating(false)
    }
  }

  /**
   * 保存前校验：只有**整条标签完全相同**才算重复。
   * 部分重合（`疲惫，流口水` 与 `疲惫，在打瞌睡`）是合法的——同一情绪可以有不同表现的图，
   * AI 输出的是编号，不会因为文字相近而混淆；裸词兜底解析命中靠前那张，误差可接受。
   */
  const validate = (): string | null => {
    const seen = new Map<string, number>()
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i]!
      const name = e.name.trim()
      if (!name) return '状态词不能为空'
      const prev = seen.get(name)
      if (prev !== undefined) return `编号 ${i + 1} 与编号 ${prev + 1} 的标签相同：「${name}」`
      seen.set(name, i)
    }
    const dupImage = new Set<string>()
    for (const e of entries) {
      if (dupImage.has(e.image)) return '同一张图只能有一条状态标签'
      dupImage.add(e.image)
    }
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
      // 词表为空 = 未打标（运行时按内置最小词表"平静"处理）；顺序即编号，直接按图片顺序提交
      const cleaned = ordered.map((e) => ({ name: e.name.trim(), image: e.image }))
      // 默认图必须仍然有标签：被清空/删掉时落到第一条，避免存出无效默认
      const defImage = cleaned.some((e) => e.image === defaultImage) ? defaultImage : (cleaned[0]?.image ?? '')
      await api.sprite.update(sprite.id, {
        emotions: cleaned,
        defaultImage: defImage,
        speakingImage: speakingImage || null,
        thinkingImage: thinkingImage || null,
        observingImage: observingImage || null,
      })
      // 父级刷新是异步的：先把"刚保存的草稿"设为基线，避免空窗期误判为脏
      setSavedSigOverride(draftSig)
      toast.success('状态词表已保存')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const current = labelOf(selectedImage)
  const currentLabel = normalizeLabel(current)
  const currentNumber = numberOf.get(selectedImage)

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
          一个编号对应一张图：编号由 AI 输出，用它决定显示哪张立绘。同一张图可以填多个词（用「，」分隔），它们是一个整体、
          共用一个编号。没有填词（或没配状态图）的图不占编号，属于未使用资源。
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Switch checked={onlyUnlabelled} onChange={setOnlyUnlabelled} label="仅补未标注" />
          <Button
            variant="outline"
            size="sm"
            className="whitespace-nowrap"
            onClick={() => void runAnnotate()}
            disabled={annotating}
          >
            {annotating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {annotating ? '打标中…' : '视觉打标'}
          </Button>
        </div>
      </div>

      {/* 上区：左缩略图网格 + 右大图预览/标签编辑 */}
      <div className="flex items-stretch gap-3">
        {/* 左：缩略图网格（角标 = AI 看到的编号） */}
        <div className="min-w-0 flex-1">
          <div className="grid max-h-[530px] grid-cols-3 gap-1.5 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-bg-panel p-1.5 pr-1">
            {sprite.images.map((img) => {
              const num = numberOf.get(img.filePath)
              const label = normalizeLabel(labelOf(img.filePath))
              const isDefault = !!label && img.filePath === defaultImage
              const isSpeaking = speakingImage === img.filePath
              const isThinking = thinkingImage === img.filePath
              const isObserving = observingImage === img.filePath
              return (
                <div
                  key={img.filePath}
                  onClick={() => setSelectedImage(img.filePath)}
                  className={cn(
                    'flex cursor-pointer flex-col overflow-hidden rounded border transition-all',
                    selectedImage === img.filePath
                      ? 'border-[var(--primary-400)] ring-1 ring-[var(--primary-400)]'
                      : 'border-border hover:border-[var(--border-strong)]',
                  )}
                  title={img.filePath}
                >
                  <span className="relative flex h-[104px] items-center justify-center bg-surface-2">
                    <img src={imageUrl(img.filePath)} alt={img.filePath} className="h-full w-full object-contain" />
                    {/* 编号角标：有标签才有编号 */}
                    {num !== undefined ? (
                      <span className="absolute left-1 top-1 rounded bg-black/65 px-1 text-[10px] font-medium leading-4 text-white">
                        {num}
                      </span>
                    ) : (
                      <span className="absolute left-1 top-1 rounded bg-black/45 px-1 text-[10px] leading-4 text-white/70">
                        未使用
                      </span>
                    )}
                    {isDefault && (
                      <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1 text-[10px] leading-4 text-white">
                        默认
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'block truncate px-0.5 text-center text-[10px] leading-5',
                      num !== undefined || isSpeaking || isThinking || isObserving ? 'text-[var(--primary-400)]' : 'text-text-muted',
                    )}
                  >
                    {label || '无状态词'}
                    {isSpeaking && <span className="text-amber-400"> · 说话</span>}
                    {isThinking && <span className="text-violet-400"> · 思考</span>}
                    {/* 观察用绿色：原来 sky-400 与主色青（#00d4ff）几乎同色，混在标签里看不出区别 */}
                    {isObserving && <span className="text-emerald-400"> · 观察</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* 右：大图预览 + 该图标签 + 系统态设置 */}
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

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted">
                {currentNumber !== undefined ? `编号 ${currentNumber} · 状态词` : '状态词（该图未使用）'}
              </span>
              <button
                onClick={() => setDefaultFromImage(selectedImage)}
                disabled={!currentLabel}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-card-hover disabled:opacity-40',
                  currentLabel && selectedImage === defaultImage ? 'text-amber-400' : 'text-text-muted',
                )}
                title="把这张图的状态设为默认（未命中任何编号时使用）"
              >
                <Star size={11} className={selectedImage === defaultImage ? 'fill-amber-400' : ''} />
                {selectedImage === defaultImage ? '默认状态' : '设为默认'}
              </button>
            </div>
            <input
              value={current}
              onChange={(ev) => setLabel(selectedImage, ev.target.value)}
              onBlur={() => commitLabel(selectedImage)}
              placeholder="如：害羞，心动，脸红（多个词用，分隔，共用一个编号）"
              className="w-full rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1.5 text-xs outline-none focus:border-[var(--border-strong)]"
            />
            <p className="text-[10px] leading-relaxed text-text-muted">
              清空即表示这张图不参与状态演出。多个词表示同一张图的不同说法，AI 看到的是同一行。
            </p>
          </div>

          {/* 说话/思考/观察图：一键作用于当前选中的图 + 缩略预览与清除 */}
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 px-1.5 text-[11px]"
              disabled={!selectedImage}
              onClick={() => setSpeakingImage(selectedImage)}
              title="把选中的立绘图设为说话立绘（状态=默认状态的说话态使用）"
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
            {([
              ['说话图', speakingImage, setSpeakingImage, '清除说话图'],
              ['思考图', thinkingImage, setThinkingImage, '清除思考图'],
              ['观察图', observingImage, setObservingImage, '清除观察图'],
            ] as const).map(([label, value, setter, title]) => (
              <div key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-text-muted">{label}</span>
                {value ? (
                  <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded border border-border">
                    <img src={imageUrl(value)} alt={label} className="h-full w-full object-cover" />
                    <button
                      onClick={() => setter('')}
                      className="absolute inset-y-0 right-0 flex w-3 items-center justify-center bg-black/50 text-white"
                      title={title}
                    >
                      <X size={8} />
                    </button>
                  </span>
                ) : (
                  <span className="text-[11px] text-text-muted">未配置</span>
                )}
              </div>
            ))}
          </div>

          {/* AI 视角预览：真实注入的编号清单，用户可自行核对 */}
          <details className="rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] text-text-muted">AI 视角预览（{ordered.length} 个编号）</summary>
            <ol className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-4 text-text-2">
              {ordered.map((e, i) => (
                <li key={e.image}>
                  {i + 1}. {e.name}
                  {e.image === defaultImage && <span className="text-amber-400">（默认）</span>}
                </li>
              ))}
              {ordered.length === 0 && <li className="text-text-muted">（空：AI 只能选内置的「平静」）</li>}
            </ol>
          </details>
        </div>
      </div>

      <p className="text-[11px] text-text-muted">
        说话图在「正在说话且状态=默认状态」时使用；思考图在 AI 准备回答期间使用；观察图在你点桌宠眼睛、角色看屏幕的那几秒使用，
        未配置时回落思考图。三者为系统演出态，不占编号，且只作用于桌面端（剧情窗不参与观察图）。
      </p>

      {/* 底部：统计 + 保存 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-muted">
          {sprite.images.length} 张图 · {ordered.length} 个编号 · {sprite.images.length - ordered.length} 张未使用
        </span>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存词表'}
        </Button>
      </div>
    </div>
  )
}

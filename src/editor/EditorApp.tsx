/**
 * 剧本可视化编辑器（设计文档 7.6，MVP）：
 *  - 左侧章节列表 + 元信息；右侧章节字段（name/enterWhen/fallbackChapter）+ 事件列表 + 事件表单
 *  - 表单视图 / YAML 视图切换；保存走主进程全量 schema 校验 + 原子写
 *  - 只读保护（定案）：手写剧本（无 editedVia: form 标记）表单禁用，YAML 文本微调始终可用，
 *    「启用表单编辑」确认后允许表单写回（明示注释将丢失）
 *  - MVP 简化：章节顺序 = 文件名字典序（不做章节重排）；事件排序用上移/下移（拖拽为后续增强）；
 *    choices.actions / aiJudge 用 JSON 文本编辑
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, FilePlus2, Save, Trash2 } from 'lucide-react'
import { api } from '../api'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { toast } from 'sonner'
import type { EditorReadResult, StandardEmotion, StoryCondition, StoryEvent } from '../types'
import { EVENT_DESCRIPTORS, STANDARD_EMOTION_OPTIONS, descriptorOf, type FieldDesc } from './eventDescriptors'
import { cn } from '../lib/utils'

/** 编辑器内存态（读入后的一切修改都落在 copy 上，点保存才写盘） */
interface EditorData {
  scriptId: string
  editedVia: boolean
  meta: { title: string; summary: string; startChapter: string; characterCardId: string | null }
  chapters: Array<{ file: string; name: string; enterWhen: StoryCondition | null; fallbackChapter: string | null; events: StoryEvent[] }>
  storyYaml: string
  chapterYamls: Record<string, string>
}

/** 事件类型的默认对象（新增事件 / 切换事件类型共用；与 eventDescriptors/schema 保持同步） */
function eventDefaults(type: string): Record<string, unknown> {
  const base: Record<string, unknown> = { type }
  if (type === 'narration' || type === 'player' || type === 'dialogue') base['text'] = ''
  if (type === 'dialogue') base['emotion'] = 'neutral'
  if (type === 'ai_dialogue') base['prompt'] = ''
  if (type === 'background') base['image'] = ''
  if (type === 'choices') base['options'] = [{ text: '选项一' }, { text: '选项二' }]
  if (type === 'set_var') {
    base['name'] = ''
    base['value'] = ''
  }
  return base
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function EditorApp() {
  const [scriptId, setScriptId] = useState<string | null>(null)
  const [data, setData] = useState<EditorData | null>(null)
  const [errors, setErrors] = useState<Array<{ file: string; message: string }>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<'form' | 'text'>('form')
  const [selChapter, setSelChapter] = useState(0)
  const [selEvent, setSelEvent] = useState<number | null>(null)

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res: EditorReadResult = await api.story.editorRead(id)
      if (!res.ok || !res.meta || !res.chapters) {
        toast.error(res.error ?? '剧本读取失败')
        setErrors(res.errors ?? [])
        setData(null)
        return
      }
      setErrors(res.errors ?? [])
      const chapterYamls: Record<string, string> = {}
      for (const c of res.chapters) chapterYamls[c.file] = c.yaml
      setData({
        scriptId: res.scriptId ?? id,
        editedVia: res.meta.editedVia,
        meta: {
          title: res.meta.title,
          summary: res.meta.summary,
          startChapter: res.meta.startChapter,
          characterCardId: res.meta.characterCardId,
        },
        chapters: res.chapters.map((c) => ({ file: c.file, name: c.name, enterWhen: c.enterWhen, fallbackChapter: c.fallbackChapter, events: c.events })),
        storyYaml: res.storyYaml ?? '',
        chapterYamls,
      })
      setSelChapter(0)
      setSelEvent(null)
      setDirty(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '剧本读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void api.story.editorCurrent().then((id) => load(id))
    return api.story.onEditorReload(() => {
      void api.story.editorCurrent().then((id) => load(id))
    })
  }, [load])

  const mutate = (fn: (d: EditorData) => void) => {
    setData((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
    setDirty(true)
  }

  const save = async () => {
    if (!data || saving) return
    setSaving(true)
    try {
      const payload =
        view === 'form' && (data.editedVia || allowForm)
          ? {
              mode: 'form' as const,
              scriptId: data.scriptId,
              meta: { title: data.meta.title, summary: data.meta.summary, startChapter: data.meta.startChapter, characterCardId: data.meta.characterCardId },
              chapters: data.chapters.map((c) => ({ file: c.file, name: c.name, enterWhen: c.enterWhen, fallbackChapter: c.fallbackChapter, events: c.events })),
            }
          : {
              mode: 'text' as const,
              scriptId: data.scriptId,
              storyYaml: data.storyYaml,
              chapters: data.chapters.map((c) => ({ file: c.file, yaml: data.chapterYamls[c.file] ?? '' })),
            }
      const res = await api.story.editorSave(payload)
      if (res.ok) {
        toast.success('已保存（全量校验通过）')
        await load(data.scriptId)
      } else {
        setErrors(res.errors ?? [])
        toast.error(`保存被拒绝：${res.errors?.[0]?.message ?? res.error ?? '校验未通过'}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const [allowForm, setAllowForm] = useState(false)
  const formEditable = !!data && (data.editedVia || allowForm)
  const chapter = data?.chapters[selChapter] ?? null

  const addChapter = () => {
    if (!data) return
    const n = data.chapters.length + 1
    mutate((d) => {
      d.chapters.push({ file: `ch${String(n).padStart(2, '0')}-${Date.now() % 1000}`, name: `新章节 ${n}`, enterWhen: null, fallbackChapter: null, events: [] })
      d.chapterYamls[d.chapters[d.chapters.length - 1]!.file] = ''
    })
  }

  const removeChapter = (idx: number) => {
    if (!data || data.chapters.length <= 1) {
      toast.error('至少需要保留 1 个章节')
      return
    }
    const file = data.chapters[idx]!.file
    if (data.meta.startChapter === file) {
      toast.error('起始章节不允许删除（可先把起始章节改到其他章节）')
      return
    }
    mutate((d) => {
      d.chapters.splice(idx, 1)
      delete d.chapterYamls[file]
      if (selChapter >= d.chapters.length) setSelChapter(d.chapters.length - 1)
    })
    setSelEvent(null)
  }

  const addEvent = (type: string) => {
    if (!chapter) return
    mutate((d) => {
      d.chapters[selChapter]!.events.push(eventDefaults(type) as StoryEvent)
    })
    setSelEvent((d2) => (d2 === null ? 0 : d2 + 1))
  }

  /** 切换事件类型：以新类型默认对象重建，尽量保留 text（新类型支持时）与 condition */
  const changeEventType = (idx: number, newType: string) => {
    if (!chapter || !newType) return
    mutate((d) => {
      const old = d.chapters[selChapter]!.events[idx] as unknown as Record<string, unknown>
      const next = eventDefaults(newType)
      const hasTextField = descriptorOf(newType)?.fields.some((f) => f.key === 'text')
      if (hasTextField && typeof old['text'] === 'string' && old['text']) next['text'] = old['text']
      if (old['condition'] != null) next['condition'] = old['condition']
      d.chapters[selChapter]!.events[idx] = next as StoryEvent
    })
  }

  const moveEvent = (idx: number, dir: -1 | 1) => {
    if (!chapter) return
    const to = idx + dir
    if (to < 0 || to >= chapter.events.length) return
    mutate((d) => {
      const arr = d.chapters[selChapter]!.events
      const [it] = arr.splice(idx, 1)
      arr.splice(to, 0, it!)
    })
    setSelEvent(to)
  }

  const updateEvent = (idx: number, patch: Partial<StoryEvent>) => {
    mutate((d) => {
      const arr = d.chapters[selChapter]!.events
      arr[idx] = { ...arr[idx]!, ...patch } as StoryEvent
    })
  }

  const conditionText = (c: StoryCondition | null | undefined): string => {
    if (!c) return ''
    if ('var' in c) return 'op' in c && c.op ? `${c.var} ${c.op} ${String(c.value)}` : String(c.var)
    return JSON.stringify(c)
  }
  const parseCondition = (s: string): StoryCondition | null => {
    const t = s.trim()
    if (!t) return null
    if (t.startsWith('{')) {
      try {
        return JSON.parse(t) as StoryCondition
      } catch {
        return null
      }
    }
    return t as unknown as StoryCondition
  }

  const eventSummary = (e: StoryEvent): string => {
    const d = descriptorOf(e.type)
    const anyE = e as Record<string, unknown>
    const detail = typeof anyE['text'] === 'string' ? anyE['text'] : typeof anyE['prompt'] === 'string' ? anyE['prompt'] : typeof anyE['image'] === 'string' ? anyE['image'] : ''
    return `${d?.label ?? e.type}${detail ? `：${String(detail).slice(0, 24)}` : ''}`
  }

  const chapterOptions = useMemo(() => data?.chapters.map((c) => c.file) ?? [], [data])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-base text-text">
      <WindowTitlebar title={`剧本编辑器${data ? ` · ${data.meta.title}` : ''}`} />
      {!data && !loading && (
        <div className="flex flex-1 items-center justify-center text-sm text-text-2">
          未指定剧本。请从「设置 → 剧情系统 → 剧本库」点「编辑」进入。
        </div>
      )}
      {loading && <div className="flex flex-1 items-center justify-center text-sm text-text-2">加载中…</div>}
      {data && (
        <>
          {/* 工具栏 */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${formEditable ? 'bg-primary-500/15 text-primary-400' : 'bg-amber-500/15 text-amber-500'}`}>
              {formEditable ? '表单可编辑' : '手写剧本 · 表单只读'}
            </span>
            {dirty && <span className="text-[11px] text-amber-500">未保存</span>}
            <div className="ml-auto flex items-center gap-2">
              {!formEditable && (
                <button
                  onClick={() => {
                    if (window.confirm('启用表单编辑后，保存将以表单内容生成标准 YAML 覆盖剧本文件，手写注释将丢失。确定继续？')) {
                      setAllowForm(true)
                      setView('form')
                    }
                  }}
                  className="rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs text-text-2 hover:bg-card-hover hover:text-text"
                >
                  启用表单编辑（注释将丢失）
                </button>
              )}
              <button
                onClick={() => setView(view === 'form' ? 'text' : 'form')}
                className="rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs text-text-2 hover:bg-card-hover hover:text-text"
              >
                {view === 'form' ? '切到 YAML 视图' : '切到表单视图'}
              </button>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-brand-gradient px-3 py-1 text-xs font-medium text-[var(--on-brand)] disabled:opacity-50"
              >
                <Save size={13} /> {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>

          {errors.length > 0 && (
            <div className="max-h-24 overflow-y-auto border-b border-border bg-red-500/10 px-4 py-1.5 text-[11px] text-red-400">
              {errors.map((e, i) => (
                <div key={i}>[{e.file}] {e.message}</div>
              ))}
            </div>
          )}

          {view === 'text' ? (
            /* ---- YAML 文本视图（始终可用；注释保留） ---- */
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
              <div>
                <p className="mb-1 text-xs font-semibold text-text-2">story.yaml</p>
                <textarea
                  value={data.storyYaml}
                  onChange={(e) => mutate((d) => { d.storyYaml = e.target.value })}
                  rows={8}
                  className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel p-2 font-mono text-xs outline-none"
                />
              </div>
              {data.chapters.map((c, i) => (
                <div key={c.file}>
                  <p className="mb-1 text-xs font-semibold text-text-2">chapters/{c.file}.yaml</p>
                  <textarea
                    value={data.chapterYamls[c.file] ?? ''}
                    onChange={(e) => mutate((d) => { d.chapterYamls[c.file] = e.target.value })}
                    rows={10}
                    className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel p-2 font-mono text-xs outline-none"
                  />
                  {i === selChapter && <span className="text-[10px] text-text-2">（当前选中章节）</span>}
                </div>
              ))}
            </div>
          ) : (
            /* ---- 表单视图 ---- */
            <div className="flex min-h-0 flex-1">
              {/* 左：章节 + 元信息 */}
              <div className="flex w-64 shrink-0 flex-col border-r border-border">
                <div className="space-y-2 border-b border-border p-3">
                  <input value={data.meta.title} onChange={(e) => mutate((d) => { d.meta.title = e.target.value })} placeholder="剧本标题" className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-sm outline-none" />
                  <textarea value={data.meta.summary} onChange={(e) => mutate((d) => { d.meta.summary = e.target.value })} placeholder="剧情简介（会显示在剧本库卡片上）" rows={3} className="w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1.5 text-xs leading-relaxed outline-none" />
                  <label className="block text-[10px] text-text-2">
                    起始章节
                    <select value={data.meta.startChapter} onChange={(e) => mutate((d) => { d.meta.startChapter = e.target.value })} className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-1 py-1 text-xs outline-none">
                      {data.chapters.map((c) => <option key={c.file} value={c.file}>{c.file}</option>)}
                    </select>
                  </label>
                </div>
                <div className="flex items-center justify-between px-3 py-1.5 text-xs font-semibold text-text-2">
                  <span>章节（顺序=文件名）</span>
                  <button onClick={addChapter} disabled={!formEditable} className="p-1 hover:text-text disabled:opacity-40" title="新增章节">
                    <FilePlus2 size={14} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  {data.chapters.map((c, i) => (
                    <button
                      key={c.file}
                      onClick={() => { setSelChapter(i); setSelEvent(null) }}
                      className={`mb-1 block w-full rounded-[var(--radius-md)] px-2 py-1.5 text-left text-xs transition-colors ${i === selChapter ? 'bg-primary-500/15 text-primary-400' : 'hover:bg-card-hover'}`}
                    >
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-[10px] text-text-2">
                        {c.file}{data.meta.startChapter === c.file ? ' · 起始' : ''} · {c.events.length} 事件
                      </span>
                    </button>
                  ))}
                </div>
                {chapter && (
                  <button onClick={() => removeChapter(selChapter)} disabled={!formEditable} className="m-2 flex items-center justify-center gap-1 rounded-[var(--radius-md)] border border-border px-2 py-1 text-[11px] text-text-2 hover:border-red-500/40 hover:text-red-400 disabled:opacity-40">
                    <Trash2 size={12} /> 删除当前章节
                  </button>
                )}
              </div>

              {/* 右：章节字段 + 事件列表 + 事件表单 */}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {!chapter ? (
                  <p className="text-sm text-text-2">选择一个章节</p>
                ) : (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-3">
                      <label className="block text-[10px] text-text-2">
                        章节名
                        <input value={chapter.name} onChange={(e) => mutate((d) => { d.chapters[selChapter]!.name = e.target.value })} className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-sm outline-none" />
                      </label>
                      <label className="block text-[10px] text-text-2">
                        章节文件名（顺序键）
                        <input value={chapter.file} onChange={(e) => mutate((d) => {
                          const nv = e.target.value
                          const old = d.chapters[selChapter]!.file
                          d.chapters[selChapter]!.file = nv
                          d.chapterYamls[nv] = d.chapterYamls[old] ?? ''
                          delete d.chapterYamls[old]
                          if (d.meta.startChapter === old) d.meta.startChapter = nv
                        })} className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 font-mono text-xs outline-none" />
                      </label>
                      <label className="block text-[10px] text-text-2">
                        进入条件 enterWhen（字符串如 closeness &gt;= 2；空 = 无条件）
                        <input
                          value={conditionText(chapter.enterWhen)}
                          onChange={(e) => mutate((d) => { d.chapters[selChapter]!.enterWhen = parseCondition(e.target.value) })}
                          className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 font-mono text-xs outline-none"
                        />
                      </label>
                      <label className="block text-[10px] text-text-2">
                        备选章节 fallbackChapter（enterWhen 不满足时进入）
                        <select value={chapter.fallbackChapter ?? ''} onChange={(e) => mutate((d) => { d.chapters[selChapter]!.fallbackChapter = e.target.value || null })} className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-1 py-1 text-xs outline-none">
                          <option value="">（无，直接跳过本章）</option>
                          {chapterOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold text-text-2">事件（{chapter.events.length}）</span>
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) addEvent(e.target.value) }}
                        disabled={!formEditable}
                        className="rounded-[var(--radius-md)] border border-border bg-bg-panel px-1 py-1 text-xs outline-none"
                      >
                        <option value="">+ 添加事件…</option>
                        {EVENT_DESCRIPTORS.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
                      </select>
                    </div>

                    <div className="mb-3 space-y-1">
                      {chapter.events.map((ev, i) => (
                        <div key={i} className={`flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-xs ${i === selEvent ? 'bg-primary-500/15' : 'hover:bg-card-hover'}`}>
                          <button onClick={() => setSelEvent(i)} className="min-w-0 flex-1 truncate text-left">
                            <span className="font-medium">#{i + 1} {eventSummary(ev)}</span>
                            {ev.condition && <span className="ml-1 text-[10px] text-text-2">[条件]</span>}
                          </button>
                          <button onClick={() => moveEvent(i, -1)} disabled={i === 0 || !formEditable} className="p-0.5 text-text-2 hover:text-text disabled:opacity-30"><ChevronUp size={13} /></button>
                          <button onClick={() => moveEvent(i, 1)} disabled={i === chapter.events.length - 1 || !formEditable} className="p-0.5 text-text-2 hover:text-text disabled:opacity-30"><ChevronDown size={13} /></button>
                          <button onClick={() => mutate((d) => { d.chapters[selChapter]!.events.splice(i + 1, 0, clone(d.chapters[selChapter]!.events[i]!)) })} disabled={!formEditable} className="p-0.5 text-text-2 hover:text-text disabled:opacity-30"><Copy size={13} /></button>
                          <button onClick={() => { mutate((d) => { d.chapters[selChapter]!.events.splice(i, 1) }); setSelEvent(null) }} disabled={!formEditable} className="p-0.5 text-text-2 hover:text-red-400 disabled:opacity-30"><Trash2 size={13} /></button>
                        </div>
                      ))}
                    </div>

                    {selEvent !== null && chapter.events[selEvent] && (
                      <EventForm
                        key={`${selChapter}-${selEvent}`}
                        event={chapter.events[selEvent]!}
                        chapterOptions={chapterOptions}
                        editable={formEditable}
                        onChange={(patch) => updateEvent(selEvent, patch)}
                        onTypeChange={(newType) => changeEventType(selEvent, newType)}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 事件表单：顶部类型切换 + 通用字段按描述表渲染；choices/chapter_end/set_var 有专用编辑区；condition 通用 */
function EventForm({ event, chapterOptions, editable, onChange, onTypeChange }: {
  event: StoryEvent
  chapterOptions: string[]
  editable: boolean
  onChange: (patch: Partial<StoryEvent>) => void
  onTypeChange: (newType: string) => void
}) {
  const desc = descriptorOf(event.type)
  const anyE = event as Record<string, unknown>
  const condText = conditionToText(anyE['condition'])
  const options = Array.isArray(anyE['options']) ? (anyE['options'] as Array<Record<string, unknown>>) : []
  const setOptions = (next: Array<Record<string, unknown>>) => onChange({ options: next } as unknown as Partial<StoryEvent>)
  const setOption = (i: number, next: Record<string, unknown>) => setOptions(options.map((x, j) => (j === i ? next : x)))
  const [expandedOpt, setExpandedOpt] = useState<number | null>(null)
  return (
    <div className="rounded-[var(--radius-lg)] border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold">{desc?.label ?? event.type} 表单</span>
        {/* 事件类型切换：以新类型默认对象重建（尽量保留 text 与 condition） */}
        <select
          value={event.type}
          onChange={(e) => onTypeChange(e.target.value)}
          disabled={!editable}
          title="切换事件类型（保留文本与条件）"
          className="ml-auto rounded-[var(--radius-md)] border border-border bg-bg-panel px-1.5 py-0.5 text-xs outline-none"
        >
          {EVENT_DESCRIPTORS.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
        </select>
        <span className="font-mono text-[10px] text-text-2">#{event.type}</span>
      </div>
      <div className="space-y-2.5">
        {desc?.fields.map((f) => (
          <FieldInput key={f.key} field={f} value={anyE[f.key]} editable={editable} onChange={(v) => onChange({ [f.key]: v } as Partial<StoryEvent>)} />
        ))}

        {/* set_var：value 类型自由（数字/字符串/布尔）+ 运算符 */}
        {event.type === 'set_var' && (
          <label className="block text-[10px] text-text-2">
            运算符
            <select value={String(anyE['op'] ?? '=')} onChange={(e) => onChange({ op: e.target.value as '=' | '+=' | '-=' })} className="mt-0.5 block w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-sm outline-none">
              <option value="=">=（赋值）</option>
              <option value="+=">+=（增加）</option>
              <option value="-=">-=（减少）</option>
            </select>
          </label>
        )}

        {/* choices：选项列表 + 每选项的 actions（设置变量）编辑 */}
        {event.type === 'choices' && (
          <div>
            <p className="mb-1 text-[10px] text-text-2">选项列表（点「动作」展开该选项的效果设置，如好感度加减）</p>
            <div className="space-y-1.5">
              {options.map((o, i) => {
                const actions = Array.isArray(o['actions']) ? (o['actions'] as Array<Record<string, unknown>>) : []
                return (
                  <div key={i} className="rounded-[var(--radius-md)] border border-border/60 p-1.5">
                    <div className="flex items-center gap-1.5">
                      <input
                        value={String(o['text'] ?? '')}
                        onChange={(e) => setOption(i, { ...o, text: e.target.value })}
                        disabled={!editable}
                        className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none focus:border-border"
                      />
                      <button
                        onClick={() => setExpandedOpt(expandedOpt === i ? null : i)}
                        disabled={!editable}
                        title="编辑该选项的效果动作（设置变量等）"
                        className={cn(
                          'shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] transition-colors',
                          actions.length > 0 ? 'bg-primary-500/15 text-primary-400' : 'text-text-2 hover:bg-card-hover hover:text-text',
                        )}
                      >
                        动作 {actions.length > 0 ? actions.length : ''}
                      </button>
                      <button
                        onClick={() => setOptions(options.filter((_, j) => j !== i))}
                        disabled={!editable || options.length <= 1}
                        className="shrink-0 p-1 text-text-2 hover:text-red-400 disabled:opacity-30"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {expandedOpt === i && (
                      <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
                        {actions.map((a, ai) => (
                          a['type'] === 'set_var' ? (
                            <div key={ai} className="flex items-center gap-1 text-[10px] text-text-2">
                              <span className="shrink-0">设置变量</span>
                              <input
                                value={String(a['name'] ?? '')}
                                onChange={(e) => setOption(i, { ...o, actions: actions.map((x, j) => (j === ai ? { ...x, name: e.target.value } : x)) })}
                                disabled={!editable}
                                placeholder="变量名"
                                className="w-24 rounded-[var(--radius-sm)] border border-border bg-bg-panel px-1 py-0.5 font-mono outline-none"
                              />
                              <select
                                value={String(a['op'] ?? '+=')}
                                onChange={(e) => setOption(i, { ...o, actions: actions.map((x, j) => (j === ai ? { ...x, op: e.target.value } : x)) })}
                                disabled={!editable}
                                className="rounded-[var(--radius-sm)] border border-border bg-bg-panel px-0.5 py-0.5 font-mono outline-none"
                              >
                                <option value="=">=</option>
                                <option value="+=">+=</option>
                                <option value="-=">-=</option>
                              </select>
                              <input
                                value={String(a['value'] ?? '')}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  const num = Number(raw)
                                  const v = raw !== '' && !Number.isNaN(num) ? num : raw
                                  setOption(i, { ...o, actions: actions.map((x, j) => (j === ai ? { ...x, value: v } : x)) })
                                }}
                                disabled={!editable}
                                className="w-16 rounded-[var(--radius-sm)] border border-border bg-bg-panel px-1 py-0.5 font-mono outline-none"
                              />
                              <button
                                onClick={() => setOption(i, { ...o, actions: actions.filter((_, j) => j !== ai) })}
                                disabled={!editable}
                                className="p-0.5 text-text-2 hover:text-red-400 disabled:opacity-30"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ) : (
                            <div key={ai} className="flex items-center gap-1">
                              <code className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-bg-panel px-1 py-0.5 font-mono text-[10px] text-text-2">
                                {JSON.stringify(a)}
                              </code>
                              <button
                                onClick={() => setOption(i, { ...o, actions: actions.filter((_, j) => j !== ai) })}
                                disabled={!editable}
                                className="p-0.5 text-text-2 hover:text-red-400 disabled:opacity-30"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          )
                        ))}
                        <button
                          onClick={() => setOption(i, { ...o, actions: [...actions, { type: 'set_var', name: '', op: '+=', value: 1 }] })}
                          disabled={!editable}
                          className="text-[11px] text-primary-400 hover:underline disabled:opacity-40"
                        >
                          + 添加动作（设置变量）
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
              <button
                onClick={() => setOptions([...options, { text: '' }])}
                disabled={!editable}
                className="text-[11px] text-primary-400 hover:underline disabled:opacity-40"
              >
                + 添加选项
              </button>
            </div>
            <label className="mt-2 flex items-center gap-1.5 text-[10px] text-text-2">
              <input type="checkbox" checked={anyE['allowFree'] === true} onChange={(e) => onChange({ allowFree: e.target.checked } as unknown as Partial<StoryEvent>)} disabled={!editable} />
              允许自由输入
            </label>
          </div>
        )}

        {/* chapter_end：nextChapter + branches + aiJudge */}
        {event.type === 'chapter_end' && (
          <div className="space-y-2.5">
            <label className="block text-[10px] text-text-2">
              缺省下一章（所有分支都不满足时；空 = 完结）
              <select value={String(anyE['nextChapter'] ?? '')} onChange={(e) => onChange({ nextChapter: e.target.value || undefined } as unknown as Partial<StoryEvent>)} className="mt-0.5 block w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-sm outline-none">
                <option value="">（完结）</option>
                {chapterOptions.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <div>
              <p className="mb-1 text-[10px] text-text-2">静态分支（按序首个 when 满足者生效）</p>
              {Array.isArray(anyE['branches']) && (anyE['branches'] as Array<Record<string, unknown>>).map((b, i, arr) => (
                <div key={i} className="mb-1 flex items-center gap-1.5">
                  <input
                    value={conditionToText(b['when'])}
                    placeholder="条件，如 closeness >= 2"
                    onChange={(e) => {
                      const when = e.target.value.trim() || true
                      const next = arr.map((x, j) => (j === i ? { ...x, when } : x))
                      onChange({ branches: next } as unknown as Partial<StoryEvent>)
                    }}
                    disabled={!editable}
                    className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 font-mono text-xs outline-none"
                  />
                  <select
                    value={String(b['nextChapter'] ?? '')}
                    onChange={(e) => {
                      const next = arr.map((x, j) => (j === i ? { ...x, nextChapter: e.target.value } : x))
                      onChange({ branches: next } as unknown as Partial<StoryEvent>)
                    }}
                    disabled={!editable}
                    className="rounded-[var(--radius-md)] border border-border bg-bg-panel px-1 py-1 text-xs outline-none"
                  >
                    {chapterOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <button
                    onClick={() => onChange({ branches: arr.filter((_, j) => j !== i) } as unknown as Partial<StoryEvent>)}
                    disabled={!editable}
                    className="p-1 text-text-2 hover:text-red-400 disabled:opacity-30"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => onChange({ branches: [...(Array.isArray(anyE['branches']) ? (anyE['branches'] as Array<Record<string, unknown>>) : []), { when: true, nextChapter: chapterOptions[0] ?? '' }] } as unknown as Partial<StoryEvent>)}
                disabled={!editable}
                className="text-[11px] text-primary-400 hover:underline disabled:opacity-40"
              >
                + 添加分支
              </button>
            </div>
            <div>
              <p className="mb-1 text-[10px] text-text-2">AI 判定 aiJudge（JSON；prompt/varName/options[].id·label·nextChapter）</p>
              <textarea
                value={anyE['aiJudge'] ? JSON.stringify(anyE['aiJudge'], null, 2) : ''}
                onChange={(e) => {
                  try {
                    const v = e.target.value.trim() ? JSON.parse(e.target.value) : undefined
                    onChange({ aiJudge: v } as unknown as Partial<StoryEvent>)
                  } catch {
                    /* 输入中的非法 JSON：不写回，等合法再提交 */
                  }
                }}
                rows={4}
                disabled={!editable}
                className="w-full rounded-[var(--radius-md)] border border-border bg-bg-panel p-2 font-mono text-xs outline-none"
              />
            </div>
          </div>
        )}

        {/* 通用 condition */}
        <label className="block text-[10px] text-text-2">
          演出条件 condition（不满足则跳过本事件；空 = 无条件）
          <input
            value={condText}
            onChange={(e) => {
              const t = e.target.value.trim()
              onChange({ condition: t ? (parseConditionText(t) as unknown as StoryCondition) : undefined } as unknown as Partial<StoryEvent>)
            }}
            disabled={!editable}
            placeholder="如 closeness >= 2 && metBefore"
            className="mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 font-mono text-xs outline-none"
          />
        </label>
      </div>
    </div>
  )
}

function FieldInput({ field, value, editable, onChange }: { field: FieldDesc; value: unknown; editable: boolean; onChange: (v: unknown) => void }) {
  const cls = 'mt-0.5 w-full rounded-[var(--radius-md)] border border-border bg-bg-panel px-2 py-1 text-sm outline-none'
  if (field.kind === 'boolean') {
    return (
      <label className="flex items-center gap-1.5 text-[10px] text-text-2">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} disabled={!editable} />
        {field.label}
      </label>
    )
  }
  if (field.kind === 'emotion') {
    return (
      <label className="block text-[10px] text-text-2">
        {field.label}
        <select value={String(value ?? 'neutral')} onChange={(e) => onChange(e.target.value as StandardEmotion)} disabled={!editable} className={cls}>
          {STANDARD_EMOTION_OPTIONS.map((em) => <option key={em} value={em}>{em}</option>)}
        </select>
      </label>
    )
  }
  if (field.kind === 'text') {
    return (
      <label className="block text-[10px] text-text-2">
        {field.label}{field.required && ' *'}
        <textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={2} disabled={!editable} placeholder={field.placeholder} className={`${cls} resize-none`} />
      </label>
    )
  }
  if (field.kind === 'number') {
    return (
      <label className="block text-[10px] text-text-2">
        {field.label}
        <input type="number" value={value === undefined || value === null || value === '' ? '' : Number(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} disabled={!editable} className={cls} />
      </label>
    )
  }
  return (
    <label className="block text-[10px] text-text-2">
      {field.label}{field.required && ' *'}
      <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={!editable} placeholder={field.placeholder} className={cls} />
    </label>
  )
}

/** 条件 ↔ 文本互转：子句走 "var op value" 字符串写法；组合对象走 JSON（提示高级用法） */
function conditionToText(c: unknown): string {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (typeof c === 'boolean') return String(c)
  const o = c as Record<string, unknown>
  if (typeof o['var'] === 'string') return 'op' in o && o['op'] ? `${o['var']} ${String(o['op'])} ${JSON.stringify(o['value'] ?? '')}` : String(o['var'])
  try {
    return JSON.stringify(c)
  } catch {
    return ''
  }
}

function parseConditionText(t: string): unknown {
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t)
    } catch {
      return t
    }
  }
  return t
}

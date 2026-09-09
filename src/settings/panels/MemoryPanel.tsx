/**
 * 记忆体面板：按角色隔离 + 分主题（用户信息/长期经历/约定承诺）+ 待确认候选审核。
 * - 已确认记忆：注入 system prompt（当前角色 + 全局背景），可新增/编辑/删除
 * - 待确认候选：会话自动沉淀产物，保留后入已确认（注入生效），删除则丢弃
 * - 新增区的分类/归属下拉同时充当列表筛选（选择后即时过滤已确认记忆）
 *
 * 手动添加的轻量引导：
 * - 最小有效长度：过短的语气词/标签（如「对方是用户酱」）不构成长期记忆，提交时拦截
 * - 去重：与已确认记忆完全相同或互相包含时列出重复项，提交时硬拦截
 * - 可疑标签词（用户/角色/AI）：输入时黄色弱提示，引导改用标准人称「对方/你」，不强制拦截。
 *   注意「对方」「你」是合法人称（自动沉淀记忆即用这套），不在警告范围内。
 */
import { useEffect, useState } from 'react'
import { BrainCircuit, Check, Clock, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useMemoryStore } from '../../store/memoryStore'
import { useCharacterStore } from '../../store/characterStore'
import { useSettingsStore } from '../../store/settingsStore'
import { Button, Card, Empty, Input, Loading, Select, Switch } from '../../components/ui'
import { toast } from '../../components/toast'
import type { MemoryCategory, MemoryItem } from '../../types'

/** 记忆主题分类选项（hint 为给用户的一句话介绍） */
const CATEGORY_OPTIONS: Array<{ value: MemoryCategory; label: string; hint: string }> = [
  { value: 'user_info', label: '用户信息', hint: '你的身份与喜好' },
  { value: 'long_term', label: '长期经历', hint: '重要事件与剧情' },
  { value: 'promises', label: '约定承诺', hint: '答应过的事/待办' },
]

/** 手动添加记忆的最小有效长度（过短的语气词/标签不构成长期记忆） */
const MIN_MANUAL_MEMORY_LEN = 6
/**
 * 可疑标签词：命中即弱提示。
 * 仅当用了「用户/角色/AI」这类会在注入前被 normalizeMemoryPerspective 转写掉的原始词才提示，
 * 引导用户改用系统统一的标准人称「对方(用户)/你(角色)」；
 * 「对方」「你」是合法人称，不在此列（自动沉淀记忆本就用这套人称，手动添加应保持一致）。
 */
const SELF_REFERENT_WORDS = ['用户', '角色', 'AI']

/** 分类显示名（不含介绍，用于列表标签） */
function categoryLabel(cat: MemoryCategory): string {
  return CATEGORY_OPTIONS.find((o) => o.value === cat)?.label ?? '长期经历'
}

/** 归属角色显示名（null = 全局背景） */
function ownerLabel(cards: Array<{ id: string; name: string }>, cardId: string | null): string {
  if (!cardId) return '全局'
  return cards.find((c) => c.id === cardId)?.name ?? '已删除角色'
}

/** 判断文本是否命中可疑标签词（弱提示用） */
function containsSelfReferent(text: string): boolean {
  return SELF_REFERENT_WORDS.some((w) => text.includes(w))
}

/**
 * 判断新记忆是否与现有已确认记忆重复（完全相同，或互相包含且两段都较长）。
 * 与主进程 memoryExtraction 的去重口径保持一致，避免无价值重复占满 MAX_MEMORIES 注入名额。
 * @param content 待判断的新记忆内容
 * @param existing 已有的已确认记忆列表
 */
function isDuplicateMemory(content: string, existing: MemoryItem[]): boolean {
  const c = content.trim()
  if (!c) return false
  return existing.some((item) => {
    const et = (item.content ?? '').trim()
    if (!et) return false
    if (et === c) return true
    // 互相包含且较长才算重复：避免把常见的短词误判（如「对方」被长句包含）
    return et.length > MIN_MANUAL_MEMORY_LEN && c.length > MIN_MANUAL_MEMORY_LEN && (et.includes(c) || c.includes(et))
  })
}

export function MemoryPanel() {
  const {
    items, pendingItems, loading, pendingLoading,
    load, loadPending, add, update, confirm, remove,
  } = useMemoryStore()
  const cards = useCharacterStore((s) => s.cards)
  const loadCards = useCharacterStore((s) => s.load)
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const saveSettings = useSettingsStore((s) => s.save)

  const [tab, setTab] = useState<'confirmed' | 'pending'>('confirmed')
  // 分类/归属下拉：'all' = 不筛选（新增时回退默认 long_term / 全局）
  const [filterCat, setFilterCat] = useState<MemoryCategory | 'all'>('all')
  const [filterOwner, setFilterOwner] = useState<string>('all') // 'all' | 'global' | cardId
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<MemoryCategory>('long_term')

  useEffect(() => {
    void load()
    void loadPending()
    void loadCards()
    if (!settingsLoaded) void loadSettings()
  }, [load, loadPending, loadCards, settingsLoaded, loadSettings])

  // 自动沉淀等外部变更 → 刷新列表
  useEffect(() => api.memory.onChanged(() => {
    void load()
    void loadPending()
  }), [load, loadPending])

  /** 按当前筛选过滤已确认记忆 */
  const filteredItems = items.filter(
    (m) =>
      (filterCat === 'all' || m.category === filterCat) &&
      (filterOwner === 'all' || (filterOwner === 'global' ? m.characterCardId == null : m.characterCardId === filterOwner)),
  )

  /** 新增已确认记忆（分类/归属取下拉当前值，'all' 回退默认）：提交前做轻量引导校验 */
  const handleAdd = async () => {
    const text = newContent.trim()
    if (!text) return
    // 最小有效长度拦截：过短的「对方是用户酱」这类元信息/语气词不构成长期记忆
    if (text.length < MIN_MANUAL_MEMORY_LEN) {
      toast('内容太短，可能不是有效长期记忆', 'error')
      return
    }
    // 去重硬拦截：与已有已确认记忆冲突则不重复添加
    if (isDuplicateMemory(text, items)) {
      toast('已存在相同或相似记忆，无需重复添加', 'error')
      return
    }
    const ok = await add({
      content: text,
      category: filterCat === 'all' ? 'long_term' : filterCat,
      characterCardId: filterOwner === 'all' || filterOwner === 'global' ? null : filterOwner,
    })
    if (ok) {
      setNewContent('')
      if (containsSelfReferent(text)) {
        toast('已添加（提示：含「用户/角色/AI」等标签词，建议改用「对方/你」人称，请复核）', 'info')
      } else {
        toast('已添加记忆')
      }
    } else {
      toast('添加失败', 'error')
    }
  }

  /** 保存编辑（内容 / 分类） */
  const handleEdit = async () => {
    if (!editingId) return
    const ok = await update(editingId, { content: editContent, category: editCategory })
    if (ok) {
      toast('已更新')
      setEditingId(null)
    } else {
      toast('更新失败', 'error')
    }
  }

  /** 确认待确认候选（入已确认，注入生效） */
  const handleConfirm = async (id: string) => {
    const ok = await confirm(id)
    if (ok) toast('已确认，将注入对话')
    else toast('确认失败', 'error')
  }

  /** 删除记忆（已确认 / 候选通用） */
  const handleRemove = async (id: string) => {
    const ok = await remove(id)
    if (ok) toast('已删除')
    else toast('删除失败', 'error')
  }

  const pendingCount = pendingItems.length
  const tabBtn = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'border-[var(--border-strong)] bg-surface-2 text-text'
        : 'border-border text-text-2 hover:border-border-strong hover:text-text'
    }`
  const metaTag = 'rounded-full border border-[var(--border-strong)] bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted'

  // 新增输入的实时引导状态（仅展示，不阻断输入）
  const trimmedNew = newContent.trim()
  const newTooShort = trimmedNew.length > 0 && trimmedNew.length < MIN_MANUAL_MEMORY_LEN
  const newDuplicate = trimmedNew.length > 0 && isDuplicateMemory(trimmedNew, items)
  const newSelfReferent = trimmedNew.length >= MIN_MANUAL_MEMORY_LEN && !newDuplicate && containsSelfReferent(trimmedNew)

  return (
    <div className="space-y-3">
      {/* 自动沉淀记忆开关 */}
      <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div>
          <div className="text-sm text-text">自动沉淀记忆</div>
          <div className="text-xs text-text-muted">
            会话结束后自动从对话中提取候选记忆（在下方「待确认候选」审核后生效），会额外消耗一次模型调用
          </div>
        </div>
        <Switch
          checked={settings.enableMemoryExtraction}
          onChange={(v) => void saveSettings({ enableMemoryExtraction: v })}
        />
      </div>

      {/* Tab：已确认 / 待确认 */}
      <div className="flex gap-2">
        <button type="button" className={tabBtn(tab === 'confirmed')} onClick={() => setTab('confirmed')}>
          已确认记忆
        </button>
        <button type="button" className={tabBtn(tab === 'pending')} onClick={() => setTab('pending')}>
          待确认候选
          {pendingCount > 0 && (
            <span className="rounded-full bg-[var(--accent-500)] px-1.5 text-[10px] font-semibold text-white">{pendingCount}</span>
          )}
        </button>
      </div>

      {tab === 'confirmed' ? (
        <>
          {/* 新增 + 筛选：分类/归属下拉选择后即时筛选列表，同时作为新增记忆的默认分类与归属 */}
          <div className="space-y-2">
            <Input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="输入一条长期记忆，如：对方喜欢的称呼是「亲爱的」"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd()
              }}
            />
            {/* 实时轻量引导：过短 / 重复 / 可疑标签词提示条（仅展示，不阻断输入） */}
            {newTooShort && (
              <p className="text-xs" style={{ color: 'var(--warning)' }}>
                内容过短，可能不是有效长期记忆（建议 ≥{MIN_MANUAL_MEMORY_LEN} 字）。
              </p>
            )}
            {newDuplicate && (
              <p className="text-xs" style={{ color: 'var(--danger)' }}>与已有已确认记忆重复，无需重复添加。</p>
            )}
            {newSelfReferent && (
              <p className="text-xs" style={{ color: 'var(--warning)' }}>
                含「用户/角色/AI」等标签词（系统用「对方/你」统一人称），请确认后改为标准说法。
              </p>
            )}
            <div className="flex items-center gap-2">
              <Select value={filterCat} onChange={(e) => setFilterCat(e.target.value as MemoryCategory | 'all')} className="flex-1">
                <option value="all">全部分类</option>
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}（{o.hint}）</option>
                ))}
              </Select>
              <Select value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)} className="flex-1">
                <option value="all">全部记忆</option>
                <option value="global">全局背景</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
              <Button onClick={() => void handleAdd()} disabled={!newContent.trim()}>
                添加
              </Button>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-text-muted">
            已确认记忆会注入 system prompt（当前角色 + 全局共享背景），对话前实时生效。上方两个下拉可筛选列表，同时作为新增记忆的默认分类与归属；自动沉淀的记忆会进入「待确认候选」。
          </p>

          {loading ? (
            <Loading />
          ) : filteredItems.length === 0 ? (
            <Empty text={items.length === 0 ? '还没有已确认的记忆' : '当前筛选条件下没有记忆'} />
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item) => (
                <Card key={item.id} className="flex items-center gap-3 py-3">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                  >
                    <BrainCircuit size={15} strokeWidth={1.75} color="var(--primary-400)" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className={metaTag}>{categoryLabel(item.category)}</span>
                      <span className="text-[11px] text-text-muted">· {ownerLabel(cards, item.characterCardId)}</span>
                    </div>
                    {editingId === item.id ? (
                      <div className="mt-2 space-y-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-surface-2 p-3">
                        {/* 编辑输入框：回填原文本，占满卡片内容区宽度 */}
                        <Input
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          autoFocus
                          placeholder="编辑记忆内容…"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleEdit()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                        {/* 分类下拉 + 保存/取消：全部约束在卡片内，不溢出 */}
                        <div className="flex items-center gap-2">
                          <Select
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                            className="min-w-0 flex-1"
                          >
                            {CATEGORY_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </Select>
                          <div className="flex shrink-0 gap-1">
                            <Button size="sm" onClick={() => void handleEdit()}>保存</Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>取消</Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-text selectable">{item.content}</div>
                    )}
                  </div>
                  {editingId !== item.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(item.id)
                          setEditContent(item.content)
                          setEditCategory(item.category)
                        }}
                      >
                        编辑
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => void handleRemove(item.id)}>
                        删除
                      </Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-text-muted">
            会话自动沉淀的记忆候选：保留后会注入对话，不需要的删除即可。关闭上方「自动沉淀记忆」后不再产生新候选。
          </p>
          {pendingLoading ? (
            <Loading />
          ) : pendingItems.length === 0 ? (
            <Empty text="暂无待确认候选" />
          ) : (
            <div className="space-y-2">
              {pendingItems.map((item) => (
                <Card key={item.id} className="flex items-center gap-3 py-3">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                  >
                    <Clock size={15} strokeWidth={1.75} color="var(--accent-500)" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className={metaTag}>{categoryLabel(item.category)}</span>
                      <span className="text-[11px] text-text-muted">· {ownerLabel(cards, item.characterCardId)}</span>
                    </div>
                    <div className="text-sm text-text selectable">{item.content}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" onClick={() => void handleConfirm(item.id)}>
                      <Check size={13} strokeWidth={2.25} /> 保留
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void handleRemove(item.id)}>
                      <Trash2 size={13} strokeWidth={2.25} /> 删除
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
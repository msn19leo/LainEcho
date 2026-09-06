/**
 * 记忆体面板：按角色隔离 + 分主题（用户信息/长期经历/约定承诺）+ 待确认候选审核。
 * - 已确认记忆：注入 system prompt（当前角色 + 全局背景），可新增/编辑/删除
 * - 待确认候选：会话自动沉淀产物，保留后入已确认（注入生效），删除则丢弃
 * - 新增区的分类/归属下拉同时充当列表筛选（选择后即时过滤已确认记忆）
 */
import { useEffect, useState } from 'react'
import { BrainCircuit, Check, Clock, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useMemoryStore } from '../../store/memoryStore'
import { useCharacterStore } from '../../store/characterStore'
import { useSettingsStore } from '../../store/settingsStore'
import { Button, Card, Empty, Input, Loading, Select, Switch } from '../../components/ui'
import { toast } from '../../components/toast'
import type { MemoryCategory } from '../../types'

/** 记忆主题分类选项（hint 为给用户的一句话介绍） */
const CATEGORY_OPTIONS: Array<{ value: MemoryCategory; label: string; hint: string }> = [
  { value: 'user_info', label: '用户信息', hint: '你的身份与喜好' },
  { value: 'long_term', label: '长期经历', hint: '重要事件与剧情' },
  { value: 'promises', label: '约定承诺', hint: '答应过的事/待办' },
]

/** 分类显示名（不含介绍，用于列表标签） */
function categoryLabel(cat: MemoryCategory): string {
  return CATEGORY_OPTIONS.find((o) => o.value === cat)?.label ?? '长期经历'
}

/** 归属角色显示名（null = 全局背景） */
function ownerLabel(cards: Array<{ id: string; name: string }>, cardId: string | null): string {
  if (!cardId) return '全局'
  return cards.find((c) => c.id === cardId)?.name ?? '已删除角色'
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

  /** 新增已确认记忆（分类/归属取下拉当前值，'all' 回退默认） */
  const handleAdd = async () => {
    const text = newContent.trim()
    if (!text) return
    const ok = await add({
      content: text,
      category: filterCat === 'all' ? 'long_term' : filterCat,
      characterCardId: filterOwner === 'all' || filterOwner === 'global' ? null : filterOwner,
    })
    if (ok) {
      setNewContent('')
      toast('已添加记忆')
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
              placeholder="输入一条长期记忆，如：用户喜欢的称呼是「亲爱的」"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd()
              }}
            />
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
                      <div className="flex items-center gap-2">
                        <Input
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleEdit()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                        <Select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                          className="w-32 shrink-0"
                        >
                          {CATEGORY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}（{o.hint}）</option>
                          ))}
                        </Select>
                        <Button size="sm" onClick={() => void handleEdit()}>保存</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>取消</Button>
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

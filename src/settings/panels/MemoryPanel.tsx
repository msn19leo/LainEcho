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
import { BrainCircuit, Check, Clock, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useMemoryStore } from '../../store/memoryStore'
import { useCharacterStore } from '../../store/characterStore'
import { useSettingsStore } from '../../store/settingsStore'
import { Button, Card, Empty, Input, Loading, Select, Switch, Textarea } from '../../components/ui'
import { toast } from '../../components/toast'
import type { MemoryCategory, MemoryItem, MemoryProfile } from '../../types'

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

  const [tab, setTab] = useState<'confirmed' | 'pending' | 'profile' | 'chronicle'>('confirmed')
  // 分类/归属下拉：'all' = 不筛选（新增时回退默认 long_term / 全局）
  const [filterCat, setFilterCat] = useState<MemoryCategory | 'all'>('all')
  const [filterOwner, setFilterOwner] = useState<string>('all') // 'all' | 'global' | cardId
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<MemoryCategory>('long_term')

  // ---------------- 语义搜索 / 画像 / 向量 ----------------
  /** 语义搜索词（回车或点按钮触发；清空恢复普通筛选列表） */
  const [searchQuery, setSearchQuery] = useState('')
  /** 搜索结果（null = 未在搜索态）；每项附带语义相似度分（本地过滤回退时无分） */
  const [searchResults, setSearchResults] = useState<Array<MemoryItem & { score?: number }> | null>(null)
  const [searching, setSearching] = useState(false)
  /** 当前归属的画像/编年史档案（归属下拉决定：all/global = 全局） */
  const [profile, setProfile] = useState<MemoryProfile | null>(null)
  const [consolidating, setConsolidating] = useState(false)
  const [reembedding, setReembedding] = useState(false)
  const [showFullDigest, setShowFullDigest] = useState(false)
  /** 画像编辑态：true 时生效画像卡片变为 Textarea 编辑框 */
  const [editingProfile, setEditingProfile] = useState(false)
  const [profileDraft, setProfileDraft] = useState('')
  /** 编年史条目编辑态：正在编辑的条目 id + 草稿文本 */
  const [editingChronicleId, setEditingChronicleId] = useState<string | null>(null)
  const [chronicleDraft, setChronicleDraft] = useState('')
  /** 嵌入服务独立 Key：是否已配置（仅掩码回显）+ 输入框草稿 */
  const [hasEmbeddingKey, setHasEmbeddingKey] = useState(false)
  const [embeddingKeyInput, setEmbeddingKeyInput] = useState('')
  const [testingEmbed, setTestingEmbed] = useState(false)

  useEffect(() => {
    void load()
    void loadPending()
    void loadCards()
    if (!settingsLoaded) void loadSettings()
    void api.settings.hasEmbeddingApiKey().then(setHasEmbeddingKey).catch(() => setHasEmbeddingKey(false))
  }, [load, loadPending, loadCards, settingsLoaded, loadSettings])

  /** 画像归属键：与记忆归属下拉联动（all/global → 全局档案，其余 → 对应角色档案） */
  const profileCardId = filterOwner === 'all' || filterOwner === 'global' ? '' : filterOwner

  // 自动沉淀等外部变更 → 刷新列表与画像状态（如另一窗口触发了自动整理）
  useEffect(() => api.memory.onChanged(() => {
    void load()
    void loadPending()
    void api.memory.getProfile(profileCardId).then(setProfile).catch(() => setProfile(null))
  }), [load, loadPending, profileCardId])

  useEffect(() => {
    void api.memory.getProfile(profileCardId).then(setProfile).catch(() => setProfile(null))
    // 切归属后清掉搜索态，避免跨角色残留
    setSearchResults(null)
    setSearchQuery('')
  }, [profileCardId])

  /** 语义搜索：向量命中按相似度排序展示；嵌入不可用/无命中时回退本地包含过滤 */
  const handleSearch = async () => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      return
    }
    setSearching(true)
    try {
      const hits = await api.memory.semanticSearch(q, 20)
      if (hits.length > 0) {
        setSearchResults(hits.map((h) => ({ ...h.item, score: h.score })))
      } else {
        // 回退本地过滤（嵌入未配置或低置信无命中）
        setSearchResults(items.filter((m) => m.content.includes(q)))
      }
    } catch {
      setSearchResults(items.filter((m) => m.content.includes(q)))
    } finally {
      setSearching(false)
    }
  }

  /** 触发画像/编年史整理（画像落为草稿待采纳，编年史直接生效） */
  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const r = await api.memory.consolidateProfile(profileCardId)
      if (!r.ok) {
        toast(r.error ?? '整理失败', 'error')
      } else if (r.draft) {
        toast('画像草稿已生成，请确认后采纳')
      } else if (r.chronicleAdded > 0) {
        toast(`编年史已更新（新增 ${r.chronicleAdded} 条）`)
      } else {
        toast('没有需要整理的新记忆')
      }
      setProfile(await api.memory.getProfile(profileCardId))
    } finally {
      setConsolidating(false)
    }
  }

  /** 采纳/放弃画像草稿 */
  const handleAdopt = async (adopt: boolean) => {
    await api.memory.adoptProfile(profileCardId, adopt)
    toast(adopt ? '画像已采纳，将常驻注入对话' : '已放弃草稿')
    setProfile(await api.memory.getProfile(profileCardId))
  }

  /** 进入画像编辑态（草稿回填当前生效画像全文） */
  const startEditProfile = () => {
    if (!profile?.personaDigest) return
    setProfileDraft(profile.personaDigest)
    setShowFullDigest(true)
    setEditingProfile(true)
  }

  /** 保存画像编辑（清空文本 = 删除画像） */
  const handleSaveProfile = async () => {
    await api.memory.updateProfileDigest(profileCardId, profileDraft)
    toast(profileDraft.trim() ? '画像已更新' : '画像已删除（来源记忆已恢复为未吸收）')
    setEditingProfile(false)
    setProfile(await api.memory.getProfile(profileCardId))
  }

  /** 删除已生效画像（来源记忆恢复"未吸收"，可重新整理生成） */
  const handleDeleteProfile = async () => {
    await api.memory.deleteProfileDigest(profileCardId)
    toast('画像已删除（来源记忆已恢复为未吸收）')
    setEditingProfile(false)
    setProfile(await api.memory.getProfile(profileCardId))
  }

  /** 进入编年史条目编辑态 */
  const startEditChronicle = (entryId: string, text: string) => {
    setEditingChronicleId(entryId)
    setChronicleDraft(text)
  }

  /** 保存编年史条目编辑 */
  const handleSaveChronicle = async () => {
    if (!editingChronicleId) return
    try {
      await api.memory.updateChronicleEntry(profileCardId, editingChronicleId, chronicleDraft)
      toast('编年史已更新')
      setEditingChronicleId(null)
      setProfile(await api.memory.getProfile(profileCardId))
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', 'error')
    }
  }

  /** 删除单条编年史条目（原始记忆保持不变，仅移除摘要） */
  const handleDeleteChronicle = async (entryId: string) => {
    await api.memory.deleteChronicleEntry(profileCardId, entryId)
    toast('编年史条目已删除')
    setProfile(await api.memory.getProfile(profileCardId))
  }

  /** 手动重嵌全部已确认记忆（换嵌入模型 / 大量缺失后使用） */
  const handleReembed = async () => {
    setReembedding(true)
    try {
      const r = await api.memory.reembedAll()
      if (r.unavailable) {
        toast('未配置嵌入模型，无法重嵌', 'error')
      } else {
        toast(`重嵌完成：成功 ${r.embedded} 条${r.failed > 0 ? `，失败 ${r.failed} 条` : ''}`)
      }
    } finally {
      setReembedding(false)
    }
  }

  /** 保存嵌入服务独立 API Key（留空 = 保持不变，与主 LLM Key 同样的加密通道） */
  const handleSaveEmbeddingKey = async () => {
    const key = embeddingKeyInput.trim()
    if (!key) {
      toast('请输入 Key（留空则保持不变）')
      return
    }
    await api.settings.saveEmbeddingApiKey(key)
    setEmbeddingKeyInput('')
    setHasEmbeddingKey(await api.settings.hasEmbeddingApiKey())
    toast('嵌入 API Key 已保存')
  }

  /** 测试嵌入配置连通性（地址/模型/Key 任一缺失或不通都会给出可读错误） */
  const handleTestEmbedding = async () => {
    setTestingEmbed(true)
    try {
      const r = await api.memory.testEmbedding()
      if (r.ok) toast(`嵌入连接成功（向量维度 ${r.dim}）`)
      else toast(r.error ?? '嵌入连接失败', 'error')
    } finally {
      setTestingEmbed(false)
    }
  }

  /** 按当前筛选过滤已确认记忆；搜索态下改用搜索结果（语义排序或本地过滤） */
  const filteredItems: Array<MemoryItem & { score?: number }> = searchResults
    ? searchResults
    : items.filter(
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

      {/* 记忆向量检索（嵌入服务独立配置：地址/模型/Key 均不复用主 LLM） */}
      <div className="space-y-3 rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text">记忆向量检索</div>
            <div className="text-xs text-text-muted">
              按当前对话内容检索最相关的记忆注入（不再固定取最近几条）；关闭或未配置嵌入服务时回退旧行为
            </div>
          </div>
          <Switch
            checked={settings.memoryRetrievalEnabled}
            onChange={(v) => void saveSettings({ memoryRetrievalEnabled: v })}
          />
        </div>
        <Input
          value={settings.embeddingBaseURL}
          onChange={(e) => void saveSettings({ embeddingBaseURL: e.target.value })}
          placeholder="嵌入 API 地址（OpenAI 兼容 /embeddings，如 https://api.example.com/v1，可独立于聊天服务）"
        />
        <div className="flex items-center gap-2">
          <Input
            value={settings.embeddingModel}
            onChange={(e) => void saveSettings({ embeddingModel: e.target.value })}
            placeholder="嵌入模型名（如 text-embedding-3-small / bge-m3）"
            className="min-w-0 flex-1"
          />
          <Button variant="outline" onClick={() => void handleTestEmbedding()} disabled={testingEmbed}>
            {testingEmbed ? '测试中…' : '测试连接'}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={embeddingKeyInput}
            onChange={(e) => setEmbeddingKeyInput(e.target.value)}
            placeholder={hasEmbeddingKey ? 'sk-****（已配置，留空保持不变）' : '嵌入服务 API Key（独立于聊天 Key）'}
            className="min-w-0 flex-1"
          />
          <Button variant="outline" onClick={() => void handleSaveEmbeddingKey()} disabled={!embeddingKeyInput.trim()}>
            保存 Key
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="shrink-0">语义去重阈值</span>
          <input
            type="number"
            min={0.5}
            max={0.99}
            step={0.01}
            value={settings.memoryDedupThreshold}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isNaN(v)) void saveSettings({ memoryDedupThreshold: Math.min(0.99, Math.max(0.5, v)) })
            }}
            className="w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <span>（cos ≥ 该值的候选记忆视为重复；默认 0.92）</span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void handleReembed()} disabled={reembedding || !settings.embeddingModel.trim()}>
            <RefreshCw size={13} strokeWidth={2} className={reembedding ? 'animate-spin' : ''} />
            重新嵌入
          </Button>
        </div>
      </div>

      {/* Tab：已确认 / 待确认 / 用户画像 / 编年史 */}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={tabBtn(tab === 'confirmed')} onClick={() => setTab('confirmed')}>
          已确认记忆
        </button>
        <button type="button" className={tabBtn(tab === 'pending')} onClick={() => setTab('pending')}>
          待确认候选
          {pendingCount > 0 && (
            <span className="rounded-full bg-[var(--accent-500)] px-1.5 text-[10px] font-semibold text-white">{pendingCount}</span>
          )}
        </button>
        <button type="button" className={tabBtn(tab === 'profile')} onClick={() => setTab('profile')}>
          用户画像
          {profile?.pendingDigest?.trim() && (
            <span className="h-2 w-2 rounded-full bg-[var(--warning)]" title="有待采纳的画像草稿" />
          )}
        </button>
        <button type="button" className={tabBtn(tab === 'chronicle')} onClick={() => setTab('chronicle')}>
          编年史
          {profile && profile.chronicle.length > 0 && (
            <span className="rounded-full bg-[var(--accent-500)] px-1.5 text-[10px] font-semibold text-white">{profile.chronicle.length}</span>
          )}
        </button>
      </div>

      {tab === 'confirmed' ? (
        <>
          {/* 语义搜索：向量检索命中按相似度排序；嵌入不可用时回退本地包含过滤 */}
          <div className="flex items-center gap-2">
            <Input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                if (!e.target.value.trim()) setSearchResults(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch()
              }}
              placeholder="语义搜索记忆（回车搜索，清空恢复列表）"
              className="min-w-0 flex-1"
            />
            <Button variant="outline" onClick={() => void handleSearch()} disabled={searching || !searchQuery.trim()}>
              <Search size={13} strokeWidth={2} />
              搜索
            </Button>
          </div>
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
                      {typeof item.score === 'number' && (
                        <span className="text-[11px] text-text-muted">· 相似度 {(item.score * 100).toFixed(0)}%</span>
                      )}
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
      ) : tab === 'pending' ? (
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
      ) : tab === 'profile' ? (
        <>
          {/* 用户画像：把「用户信息」类记忆压缩为一段常驻注入的画像稿（整理 → 采纳 → 生效） */}
          <div className="flex items-center justify-between">
            <p className="text-xs leading-relaxed text-text-muted">
              画像由「用户信息」类记忆整理压缩而来，采纳后每一轮对话都会常驻注入（整理后需在此采纳）。
            </p>
            <Button variant="outline" size="sm" onClick={() => void handleConsolidate()} disabled={consolidating}>
              {consolidating ? '整理中…' : '整理画像'}
            </Button>
          </div>
          {profile?.pendingDigest?.trim() && (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-surface p-3">
              <p className="text-xs font-medium text-text">待采纳的画像草稿（采纳后常驻注入）：</p>
              <p className="text-xs leading-relaxed text-text-2 selectable">{profile.pendingDigest}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleAdopt(true)}>
                  <Check size={13} strokeWidth={2.25} /> 采纳
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleAdopt(false)}>放弃</Button>
              </div>
            </div>
          )}
          {profile?.personaDigest?.trim() && !editingProfile && (
            <Card className="py-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span className={metaTag}>当前生效画像</span>
                <span className="text-[11px] text-text-muted">
                  · 更新于 {new Date(profile.personaUpdatedAt).toLocaleString('zh-CN')}
                </span>
              </div>
              <p
                className="cursor-pointer text-sm leading-relaxed text-text selectable"
                onClick={() => setShowFullDigest((v) => !v)}
              >
                {showFullDigest || profile.personaDigest.length <= 120
                  ? profile.personaDigest
                  : `${profile.personaDigest.slice(0, 120)}…（点击展开/收起）`}
              </p>
              <div className="mt-2 flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={startEditProfile}>
                  编辑
                </Button>
                <Button variant="danger" size="sm" onClick={() => void handleDeleteProfile()}>
                  删除
                </Button>
              </div>
            </Card>
          )}
          {editingProfile && (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-surface-2 p-3">
              <Textarea
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
                autoFocus
                rows={6}
                placeholder="编辑画像全文…（清空保存 = 删除画像）"
              />
              <div className="flex gap-1">
                <Button size="sm" onClick={() => void handleSaveProfile()}>保存</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingProfile(false)}>取消</Button>
              </div>
            </div>
          )}
          {!profile?.personaDigest?.trim() && !editingProfile && (
            <Empty text="尚无画像：点上方「整理画像」，把用户信息类记忆压缩为常驻画像稿" />
          )}
        </>
      ) : (
        <>
          {/* 编年史：长期经历的滚动摘要条目（整理后直接生效，参与检索与兜底注入） */}
          <div className="flex items-center justify-between">
            <p className="text-xs leading-relaxed text-text-muted">
              编年史由「长期经历」类记忆按时间脉络归纳而来，整理后直接生效（作为检索候选与兜底注入）。
            </p>
            <Button variant="outline" size="sm" onClick={() => void handleConsolidate()} disabled={consolidating}>
              {consolidating ? '整理中…' : '整理编年史'}
            </Button>
          </div>
          {profile && profile.chronicle.length > 0 ? (
            <div className="space-y-2">
              {[...profile.chronicle]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((entry) => (
                  <Card key={entry.id} className="flex items-center gap-3 py-3">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]"
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                    >
                      <Sparkles size={15} strokeWidth={1.75} color="var(--accent-500)" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className={metaTag}>编年史</span>
                        <span className="text-[11px] text-text-muted">· {new Date(entry.createdAt).toLocaleDateString('zh-CN')} 归纳</span>
                      </div>
                      {editingChronicleId === entry.id ? (
                        <div className="mt-2 space-y-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-surface-2 p-3">
                          <Textarea
                            value={chronicleDraft}
                            onChange={(e) => setChronicleDraft(e.target.value)}
                            autoFocus
                            rows={3}
                            placeholder="编辑编年史条目…"
                          />
                          <div className="flex gap-1">
                            <Button size="sm" onClick={() => void handleSaveChronicle()}>保存</Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditingChronicleId(null)}>取消</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm leading-relaxed text-text selectable">{entry.text}</div>
                      )}
                    </div>
                    {editingChronicleId !== entry.id && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEditChronicle(entry.id, entry.text)}
                        >
                          编辑
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => void handleDeleteChronicle(entry.id)}>
                          删除
                        </Button>
                      </div>
                    )}
                  </Card>
                ))}
            </div>
          ) : (
            <Empty text="暂无编年史：点上方「整理编年史」，把长期经历类记忆归纳为摘要条目" />
          )}
        </>
      )}
    </div>
  )
}
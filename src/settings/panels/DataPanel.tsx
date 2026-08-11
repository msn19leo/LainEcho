/**
 * Data 面板：会话管理（搜索、按角色卡筛选、导出为 Markdown 后删除）。
 */
import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Search } from 'lucide-react'
import { api } from '../../api'
import { useCharacterStore } from '../../store/characterStore'
import type { SessionIndexItem } from '../../types'
import { Button, Card, Empty, Input, Loading, Modal, Select } from '../../components/ui'
import { toast } from '../../components/toast'
import { formatRelativeTime, formatTimeFull, truncate } from '../../lib/utils'

interface PendingDelete {
  session: SessionIndexItem
  exporting: boolean
}

export function DataPanel() {
  const cards = useCharacterStore((s) => s.cards)
  const [sessions, setSessions] = useState<SessionIndexItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filterCard, setFilterCard] = useState('')
  const [pending, setPending] = useState<PendingDelete | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const list = await api.session.list()
      setSessions(list)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    void useCharacterStore.getState().load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions.filter((s) => {
      if (filterCard && s.characterCardId !== filterCard) return false
      if (q && !s.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [sessions, query, filterCard])

  /** 直接删除 */
  const handleDelete = async () => {
    if (!pending) return
    try {
      await api.session.remove(pending.session.id)
      toast('会话已删除')
      setPending(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  /** 导出为 Markdown 并删除 */
  const handleExportAndDelete = async () => {
    if (!pending) return
    setPending({ ...pending, exporting: true })
    try {
      const result = await api.session.exportMarkdown(pending.session.id)
      if (result) {
        await api.session.remove(pending.session.id)
        toast(`已导出到 ${result.savedPath} 并删除`)
        setPending(null)
        await refresh()
      } else {
        // 用户取消保存对话框 → 不删除
        setPending(null)
        toast('已取消导出', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败', 'error')
      setPending((p) => (p ? { ...p, exporting: false } : p))
    }
  }

  return (
    <div className="space-y-3">
      {/* 搜索 + 筛选：各占一半 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按标题搜索会话…"
            className="pl-8"
          />
        </div>
        <Select value={filterCard} onChange={(e) => setFilterCard(e.target.value)}>
          <option value="">全部角色卡</option>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="text-xs text-text-muted">
        共 {filtered.length} 个会话
        {filterCard || query ? `（已筛选）` : ''}
      </div>

      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Empty text="没有匹配的会话" />
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <Card key={s.id} className="flex items-center gap-3 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <MessageSquare size={15} strokeWidth={1.75} color="var(--primary-400)" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text">{truncate(s.title, 24)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                    {s.characterCardName}
                  </span>
                  <span>{s.messageCount} 条消息</span>
                  <span>更新于 {formatRelativeTime(s.updatedAt)}</span>
                  <span className="selectable">{formatTimeFull(s.createdAt)}</span>
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={() => setPending({ session: s, exporting: false })}>
                删除
              </Button>
            </Card>
          ))}
        </div>
      )}

      {/* 删除确认：是否导出为 Markdown 后再删除 */}
      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title="删除会话"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDelete()}
              disabled={pending?.exporting}
            >
              直接删除
            </Button>
            <Button
              autoFocus
              onClick={() => void handleExportAndDelete()}
              disabled={pending?.exporting}
            >
              {pending?.exporting ? '导出中…' : '导出为 Markdown 并删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">
          是否将会话「{truncate(pending?.session.title ?? '', 20)}」导出为 Markdown 后再删除？
          建议先导出备份，避免误删无法恢复。
        </p>
      </Modal>
    </div>
  )
}

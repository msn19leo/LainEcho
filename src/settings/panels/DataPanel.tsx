/**
 * Data 面板：会话管理（搜索、按角色卡筛选、导出为 Markdown 后删除）+ 数据目录设置。
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, MessageSquare, RotateCcw, Search } from 'lucide-react'
import { api } from '../../api'
import { useCharacterStore } from '../../store/characterStore'
import type { SessionIndexItem } from '../../types'
import { Button, Card, ConfirmModal, Empty, Input, Loading, Modal, Select } from '../../components/ui'
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
  /** 数据目录信息 */
  const [dataDir, setDataDir] = useState<{ current: string; default: string; isCustom: boolean } | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  /** 迁移成功后的重启提示 */
  const [restartNotice, setRestartNotice] = useState<string | null>(null)

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
    void api.settings.getDataDir().then(setDataDir).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 选择新目录并迁移数据（成功后需手动重启） */
  const handleChangeDataDir = async () => {
    setMigrating(true)
    try {
      const result = await api.settings.changeDataDir()
      if (result.success && result.needRestart) {
        setRestartNotice('数据迁移成功！请关闭应用后重新打开以使用新数据目录。')
      } else if (!result.success && result.error) {
        toast(result.error, 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '迁移失败', 'error')
    } finally {
      setMigrating(false)
    }
  }

  /** 重置数据目录为默认位置 */
  const handleResetDataDir = async () => {
    setConfirmReset(false)
    setMigrating(true)
    try {
      const result = await api.settings.resetDataDir()
      if (result.success && result.needRestart) {
        setRestartNotice('已恢复默认数据目录。请关闭应用后重新打开以生效。')
      } else if (!result.success && result.error) {
        toast(result.error, 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '重置失败', 'error')
    } finally {
      setMigrating(false)
    }
  }

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
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <MessageSquare size={15} strokeWidth={1.75} color="var(--primary-400)" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text">{truncate(s.title, 24)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                  <span className="rounded-full bg-accent/15 px-2 py-1 text-[10px] text-accent">
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

      {/* 数据存放位置 */}
      {dataDir && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <FolderOpen size={15} strokeWidth={1.75} color="var(--primary-400)" />
            <span className="text-sm font-medium text-text-2">数据存放位置</span>
            {dataDir.isCustom && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent ring-1 ring-accent/30">
                自定义
              </span>
            )}
          </div>
          <div className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2">
            <p className="break-all text-xs leading-relaxed text-text-muted selectable">
              {dataDir.current}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleChangeDataDir()}
              disabled={migrating}
            >
              {migrating ? '迁移中…' : '更改位置'}
            </Button>
            {dataDir.isCustom && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmReset(true)}
                disabled={migrating}
              >
                <RotateCcw size={12} strokeWidth={2} /> 恢复默认
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            更改位置后，所有数据（角色卡、会话、模型、设置等）将复制到新目录，需手动重启应用生效。
            原目录数据不会被删除，可手动清理。
          </p>
        </Card>
      )}

      <ConfirmModal
        open={confirmReset}
        title="恢复默认数据目录"
        message="将清除自定义目录配置并重启应用。新数据将写入默认位置，自定义目录中的数据不会被删除。"
        confirmText="恢复默认"
        onConfirm={() => void handleResetDataDir()}
        onClose={() => setConfirmReset(false)}
      />

      {/* 迁移成功后的重启提示 */}
      <Modal
        open={!!restartNotice}
        onClose={() => setRestartNotice(null)}
        title="需要重启应用"
        footer={
          <Button onClick={() => setRestartNotice(null)}>
            我知道了
          </Button>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">{restartNotice}</p>
      </Modal>
    </div>
  )
}

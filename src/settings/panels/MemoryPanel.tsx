/**
 * 记忆体面板：全局固定记忆条目（所有角色卡对话统一拼接进 system prompt）。
 */
import { useEffect, useState } from 'react'
import { BrainCircuit, Plus } from 'lucide-react'
import { useMemoryStore } from '../../store/memoryStore'
import { Button, Card, Empty, Input, Loading } from '../../components/ui'
import { toast } from '../../components/toast'

export function MemoryPanel() {
  const { items, loading, load, add, update, remove } = useMemoryStore()
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const handleAdd = async () => {
    const text = newContent.trim()
    if (!text) return
    const ok = await add(text)
    if (ok) {
      setNewContent('')
      toast('已添加到全局记忆')
    } else {
      toast('添加失败', 'error')
    }
  }

  const handleEdit = async () => {
    if (!editingId) return
    const ok = await update(editingId, editContent)
    if (ok) {
      toast('已更新')
      setEditingId(null)
    } else {
      toast('更新失败', 'error')
    }
  }

  const handleRemove = async (id: string) => {
    const ok = await remove(id)
    if (ok) toast('已删除')
    else toast('删除失败', 'error')
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="输入一条长期记忆，如：用户喜欢的称呼是「主人」"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd()
          }}
        />
        <Button onClick={() => void handleAdd()} disabled={!newContent.trim()}>
          <Plus size={14} strokeWidth={2.25} /> 添加
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        记忆体为全局共享：每次对话前都会实时拼接进 system prompt，修改后旧会话继续对话同样生效。所有角色卡共享同一份记忆。
      </p>

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty text="还没有记忆条目" />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id} className="flex items-center gap-3 py-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <BrainCircuit size={15} strokeWidth={1.75} color="var(--primary-400)" />
              </span>
              {editingId === item.id ? (
                <>
                  <Input
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                  <Button size="sm" onClick={() => void handleEdit()}>
                    保存
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1 text-sm text-text selectable">{item.content}</div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingId(item.id)
                        setEditContent(item.content)
                      }}
                    >
                      编辑
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void handleRemove(item.id)}>
                      删除
                    </Button>
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

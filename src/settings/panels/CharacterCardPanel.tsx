/**
 * 角色卡面板：列表 + 新建/编辑（名称、人设、绑定模型）/ 删除。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useCharacterStore } from '../../store/characterStore'
import type { CharacterCard } from '../../types'
import { Button, Card, ConfirmModal, Empty, Field, Input, Loading, Modal, Select, Textarea } from '../../components/ui'
import { toast } from '../../components/toast'
import { truncate } from '../../lib/utils'

interface EditorState {
  card: CharacterCard | null
  name: string
  identity: string
  consciousness: string
  modelId: string
}

const EMPTY_EDITOR: EditorState = { card: null, name: '', identity: '', consciousness: '', modelId: '' }

export function CharacterCardPanel() {
  const { cards, loading, load } = useCharacterStore()
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<CharacterCard | null>(null)
  const [saving, setSaving] = useState(false)

  const loadModels = async () => {
    const list = await api.model.list()
    setModels(list.map((m) => ({ id: m.id, name: m.name })))
  }

  useEffect(() => {
    void load()
    void loadModels()
  }, [load])

  const openCreate = () => setEditor({ ...EMPTY_EDITOR })
  const openEdit = (card: CharacterCard) =>
    setEditor({
      card,
      name: card.name,
      identity: card.identity,
      consciousness: card.consciousness,
      modelId: card.modelId ?? '',
    })

  const handleSave = async () => {
    if (!editor) return
    setSaving(true)
    try {
      if (editor.card) {
        await api.characterCard.update(editor.card.id, {
          name: editor.name,
          identity: editor.identity,
          consciousness: editor.consciousness,
          modelId: editor.modelId || null,
        })
        toast('角色卡已更新')
      } else {
        await api.characterCard.create({
          name: editor.name,
          identity: editor.identity,
          consciousness: editor.consciousness,
          modelId: editor.modelId || null,
        })
        toast('角色卡已创建')
      }
      setEditor(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await api.characterCard.remove(deleting.id)
      toast('已删除')
      setDeleting(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">共 {cards.length} 张角色卡</span>
        <Button onClick={openCreate}>＋ 新建角色卡</Button>
      </div>

      {loading ? (
        <Loading />
      ) : cards.length === 0 ? (
        <Empty text="还没有角色卡，点击右上角「新建角色卡」开始" />
      ) : (
        cards.map((card) => (
          <Card key={card.id} className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-sm ring-1 ring-border">
              {card.name.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{card.name}</span>
                {card.modelId && (
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/30">
                    绑定模型
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-text-muted selectable">
                {card.identity.trim() || card.consciousness.trim() ? (
                  <>
                    {card.identity.trim() && (
                      <p className="line-clamp-1">
                        <span className="text-accent">身份</span> · {truncate(card.identity, 60)}
                      </p>
                    )}
                    {card.consciousness.trim() && (
                      <p className="line-clamp-1">
                        <span className="text-accent">意识</span> · {truncate(card.consciousness, 60)}
                      </p>
                    )}
                  </>
                ) : (
                  <p>（未填写身份与意识）</p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="outline" size="sm" onClick={() => openEdit(card)}>
                编辑
              </Button>
              <Button variant="danger" size="sm" onClick={() => setDeleting(card)}>
                删除
              </Button>
            </div>
          </Card>
        ))
      )}

      {/* 新建 / 编辑弹窗 */}
      <Modal
        open={!!editor}
        onClose={() => setEditor(null)}
        title={editor?.card ? '编辑角色卡' : '新建角色卡'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !editor?.name.trim()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {editor && (
          <div className="space-y-4">
            <Field label="名称">
              <Input
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="如：小艾"
                maxLength={20}
              />
            </Field>
            <Field label="身份（identity）" hint="角色是什么——身份设定，将作为 system prompt 的一部分注入">
              <Textarea
                rows={4}
                value={editor.identity}
                onChange={(e) => setEditor({ ...editor, identity: e.target.value })}
                placeholder="你是一只温柔且话痨的猫娘桌宠，名字叫小艾，住在用户的电脑里……"
              />
            </Field>
            <Field label="意识（consciousness）" hint="角色如何思考与表现——行为方式、思维逻辑、说话习惯，将作为 system prompt 的一部分注入">
              <Textarea
                rows={4}
                value={editor.consciousness}
                onChange={(e) => setEditor({ ...editor, consciousness: e.target.value })}
                placeholder="你会亲昵地称呼用户为「主人」，回答简洁温柔，偶尔撒娇，思考时先描述自己的感受……"
              />
            </Field>
            <Field label="绑定 Live2D 模型（可选）">
              <Select
                value={editor.modelId}
                onChange={(e) => setEditor({ ...editor, modelId: e.target.value })}
              >
                <option value="">不绑定（使用全局当前模型）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleting}
        title="删除角色卡"
        message={`确定删除角色卡「${deleting?.name}」吗？已有会话会保留，但无法再以此角色新建会话。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

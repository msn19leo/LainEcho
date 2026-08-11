/**
 * 角色模型面板：Cubism Core 引导 + Live2D 模型导入/管理。
 */
import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, PersonStanding, Plus } from 'lucide-react'
import { api } from '../../api'
import type { Live2DModelMeta } from '../../types'
import { Button, Card, ConfirmModal, Empty, Loading } from '../../components/ui'
import { toast } from '../../components/toast'
import { formatRelativeTime } from '../../lib/utils'

export function CharacterModelPanel() {
  const [corePresent, setCorePresent] = useState(false)
  const [models, setModels] = useState<Live2DModelMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<Live2DModelMeta | null>(null)

  const refresh = async () => {
    const [core, list] = await Promise.all([api.model.coreStatus(), api.model.list()])
    setCorePresent(core.present)
    setModels(list)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const handleImportCore = async () => {
    try {
      const result = await api.model.importCore()
      if (result.present) {
        setCorePresent(true)
        toast('Cubism Core 已导入，桌宠将自动生效')
      } else {
        toast('已取消', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    }
  }

  const handleImportFolder = async () => {
    setImporting(true)
    try {
      const meta = await api.model.importFromFolder()
      if (meta) {
        toast(`模型「${meta.name}」导入成功`)
        await refresh()
      } else {
        toast('已取消', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await api.model.remove(deleting.id)
      toast('已删除')
      setDeleting(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  return (
    <div className="space-y-4">
      {/* Cubism Core */}
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-text">
              Cubism Core 运行库
              {corePresent ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-normal text-success ring-1 ring-success/30">
                  <CheckCircle2 size={11} /> 已就绪
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-normal text-warning ring-1 ring-warning/30">
                  <AlertCircle size={11} /> 未导入
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
              Live2D Cubism Core（live2dcubismcore.min.js）是官方闭源 SDK，无法随应用分发，需您手动导入。
              请前往{' '}
              <a
                className="text-accent underline hover:text-accent-2"
                href="https://www.live2d.com/sdk/download/web/"
                target="_blank"
                rel="noreferrer"
              >
                Live2D 官网
              </a>{' '}
              下载 Cubism SDK for Web，并选择其中的 <code className="rounded-[var(--radius-sm)] bg-surface-2 px-2">live2dcubismcore.min.js</code> 文件。
            </p>
          </div>
          <Button variant={corePresent ? 'outline' : 'primary'} onClick={() => void handleImportCore()}>
            {corePresent ? '重新导入' : '导入运行库'}
          </Button>
        </div>
      </Card>

      {/* 模型列表 */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text">Live2D 模型（{models.length}）</span>
        <Button onClick={() => void handleImportFolder()} disabled={importing}>
          <Plus size={14} strokeWidth={2.25} />
          {importing ? '导入中…' : '从文件夹导入'}
        </Button>
      </div>

      {loading ? (
        <Loading />
      ) : models.length === 0 ? (
        <Empty text="还没有模型。选择包含 xxx.model3.json 的文件夹导入（会复制到应用数据目录）" />
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <Card key={m.id} className="flex items-center gap-3 py-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <PersonStanding size={17} strokeWidth={1.75} color="var(--primary-400)" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text">{m.name}</div>
                <div className="mt-0.5 truncate text-xs text-text-muted selectable">
                  {m.model3Path} · {formatRelativeTime(m.createdAt)} 导入
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={() => setDeleting(m)}>
                删除
              </Button>
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!deleting}
        title="删除模型"
        message={`确定删除模型「${deleting?.name}」吗？其文件夹将被移除，绑定该模型的角色卡会解除绑定。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

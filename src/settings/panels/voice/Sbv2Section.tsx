/**
 * 本地 SBV2（Style-Bert-VITS2）设置区。
 *
 * 与 Genie-TTS 完全独立的组件，不共用任何卡片：
 * - 引擎卡：服务启停 / 状态 / DeBERTa 目录 / 推理设备
 * - 声线卡：声线列表与增删改（声线 = 一个 model.onnx + style_vectors.json 或单个 .sbv2）
 * - 测试卡：自选声线试听
 *
 * 只支持日文；中文台词由主进程翻译后再合成。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Plus,
  Power,
  Rocket,
  Trash2,
} from 'lucide-react'
import { api } from '../../../api'
import type { Sbv2Device, Sbv2ServerStatus, TTSsbv2Config, TTSModelCard, TTSModelCardInput } from '../../../types'
import { Button, Card, ConfirmModal, Field, Input, Modal, Slider } from '../../../components/ui'
import { SelectMenu } from '../../../components/DropdownMenu'
import { toast } from '../../../components/toast'

const EMPTY_EDITOR: TTSModelCardInput = {
  name: '',
  characterName: '',
  onnxModelDir: '',
  refAudioPath: '',
  refAudioText: '',
}

const DEFAULT_TEST_TEXT = 'こんにちは、今日は天気が本当にいいですね。'

const STATE_DOT: Record<Sbv2ServerStatus['state'], string> = {
  stopped: 'bg-text-muted',
  starting: 'bg-warning animate-pulse',
  ready: 'bg-success',
  error: 'bg-danger',
}

/** `ttsSpeed` 由 VoicePanel 从全局 TTS 配置传入（与 Genie / MiMo 的试听共用同一个滑杆） */
export function Sbv2Section({ ttsSpeed = 1 }: { ttsSpeed?: number }) {
  const [cfg, setCfg] = useState<TTSsbv2Config | null>(null)
  /** DeBERTa 目录的编辑草稿：只在失焦时落盘，避免逐键写入把半截路径存下来 */
  const [bertDraft, setBertDraft] = useState('')
  const [status, setStatus] = useState<Sbv2ServerStatus>({ state: 'stopped', message: '未启动' })
  const [devices, setDevices] = useState<Sbv2Device[]>([])
  const [models, setModels] = useState<TTSModelCard[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [showEditor, setShowEditor] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editor, setEditor] = useState<TTSModelCardInput>(EMPTY_EDITOR)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<TTSModelCard | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)

  const voices = useMemo(() => models.filter((m) => m.engine === 'sbv2'), [models])
  const selected = voices.find((v) => v.id === selectedId) ?? null

  const loadAll = useCallback(async () => {
    try {
      const [c, list, st] = await Promise.all([
        api.tts.sbv2Config(),
        api.ttsModel.list(),
        api.tts.sbv2Status(),
      ])
      setCfg(c)
      setBertDraft(c.bertDir)
      setModels(list)
      setStatus(st)
    } catch (err) {
      console.error('[sbv2] 加载配置失败', err)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // 状态轮询（启动/加载是异步的，没有事件通道）
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const st = await api.tts.sbv2Status()
        if (alive) setStatus(st)
      } catch {
        /* 忽略轮询失败 */
      }
    }
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const loadDevices = useCallback(async () => {
    try {
      const list = await api.tts.sbv2Devices()
      setDevices(list)
    } catch (err) {
      console.error('[sbv2] 枚举显卡失败', err)
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const saveCfg = async (patch: Partial<TTSsbv2Config>) => {
    try {
      const next = await api.tts.sbv2SaveConfig(patch)
      setCfg(next)
      if (patch.device) toast('推理设备已切换，服务将自动重建会话')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  const handleStart = async () => {
    setBusy(true)
    try {
      const res = await api.tts.sbv2Start()
      if (!res.ok) {
        toast(res.error ?? '启动失败', 'error')
      } else {
        toast('SBV2 服务已启动')
      }
      setStatus(await api.tts.sbv2Status())
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      await api.tts.sbv2Stop()
      setStatus(await api.tts.sbv2Status())
      toast('SBV2 服务已结束')
    } finally {
      setBusy(false)
    }
  }

  const openNew = () => {
    setEditingId(null)
    setEditor(EMPTY_EDITOR)
    setShowEditor(true)
  }

  const openEdit = (m: TTSModelCard) => {
    setEditingId(m.id)
    setEditor({
      name: m.name,
      characterName: m.characterName,
      onnxModelDir: m.onnxModelDir,
      refAudioPath: m.refAudioPath,
      refAudioText: m.refAudioText,
    })
    setShowEditor(true)
  }

  const handleSaveModel = async () => {
    if (!editor.name.trim()) {
      toast('请填写声线名称', 'info')
      return
    }
    if (!editor.onnxModelDir.trim()) {
      toast('请选择声线目录或 .sbv2 文件', 'info')
      return
    }
    setSaving(true)
    try {
      const payload: TTSModelCardInput = {
        engine: 'sbv2',
        name: editor.name.trim(),
        // SBV2 用目录名/卡片 id 之外的 ident 由声线卡 id 决定，characterName 留空
        characterName: '',
        onnxModelDir: editor.onnxModelDir.trim(),
        refAudioPath: '',
        refAudioText: '',
      }
      if (editingId) {
        await api.ttsModel.update(editingId, payload)
      } else {
        const created = await api.ttsModel.create(payload)
        setSelectedId(created.id)
      }
      // 标记归属引擎
      const list = await api.ttsModel.list()
      setModels(list)
      setShowEditor(false)
      toast('声线已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await api.ttsModel.delete(deleting.id)
      if (selectedId === deleting.id) setSelectedId(null)
      setModels(await api.ttsModel.list())
      toast('声线已删除')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setDeleting(null)
    }
  }

  const handleTest = async () => {
    if (!selected) {
      toast('请先选择一个声线', 'info')
      return
    }
    if (status.state !== 'ready') {
      toast('请先启动 SBV2 服务', 'info')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const audio = await api.tts.synthesize({
        text: testText.trim() || DEFAULT_TEST_TEXT,
        voiceId: null,
        engine: 'sbv2',
        localVoice: { ttsModelId: selected.id },
        speed: ttsSpeed,
      })
      if (!audio) {
        setTestResult({ ok: false, message: '合成返回空音频' })
        return
      }
      audioCtxRef.current?.close().catch(() => {})
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const buf = await ctx.decodeAudioData(audio.slice(0))
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.onended = () => {
        ctx.close().catch(() => {})
        if (audioCtxRef.current === ctx) audioCtxRef.current = null
      }
      src.start()
      setTestResult({ ok: true, message: `合成成功，正在播放（${buf.duration.toFixed(1)} 秒）` })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : '合成失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!cfg) return <Card>正在加载 SBV2 配置…</Card>

  const deviceOptions = [
    { value: 'cpu', label: 'CPU' },
    { value: 'dml', label: 'GPU（DirectML，系统默认显卡）' },
    ...devices.map((d) => ({ value: `dml:${d.id}`, label: `显卡 #${d.id}：${d.name}` })),
  ]

  return (
    <>
      {/* ==================== 引擎卡 ==================== */}
      <Card>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${STATE_DOT[status.state]}`} />
              <span className="text-[13px] font-medium text-text-2">本地 SBV2 服务</span>
              <span className="text-xs text-text-muted">{status.message}</span>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Style-Bert-VITS2（日文），进程内 ONNX 推理，不占端口。首次加载约 2–5 秒。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => void handleStart()} disabled={busy || status.state === 'starting'}>
              {status.state === 'starting' ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} strokeWidth={2.25} />}
              {status.state === 'starting' ? '加载中…' : '启动服务'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void handleStop()}
              disabled={busy || status.state === 'stopped' || testing}
              title={testing ? '合成进行中，无法结束服务' : '结束服务并释放内存'}
            >
              <Power size={14} strokeWidth={2.25} />
              结束服务
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <Field
            label="DeBERTa 目录"
            hint="需包含 deberta.onnx 与 tokenizer.json；全局只配一份，所有声线共用。"
          >
            <div className="flex gap-2">
              <Input
                value={bertDraft}
                onChange={(e) => setBertDraft(e.target.value)}
                onBlur={() => {
                  const next = bertDraft.trim()
                  if (next !== cfg.bertDir) void saveCfg({ bertDir: next })
                }}
                placeholder="选择包含 deberta.onnx 的目录"
              />
              <Button
                variant="outline"
                className="shrink-0 whitespace-nowrap"
                title="选择目录"
                onClick={async () => {
                  const dir = await api.tts.chooseFolder()
                  if (dir) {
                    setBertDraft(dir)
                    void saveCfg({ bertDir: dir })
                  }
                }}
              >
                <FolderOpen size={14} strokeWidth={2.25} />
                目录
              </Button>
            </div>
          </Field>

          <Field
            label="推理设备"
            hint="切换后服务会自动重建会话（约 2–5 秒）。本机实测 CPU 比核显 DirectML 更快。"
          >
            <div className="flex gap-2">
              <SelectMenu
                value={cfg.device}
                onChange={(v) => void saveCfg({ device: v })}
                options={deviceOptions}
                className="w-full max-w-[360px]"
              />
              <Button variant="outline" size="sm" onClick={() => void loadDevices()} title="重新枚举显卡">
                刷新
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {/* ==================== 声线卡 ==================== */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <span className="text-[13px] font-medium text-text-2">声线</span>
            <p className="mt-0.5 text-xs text-text-muted">
              每个声线一个模型：支持 model.onnx + style_vectors.json，或单个 .sbv2 文件。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={openNew}>
            <Plus size={14} strokeWidth={2.25} />
            添加声线
          </Button>
        </div>

        {voices.length === 0 ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-muted">
            还没有声线，点击右上角添加
          </div>
        ) : (
          <div className="space-y-2">
            {voices.map((m) => (
              <div
                key={m.id}
                onClick={() => setSelectedId(m.id === selectedId ? null : m.id)}
                className={`flex cursor-pointer items-center justify-between rounded-[var(--radius-md)] border px-3 py-2 transition-colors ${
                  m.id === selectedId ? 'border-brand bg-brand-gradient/10' : 'border-border hover:border-border-strong'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">{m.name}</div>
                  <div className="truncate text-[11px] text-text-muted">{m.onnxModelDir}</div>
                </div>
                <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(m)} title="编辑">
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(m)} title="删除">
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ==================== 测试卡 ==================== */}
      <Card>
        <div className="mb-3">
          <span className="text-[13px] font-medium text-text-2">测试合成</span>
          <p className="mt-0.5 text-xs text-text-muted">
            {selected ? `使用声线「${selected.name}」合成` : '请在上方选择一个声线'}
          </p>
        </div>
        <div className="space-y-3">
          <Field label="测试文本" hint="该引擎仅支持日文；中文会先自动翻译为日语。">
            <Input value={testText} onChange={(e) => setTestText(e.target.value)} />
          </Field>
          <Field
            label="随机度"
            hint="时长预测里「随机分支」的占比（sdp_ratio）。0 = 节奏完全确定、每次一致；越高停顿与语速起伏越大，也更容易拖音。只影响节奏，不影响音色。"
          >
            <div className="w-full max-w-[320px]">
              <Slider
                value={cfg.sdpRatio ?? 0.2}
                min={0}
                max={1}
                step={0.05}
                defaultValue={0.2}
                onChange={(v) => void saveCfg({ sdpRatio: Math.round(v * 100) / 100 })}
                format={(v) => v.toFixed(2)}
              />
            </div>
          </Field>
          <div className="flex items-center gap-2">
            <Button onClick={() => void handleTest()} disabled={testing || !selected}>
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} strokeWidth={2.25} />}
              {testing ? '合成中…' : '试听'}
            </Button>
            <span className="text-xs text-text-muted">
              设备：{status.device ? status.device : '未启动'}
              {status.voices && status.voices.length > 0 ? ` · 已加载 ${status.voices.length} 个声线` : ''}
            </span>
          </div>
          {testResult && (
            <div
              className={`rounded-[var(--radius-sm)] border px-3 py-2 text-xs ${
                testResult.ok
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-danger/30 bg-danger/5 text-danger'
              }`}
            >
              {testResult.message}
            </div>
          )}
        </div>
      </Card>

      {/* ==================== 声线编辑弹窗 ==================== */}
      <Modal
        open={showEditor}
        onClose={() => setShowEditor(false)}
        title={editingId ? '编辑声线' : '添加声线'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowEditor(false)}>取消</Button>
            <Button onClick={() => void handleSaveModel()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="声线名称" hint="仅用于界面显示">
            <Input
              value={editor.name}
              onChange={(e) => setEditor((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如：Lain"
            />
          </Field>
          <Field
            label="声线路径"
            hint="选择包含 model.onnx + style_vectors.json 的目录，或包含一个 .sbv2 文件的目录。"
          >
            <div className="flex gap-2">
              <Input
                value={editor.onnxModelDir}
                onChange={(e) => setEditor((prev) => ({ ...prev, onnxModelDir: e.target.value }))}
                placeholder="例如 E:\models\model"
              />
              <Button
                variant="outline"
                title="选择目录"
                onClick={async () => {
                  const dir = await api.tts.chooseFolder()
                  if (dir) setEditor((prev) => ({ ...prev, onnxModelDir: dir }))
                }}
              >
                <FolderOpen size={14} strokeWidth={2.25} />
                目录
              </Button>
            </div>
          </Field>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void handleDelete()}
        title="删除声线"
        message={`确定删除声线「${deleting?.name ?? ''}」吗？绑定该声线的角色将失去本地语音。`}
      />
    </>
  )
}

/**
 * 语音合成配置面板。
 * 双引擎：
 * - 本地声库（engine=genie，默认）：本地 GenieTTS 服务，声库自带性格；自动拉起 + 健康检测。
 * - 云端声音克隆（engine=mimo）：MiMo，需 API Key + 参考音频。
 * 功能：
 * - 引擎切换
 * - GenieTTS 配置：地址/项目路径/GenieData 目录/检测/启动
 * - 角色 TTS 模型卡管理（角色名/onnx 目录/参考音频）
 * - MiMo API Key 配置 + 参考音频管理
 * - 输出语言切换：中文 / 日文
 * - 测试合成试听
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Play, Plus, Trash2, XCircle, Pencil, PlugZap, Rocket, Loader2, FolderOpen, FileAudio } from 'lucide-react'
import { api } from '../../api'
import type { TTSConfig, VoiceReference, TTSLanguage, TTSGenieConfig, TTSModelCard, TTSModelCardInput } from '../../types'
import { Button, Card, Field, Input, Loading, Modal, PanelHeader } from '../../components/ui'
import { toast } from '../../components/toast'

/** 测试合成的按语言默认文本 */
const TEST_TEXT_DEFAULTS: Record<TTSLanguage, string> = {
  zh: '你好，今天天气真好。',
  ja: 'こんにちは、今日は天気が本当にいいですね。',
}

/** 模型卡编辑器初始状态 */
const EMPTY_EDITOR: TTSModelCardInput = {
  name: '',
  characterName: '',
  onnxModelDir: '',
  refAudioPath: '',
  refAudioText: '',
}

export function VoicePanel() {
  const [config, setConfig] = useState<TTSConfig | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [voices, setVoices] = useState<VoiceReference[]>([])
  /** GenieTTS 配置 */
  const [genieCfg, setGenieCfg] = useState<TTSGenieConfig | null>(null)
  /** TTS 模型卡列表 */
  const [ttsModels, setTtsModels] = useState<TTSModelCard[]>([])
  /** 当前选中的模型卡（用于测试合成） */
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  /** 模型卡编辑器 */
  const [showEditor, setShowEditor] = useState(false)
  const [editingModel, setEditingModel] = useState<TTSModelCard | null>(null)
  const [editor, setEditor] = useState<TTSModelCardInput>(EMPTY_EDITOR)
  const [savingModel, setSavingModel] = useState(false)

  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [importing, setImporting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')
  /** 测试合成文本（可编辑；留空按当前语言使用默认文本） */
  const [testText, setTestText] = useState('')
  const prevLangRef = useRef<TTSLanguage | null>(null)

  /** 语言变化自动切换测试默认文本 */
  useEffect(() => {
    if (!config) return
    const lang = config.language
    const prev = prevLangRef.current
    if (prev && testText === TEST_TEXT_DEFAULTS[prev]) {
      setTestText(TEST_TEXT_DEFAULTS[lang])
    } else if (prev === null) {
      setTestText(TEST_TEXT_DEFAULTS[lang])
    }
    prevLangRef.current = lang
  }, [config?.language])

  /** 加载配置：TTS + 参考音频 + Genie 配置 + TTS 模型卡 */
  async function loadAll() {
    try {
      const [cfg, voiceList, genie, models] = await Promise.all([
        api.tts.getConfig(),
        api.tts.listReferences(),
        api.tts.genieConfig(),
        api.ttsModel.list(),
      ])
      setConfig(cfg)
      setHasApiKey(cfg.hasApiKey)
      setVoices(voiceList)
      setGenieCfg(genie)
      setTtsModels(models)
    } catch (err) {
      console.error('加载 TTS 配置失败', err)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  /** 保存 TTS 配置 */
  const handleSaveConfig = async (patch: Partial<TTSConfig>) => {
    try {
      const next = await api.tts.saveConfig(patch)
      setConfig(next)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  /** 保存 Genie 配置 */
  const handleSaveGenie = async (patch: Partial<TTSGenieConfig>) => {
    if (!genieCfg) return
    try {
      const next = await api.tts.genieSaveConfig(patch)
      setGenieCfg(next)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  /** 检测 Genie 服务 */
  const handleCheckGenie = async () => {
    if (!genieCfg?.baseUrl?.trim()) {
      toast('请先填写服务地址', 'info')
      return
    }
    setChecking(true)
    setCheckResult(null)
    try {
      const r = await api.tts.genieCheck(genieCfg.baseUrl)
      setCheckResult(r.ok ? { ok: true, text: '连接成功，GenieTTS 服务在线。' } : { ok: false, text: r.error ?? '连接失败' })
    } catch (err) {
      setCheckResult({ ok: false, text: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setChecking(false)
    }
  }

  /** 用项目路径启动 Genie 服务（留空则用系统 python） */
  const handleStartGenie = async () => {
    setStarting(true)
    setCheckResult(null)
    try {
      const r = await api.tts.genieStart(genieCfg?.workPath ?? '', genieCfg?.dataDir ?? '')
      if (r.ok) {
        setCheckResult({
          ok: true,
          text: '已尝试启动服务。请稍候几秒后点击【检测连接】确认就绪。',
        })
      } else {
        setCheckResult({ ok: false, text: r.error ?? '启动失败' })
      }
    } catch (err) {
      setCheckResult({ ok: false, text: err instanceof Error ? err.message : '启动失败' })
    } finally {
      setStarting(false)
    }
  }

  /** 目录选择器 */
  const handleChooseFolder = async (field: 'dataDir') => {
    const p = await api.tts.chooseFolder()
    if (p) void handleSaveGenie({ [field]: p })
  }

  /** 保存 MiMo API Key */
  const handleSaveKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) {
      toast('请输入 API Key', 'info')
      return
    }
    setSavingKey(true)
    try {
      await api.tts.saveApiKey(key)
      setHasApiKey(true)
      setApiKeyInput('')
      toast('API Key 已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingKey(false)
    }
  }

  /** 导入参考音频（mimo） */
  const handleImport = async () => {
    setImporting(true)
    try {
      const result = await api.tts.importReference()
      if (result) {
        const { voice, warning } = result
        setVoices((prev) => [voice, ...prev])
        toast(`已导入「${voice.name}」`)
        if (warning) toast(warning, 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  /** 删除参考音频 */
  const handleRemove = async (id: string) => {
    try {
      await api.tts.removeReference(id)
      setVoices((prev) => prev.filter((v) => v.id !== id))
      toast('已删除')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const startRename = (voice: VoiceReference) => {
    setRenamingId(voice.id)
    setRenameInput(voice.name)
  }

  const handleRename = async () => {
    if (!renamingId) return
    const name = renameInput.trim()
    if (!name) {
      toast('名称不能为空', 'info')
      return
    }
    try {
      const updated = await api.tts.renameReference(renamingId, name)
      setVoices((prev) => prev.map((v) => (v.id === renamingId ? updated : v)))
      setRenamingId(null)
      toast('已重命名')
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  // ---- TTS 模型卡操作 ----

  /** 打开新建模型卡编辑器 */
  const handleNewModel = () => {
    setEditingModel(null)
    setEditor(EMPTY_EDITOR)
    setShowEditor(true)
  }

  /** 打开编辑模型卡编辑器 */
  const handleEditModel = (model: TTSModelCard) => {
    setEditingModel(model)
    setEditor({
      name: model.name,
      characterName: model.characterName,
      onnxModelDir: model.onnxModelDir,
      refAudioPath: model.refAudioPath,
      refAudioText: model.refAudioText,
    })
    setShowEditor(true)
  }

  /** 保存模型卡（新建或更新） */
  const handleSaveModel = async () => {
    if (!editor.name.trim()) {
      toast('请输入模型名称', 'info')
      return
    }
    if (!editor.onnxModelDir.trim()) {
      toast('请输入 onnx 模型目录', 'info')
      return
    }
    setSavingModel(true)
    try {
      // 模型名称即角色名
      const input = { ...editor, characterName: editor.name.trim() }
      if (editingModel) {
        const updated = await api.ttsModel.update(editingModel.id, input)
        setTtsModels((prev) => prev.map((m) => (m.id === editingModel.id ? updated : m)))
        toast('模型卡已更新')
      } else {
        const created = await api.ttsModel.create(input)
        setTtsModels((prev) => [...prev, created])
        toast('模型卡已创建')
      }
      setShowEditor(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingModel(false)
    }
  }

  /** 删除模型卡 */
  const handleDeleteModel = async (id: string) => {
    try {
      await api.ttsModel.delete(id)
      setTtsModels((prev) => prev.filter((m) => m.id !== id))
      if (selectedModelId === id) setSelectedModelId(null)
      toast('已删除')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  /** 模型卡编辑器中的目录/文件选择 */
  const handleEditorChooseFolder = async (field: 'onnxModelDir') => {
    const p = await api.tts.chooseFolder()
    if (p) setEditor((prev) => ({ ...prev, [field]: p }))
  }
  const handleEditorChooseAudio = async () => {
    const p = await api.tts.chooseAudioFile()
    if (p) setEditor((prev) => ({ ...prev, refAudioPath: p }))
  }

  /** 测试合成（Web Audio 试听，不驱动 Live2D） */
  const handleTest = async () => {
    const isGenie = config?.engine === 'genie'
    if (!isGenie && (!hasApiKey || !config?.model.trim() || voices.length === 0)) {
      toast('请先配置 API Key、模型并导入参考音频', 'info')
      return
    }
    if (isGenie) {
      if (!genieCfg?.baseUrl?.trim()) {
        toast('请先填写 GenieTTS 服务地址', 'info')
        return
      }
      const model = ttsModels.find((m) => m.id === selectedModelId)
      if (!model) {
        toast('请先选择一个 TTS 模型卡', 'info')
        return
      }
    }
    setTesting(true)
    setTestResult(null)
    try {
      const lang = config?.language ?? 'zh'
      const speakText = testText.trim() || TEST_TEXT_DEFAULTS[lang]
      const audio = await api.tts.synthesize({
        text: speakText,
        voiceId: isGenie ? null : voices[0]!.id,
        engine: isGenie ? 'genie' : 'mimo',
        genieOverride: isGenie && selectedModelId ? { ttsModelId: selectedModelId } : null,
      })
      if (!audio) {
        setTestResult({ ok: false, message: '合成返回空音频' })
        return
      }
      const audioCtx = new AudioContext()
      const audioBuffer = await audioCtx.decodeAudioData(audio.slice(0))
      const source = audioCtx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(audioCtx.destination)
      source.start()
      source.onended = () => audioCtx.close().catch(() => {})
      setTestResult({ ok: true, message: '合成成功，正在播放' })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : '合成失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!config || !genieCfg) return <Loading />

  const selectedModel = ttsModels.find((m) => m.id === selectedModelId)

  return (
    <div className="space-y-5">
      <PanelHeader
        title="语音合成"
        desc="本地声库(GenieTTS)语音由声库自带性格；也可切换到云端声音克隆。"
      />

      {/* 引擎切换 */}
      <Card>
        <Field label="语音引擎">
          <div className="flex gap-2">
            {([
              { value: 'genie', label: '本地声库' },
              { value: 'mimo', label: '云端声音克隆' },
            ] as const).map((o) => (
              <button
                key={o.value}
                onClick={() => void handleSaveConfig({ engine: o.value })}
                className={`rounded-[var(--radius-sm)] border px-4 py-2 text-sm transition-all ${
                  config.engine === o.value
                    ? 'border-brand bg-brand-gradient text-[var(--on-brand)] shadow-[0_0_12px_var(--primary-glow)]'
                    : 'border-border text-text-2 hover:border-border-strong hover:text-text'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>
      </Card>

      {/* 语言（双引擎共用） */}
      <Card>
        <div className="space-y-4">
          <Field label="输出语言" hint="中文/日文：Genie 引擎按角色声库能力朗读对应语言">
            <div className="flex gap-2">
              {(['zh', 'ja'] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => void handleSaveConfig({ language: lang as TTSLanguage })}
                  className={`rounded-[var(--radius-sm)] border px-4 py-2 text-sm transition-all ${
                    config.language === lang
                      ? 'border-brand bg-brand-gradient text-[var(--on-brand)] shadow-[0_0_12px_var(--primary-glow)]'
                      : 'border-border text-text-2 hover:border-border-strong hover:text-text'
                  }`}
                >
                  {lang === 'zh' ? '中文' : '日文'}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Card>

      {/* ==================== 本地声库(GenieTTS) ==================== */}
      {config.engine === 'genie' && (
        <>
          {/* GenieTTS 服务配置 */}
          <Card>
            <div className="mb-3">
              <span className="text-[13px] font-medium text-text-2">GenieTTS 服务配置</span>
              <p className="mt-0.5 text-xs text-text-muted">
                配置 GenieTTS 服务地址与环境，应用可自动拉起服务并合成。
              </p>
            </div>

            <div className="space-y-3">
              <Field label="服务地址" hint="Genie-TTS start_server 默认监听 127.0.0.1:8000">
                <Input
                  value={genieCfg.baseUrl}
                  onChange={(e) => void handleSaveGenie({ baseUrl: e.target.value.trim() })}
                  placeholder="http://127.0.0.1:8000"
                />
              </Field>
              <Field label="GenieTTS 环境/项目目录" hint="含 python.exe 的目录（装了 genie-tts）；留空则用系统 python 启动服务">
                <div className="flex gap-2">
                  <Input
                    value={genieCfg.workPath}
                    onChange={(e) => void handleSaveGenie({ workPath: e.target.value })}
                    placeholder="例如 E:\Genie_TTS_GUI（可留空）"
                  />
                  <Button variant="outline" onClick={() => void handleStartGenie()} disabled={starting}>
                    <Rocket size={14} strokeWidth={2.25} />
                    {starting ? '启动中…' : '启动服务'}
                  </Button>
                </div>
              </Field>
              <Field label="GenieData 资源目录" hint="genie-tts 运行所需资源。请从 https://github.com/High-Logic/Genie-TTS 下载后放置于此目录">
                <div className="flex gap-2">
                  <Input
                    value={genieCfg.dataDir}
                    onChange={(e) => void handleSaveGenie({ dataDir: e.target.value })}
                    placeholder="例如 E:\GenieData（可留空=环境目录下 GenieData）"
                  />
                  <Button variant="outline" onClick={() => void handleChooseFolder('dataDir')} title="选择目录">
                    <FolderOpen size={14} strokeWidth={2.25} />
                    目录
                  </Button>
                </div>
              </Field>

              <div className="flex items-center justify-start gap-2">
                <Button variant="outline" onClick={() => void handleCheckGenie()} disabled={checking}>
                  <PlugZap size={14} strokeWidth={2.25} />
                  {checking ? '检测中…' : '检测连接'}
                </Button>
              </div>

              {checkResult && (
                <div
                  className={`rounded-[var(--radius-sm)] border px-3 py-2 text-xs ${
                    checkResult.ok ? 'border-success/30 bg-success/5 text-success' : 'border-danger/30 bg-danger/5 text-danger'
                  }`}
                >
                  {checkResult.text}
                </div>
              )}
            </div>
          </Card>

          {/* 角色 TTS 模型卡 */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <span className="text-[13px] font-medium text-text-2">角色 TTS 模型</span>
                <p className="mt-0.5 text-xs text-text-muted">管理本地声库的角色模型，选中后可用于测试合成</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleNewModel()}>
                <Plus size={14} strokeWidth={2.25} />
                添加模型
              </Button>
            </div>

            {ttsModels.length === 0 ? (
              <div className="rounded-[var(--radius-md)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-muted">
                还没有角色 TTS 模型，点击上方按钮添加
              </div>
            ) : (
              <div className="space-y-2">
                {ttsModels.map((model) => (
                  <div
                    key={model.id}
                    onClick={() => setSelectedModelId(model.id === selectedModelId ? null : model.id)}
                    className={`flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 cursor-pointer transition-all ${
                      model.id === selectedModelId
                        ? 'border-brand bg-brand/5 shadow-[0_0_8px_var(--primary-glow)]'
                        : 'border-border bg-surface-2/50 hover:border-border-strong'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{model.name}</span>
                      <span className="text-[10px] text-text-muted">
                        角色名: {model.characterName}
                        {model.onnxModelDir && ` · onnx: ${model.onnxModelDir.split(/[\\/]/).pop()}`}
                        {model.refAudioPath && ' · 有参考音频'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleEditModel(model) }}
                      title="编辑"
                      className="rounded p-1 text-text-muted hover:text-text hover:bg-card-hover"
                    >
                      <Pencil size={13} strokeWidth={1.75} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleDeleteModel(model.id) }}
                      title="删除"
                      className="rounded p-1 text-text-muted hover:text-danger hover:bg-danger/10"
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {selectedModel && (
              <div className="mt-3 rounded-[var(--radius-sm)] border border-info/30 bg-info/5 px-3 py-2 text-[11px] leading-relaxed text-text-muted">
                <span className="font-medium text-info">当前选中：</span> {selectedModel.name}（{selectedModel.characterName}）
              </div>
            )}
          </Card>
        </>
      )}

      {/* ==================== 云端引擎：MiMo ==================== */}
      {config.engine === 'mimo' && (
        <>
          {/* MiMo API Key */}
          <Card>
            <Field label="MiMo API Key" hint="仅用于访问小米 MiMo voiceclone 模型，与 LLM API Key 隔离加密存储。">
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={hasApiKey ? '已配置（留空则保持不变）' : 'sk-xxx...'}
                />
                <Button onClick={() => void handleSaveKey()} disabled={savingKey}>
                  {savingKey ? '保存中…' : '保存'}
                </Button>
              </div>
            </Field>
            {hasApiKey && (
              <div className="mt-2 flex items-center gap-1 text-xs text-success">
                <CheckCircle2 size={14} strokeWidth={2} />
                <span>API Key 已配置</span>
              </div>
            )}
          </Card>

          {/* MiMo 模型名 */}
          <Card>
            <Field label="模型（model）" hint="小米 MiMo TTS 模型名，如 mimo-v2.5-tts-voiceclone（声音克隆）">
              <Input
                value={config.model}
                onChange={(e) => void handleSaveConfig({ model: e.target.value })}
                placeholder="mimo-v2.5-tts-voiceclone"
              />
            </Field>
          </Card>

          {/* 参考音频管理 */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <span className="text-[13px] font-medium text-text-2">参考音频</span>
                <p className="mt-0.5 text-xs text-text-muted">建议 5-30 秒干净人声，wav / mp3 格式</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleImport()} disabled={importing}>
                <Plus size={14} strokeWidth={2.25} />
                {importing ? '导入中…' : '导入参考音频'}
              </Button>
            </div>

            <div className="mb-3 rounded-[var(--radius-sm)] border border-info/30 bg-info/5 px-3 py-2 text-[11px] leading-relaxed text-text-muted">
              <span className="font-medium text-info">提升克隆相似度的建议：</span>
              <br />
              1. 使用 5-30 秒的纯净人声录音（无背景音乐、无噪声）
              <br />
              2. 录音内容应包含目标音色常见的发音特征（语调、节奏）
              <br />
              3. 音量适中，避免削波失真；推荐 wav 格式以获得最佳效果
            </div>

            {voices.length === 0 ? (
              <div className="rounded-[var(--radius-md)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-muted">
                还没有导入参考音频
              </div>
            ) : (
              <div className="space-y-2">
                {voices.map((voice) => {
                  const duration = voice.durationSec
                  const durationWarn = duration > 0 && (duration < 5 || duration > 30)
                  return (
                    <div
                      key={voice.id}
                      className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-surface-2/50 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        {renamingId === voice.id ? (
                          <div className="flex gap-2">
                            <Input
                              value={renameInput}
                              onChange={(e) => setRenameInput(e.target.value)}
                              className="h-7 py-1 text-xs"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleRename()
                                if (e.key === 'Escape') setRenamingId(null)
                              }}
                            />
                            <Button size="sm" onClick={() => void handleRename()}>确定</Button>
                          </div>
                        ) : (
                          <>
                            <span className="block truncate text-sm text-text">{voice.name}</span>
                            <span className={`text-[10px] ${durationWarn ? 'text-warning' : 'text-text-muted'}`}>
                              {voice.filePath.split('.').pop()?.toUpperCase()}
                              {duration > 0 && ` · ${duration.toFixed(1)}s${durationWarn ? '（建议 5-30s）' : ''}`}
                              {' · '}导入于 {new Date(voice.createdAt).toLocaleDateString()}
                            </span>
                          </>
                        )}
                      </div>
                      <button
                        onClick={() => startRename(voice)}
                        title="重命名"
                        className="rounded p-1 text-text-muted hover:text-text hover:bg-card-hover"
                      >
                        <Pencil size={13} strokeWidth={1.75} />
                      </button>
                      <button
                        onClick={() => void handleRemove(voice.id)}
                        title="删除"
                        className="rounded p-1 text-text-muted hover:text-danger hover:bg-danger/10"
                      >
                        <Trash2 size={13} strokeWidth={1.75} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {/* 测试合成 */}
      <Card>
        <div className="mb-3">
          <span className="text-[13px] font-medium text-text-2">测试合成</span>
          <p className="mt-0.5 text-xs text-text-muted">测试文本可编辑；留空按当前语言使用默认文本。</p>
        </div>
        <Input
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder={TEST_TEXT_DEFAULTS[config.language]}
          className="mb-3"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {config.engine === 'genie'
              ? selectedModel ? `本地声库：${selectedModel.name}` : '请先选择一个 TTS 模型卡'
              : '云端引擎：使用第一条参考音频合成'}
          </span>
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} strokeWidth={2} />}
            {testing ? '合成中…' : '测试'}
          </Button>
        </div>
        {testResult && (
          <div
            className={`mt-3 flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs ${
              testResult.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
            }`}
          >
            {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span>{testResult.message}</span>
          </div>
        )}
      </Card>

      {/* 模型卡编辑器 Modal */}
      <Modal
        open={showEditor}
        onClose={() => setShowEditor(false)}
        title={editingModel ? '编辑 TTS 模型' : '新建 TTS 模型'}
        width={380}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowEditor(false)}>取消</Button>
            <Button onClick={() => void handleSaveModel()} disabled={savingModel}>
              {savingModel ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="模型名称" hint="GenieTTS 角色名，对应 onnx 模型">
            <Input
              value={editor.name}
              onChange={(e) => setEditor((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如：莉可"
            />
          </Field>
          <Field label="onnx 模型目录" hint="包含该角色转换后 *.onnx 的目录">
            <div className="flex gap-2">
              <Input
                value={editor.onnxModelDir}
                onChange={(e) => setEditor((prev) => ({ ...prev, onnxModelDir: e.target.value }))}
                placeholder="例如 E:\Genie_TTS_GUI\onnx\角色名"
              />
              <Button variant="outline" onClick={() => void handleEditorChooseFolder('onnxModelDir')} title="选择目录">
                <FolderOpen size={14} strokeWidth={2.25} />
                目录
              </Button>
            </div>
          </Field>
          <Field label="参考音频路径（可选）" hint="用于语气/情绪素材；留空则用声库默认音色">
            <div className="flex gap-2">
              <Input
                value={editor.refAudioPath}
                onChange={(e) => setEditor((prev) => ({ ...prev, refAudioPath: e.target.value }))}
                placeholder="角色参考音频.wav（可选）"
              />
              <Button variant="outline" onClick={() => void handleEditorChooseAudio()} title="选择音频文件">
                <FileAudio size={14} strokeWidth={2.25} />
                文件
              </Button>
            </div>
          </Field>
          <Field label="参考音频对应文本（可选）">
            <Input
              value={editor.refAudioText}
              onChange={(e) => setEditor((prev) => ({ ...prev, refAudioText: e.target.value }))}
              placeholder="参考音频说出的话（可选）"
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

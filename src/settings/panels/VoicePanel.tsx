/**
 * 语音合成配置面板。
 * 功能：
 * - MiMo API Key 配置（加密存储，与 LLM Key 隔离）
 * - 输出语言切换：中文 / 日文
 * - 自动播放开关
 * - 参考音频管理：导入 / 重命名 / 删除
 * - 测试合成：用首条参考音频试听
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, Play, Plus, Trash2, XCircle, Pencil } from 'lucide-react'
import { api } from '../../api'
import type { TTSConfig, VoiceReference, TTSLanguage } from '../../types'
import { Button, Card, Field, Input, Loading, Switch, Select, PanelHeader } from '../../components/ui'
import { toast } from '../../components/toast'

export function VoicePanel() {
  const [config, setConfig] = useState<TTSConfig | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [voices, setVoices] = useState<VoiceReference[]>([])
  const [savingKey, setSavingKey] = useState(false)
  const [importing, setImporting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')

  /** 加载 TTS 配置和参考音频列表 */
  async function loadAll() {
    try {
      const [cfg, voiceList] = await Promise.all([
        api.tts.getConfig(),
        api.tts.listReferences(),
      ])
      setConfig({ language: cfg.language, autoPlay: cfg.autoPlay, model: cfg.model })
      setHasApiKey(cfg.hasApiKey)
      setVoices(voiceList)
    } catch (err) {
      console.error('加载 TTS 配置失败', err)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

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

  /** 保存 TTS 配置（语言、自动播放） */
  const handleSaveConfig = async (patch: Partial<TTSConfig>) => {
    try {
      const next = await api.tts.saveConfig(patch)
      setConfig(next)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  /** 导入参考音频 */
  const handleImport = async () => {
    setImporting(true)
    try {
      const result = await api.tts.importReference()
      if (result) {
        const { voice, warning } = result
        setVoices((prev) => [voice, ...prev])
        toast(`已导入「${voice.name}」`)
        // 显示克隆质量警告（时长不在 5-30s 推荐范围时）
        if (warning) {
          toast(warning, 'info')
        }
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

  /** 开始重命名 */
  const startRename = (voice: VoiceReference) => {
    setRenamingId(voice.id)
    setRenameInput(voice.name)
  }

  /** 确认重命名 */
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

  /** 测试合成：使用第一张参考音频合成一句示例文本 */
  const handleTest = async () => {
    if (voices.length === 0) {
      toast('请先导入参考音频', 'info')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const audio = await api.tts.synthesize({
        text: '你好，今天天气真好。',
        voiceId: voices[0]!.id,
      })
      if (!audio) {
        setTestResult({ ok: false, message: '合成返回空音频' })
        return
      }
      // 使用 Web Audio API 播放测试音频（不驱动 Live2D，仅试听）
      const audioCtx = new AudioContext()
      const audioBuffer = await audioCtx.decodeAudioData(audio.slice(0))
      const source = audioCtx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(audioCtx.destination)
      source.start()
      source.onended = () => {
        audioCtx.close().catch(() => {})
      }
      setTestResult({ ok: true, message: '合成成功，正在播放' })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : '合成失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!config) return <Loading />

  return (
    <div className="space-y-5">
      <PanelHeader
        title="语音合成"
        desc="基于小米 MiMo 声音克隆模型，上传参考音频即可生成克隆声音并驱动桌宠口型同步。"
      />

      {/* MiMo API Key */}
      <Card>
        <Field
          label="MiMo API Key"
          hint="仅用于访问小米 MiMo voiceclone 模型，与 LLM API Key 隔离加密存储。"
        >
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

      {/* 模型 */}
      <Card>
        <Field label="模型（model）" hint="小米 MiMo TTS 模型名，如 mimo-v2.5-tts-voiceclone（声音克隆）">
          <Input
            value={config.model}
            onChange={(e) => void handleSaveConfig({ model: e.target.value })}
            placeholder="mimo-v2.5-tts-voiceclone"
          />
        </Field>
      </Card>

      {/* 语言与自动播放 */}
      <Card>
        <div className="space-y-4">
          <Field label="输出语言" hint="中文：默认按文本语言合成；日文：附加日文指令确保用日语输出">
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

          <div className="flex items-center justify-between">
            <div>
              <span className="text-[13px] font-medium text-text-2">自动播放</span>
              <p className="mt-0.5 text-xs text-text-muted">AI 回复完成后自动合成并播放语音</p>
            </div>
            <Switch
              checked={config.autoPlay}
              onChange={(checked) => void handleSaveConfig({ autoPlay: checked })}
            />
          </div>
        </div>
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

        {/* 克隆质量优化提示 */}
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
              // 时长质量判断：wav 且有时长则检查是否在推荐范围
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

      {/* 测试合成 */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px] font-medium text-text-2">测试合成</span>
            <p className="mt-0.5 text-xs text-text-muted">使用第一条参考音频合成「你好，今天天气真好。」</p>
          </div>
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing || !hasApiKey || !config.model.trim() || voices.length === 0}>
            <Play size={14} strokeWidth={2} />
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
    </div>
  )
}

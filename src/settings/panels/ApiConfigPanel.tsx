/**
 * AI API 配置面板。
 * 安全要点：
 *   - apiKey 输入框仅回显掩码（已配置时占位符为 sk-****），不回显明文
 *   - Key 单独走 saveApiKey 加密通道落盘；留空则保持不变
 *   - 测试连接：发一条极简请求验证配置
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { api } from '../../api'
import { useSettingsStore } from '../../store/settingsStore'
import { Button, Card, Field, Input, Loading, Switch } from '../../components/ui'
import { toast } from '../../components/toast'

export function ApiConfigPanel() {
  const { settings, hasApiKey, loaded, load, save, markKeyConfigured } = useSettingsStore()

  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const handleSave = async () => {
    setSaving(true)
    try {
      if (apiKey.trim()) {
        await api.settings.saveApiKey(apiKey.trim())
        markKeyConfigured() // 刷新掩码占位符与提示
      }
      await save({
        baseURL: settings.baseURL.trim(),
        model: settings.model.trim(),
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.8,
        maxTokens: Math.max(1, Math.round(Number(settings.maxTokens) || 1024)),
        stream: settings.stream,
        contextWindowTokens: Math.max(0, Math.round(Number(settings.contextWindowTokens) || 0)),
        enableAutoCompact: settings.enableAutoCompact,
        userName: settings.userName.trim() || '用户',
      })
      setApiKey('')
      toast('设置已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.ai.testConnection()
      setTestResult(res.ok ? { ok: true, message: '连接成功' } : { ok: false, message: res.error ?? '连接失败' })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!loaded) return <Loading />

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <Field label="API 地址（baseURL）" hint="填写兼容 OpenAI 格式的接口地址，如 https://api.openai.com/v1">
          <Input
            value={settings.baseURL}
            onChange={(e) => save({ baseURL: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <Field
          label="API Key"
          hint={
            hasApiKey
              ? '已配置（sk-****）。留空保持不变；填写新值将替换原 Key（加密存储，不会回显明文）。'
              : '以 Bearer 方式发送，经系统安全存储（DPAPI）加密后落盘。'
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? 'sk-****（已配置）' : 'sk-...'}
            autoComplete="off"
          />
        </Field>

        <Field label="模型（model）" hint="如 gpt-4o-mini / deepseek-chat 等，需与 API 兼容">
          <Input value={settings.model} onChange={(e) => save({ model: e.target.value })} placeholder="gpt-4o-mini" />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="温度（temperature）">
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={settings.temperature}
              onChange={(e) => save({ temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label="最大输出 token（maxTokens）">
            <Input
              type="number"
              min={1}
              value={settings.maxTokens}
              onChange={(e) => {
                const v = Number(e.target.value)
                // 清空输入时 Number('')===0，会误存 0 导致请求失败 → 忽略非法值
                if (e.target.value.trim() !== '' && Number.isFinite(v)) save({ maxTokens: Math.max(1, v) })
              }}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
          <div>
            <div className="text-sm text-text">流式输出</div>
            <div className="text-xs text-text-muted">启用后聊天消息逐字显示（打字机效果）</div>
          </div>
          <Switch checked={settings.stream} onChange={(v) => save({ stream: v })} />
        </div>

        {/* 上下文管理（A1/A2）：按 Token 预算装填历史 + 自动摘要压缩 */}
        <div className="space-y-4 border-t border-border pt-4">
          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
            <div className="text-sm text-text">模型上下文窗口（tokens）</div>
            <Input
              className="w-full"
              type="number"
              min={0}
              step={1024}
              value={settings.contextWindowTokens}
              onChange={(e) => {
                const v = Number(e.target.value)
                // 清空/非法输入时忽略，避免误存
                if (e.target.value.trim() !== '' && Number.isFinite(v)) save({ contextWindowTokens: Math.max(0, v) })
              }}
            />
            <div className="text-xs text-text-muted">
              历史按此预算从近到远装填；0 = 不限制（关闭自动收窄）。常见：32768 / 131072 / 1M
            </div>
          </div>

          <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
            <div>
              <div className="text-sm text-text">自动压缩历史</div>
              <div className="text-xs text-text-muted">
                上下文超阈值时，把较早对话交给模型生成摘要（落盘复用），保留最近 20 条原文；会额外消耗一次模型调用
              </div>
            </div>
            <Switch checked={settings.enableAutoCompact} onChange={(v) => save({ enableAutoCompact: v })} />
          </div>
        </div>
      </Card>

      {testResult && (
        <div
          className={`flex items-center gap-2 rounded-[var(--radius-md)] border px-4 py-2 text-sm ${
            testResult.ok
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {testResult.ok ? <CheckCircle2 size={15} strokeWidth={1.75} /> : <XCircle size={15} strokeWidth={1.75} />}
          {testResult.ok ? '连接成功' : testResult.message}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void handleTest()} disabled={testing || !hasApiKey}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
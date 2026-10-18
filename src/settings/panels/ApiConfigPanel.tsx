/**
 * AI API 配置面板：三个独立折叠配置块（主模型 / 辅助模型 / 视觉模型），各自带"测试连接"与"保存"。
 *  - 主模型（必填）：主对话链（地址/Key/模型/温度/maxTokens/流式/上下文管理）
 *  - 辅助模型（可选）：翻译/结构修复/情景摘要等机械型文本任务；留空回落主模型
 *  - 视觉模型（可选）：屏幕感知/立绘打标两类图像理解任务；需支持图像输入，留空则相关功能不启用（不回落主模型）
 * 安全要点：
 *  - 三个 API Key 均仅回显掩码（已配置时占位符为 sk-****），不回显明文
 *  - Key 各走独立加密通道落盘（DPAPI/safeStorage）；输入留空 = 保持不变
 *  - 测试连接按 profile（main/aux/vision）测试各自回落后的生效配置
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, Cpu, Eye, XCircle, Zap } from 'lucide-react'
import { api } from '../../api'
import { useSettingsStore } from '../../store/settingsStore'
import { AccordionItem, Button, Field, Input, Loading, Switch } from '../../components/ui'
import { toast } from '../../components/toast'

/** 测试对象 profile（与主进程 ai:test-connection 的参数对应） */
type TestProfile = 'main' | 'aux' | 'vision'
/** 单块测试结果 */
interface TestResult {
  ok: boolean
  message: string
}

/** 测试结果显示条（成功绿/失败红，三块复用） */
function TestResultView({ result }: { result: TestResult | undefined }) {
  if (!result) return null
  return (
    <div
      className={`flex items-center gap-2 rounded-[var(--radius-md)] border px-4 py-2 text-sm ${
        result.ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-danger/30 bg-danger/10 text-danger'
      }`}
    >
      {result.ok ? <CheckCircle2 size={15} strokeWidth={1.75} /> : <XCircle size={15} strokeWidth={1.75} />}
      {result.ok ? '连接成功' : result.message}
    </div>
  )
}

export function ApiConfigPanel() {
  const { settings, hasApiKey, loaded, load, save, markKeyConfigured } = useSettingsStore()

  // 主模型：Key 输入（回显掩码，不回显明文）与保存中状态
  const [apiKey, setApiKey] = useState('')
  const [savingMain, setSavingMain] = useState(false)
  // 辅助模型：独立 Key + 保存中状态
  const [translationKeyInput, setTranslationKeyInput] = useState('')
  const [hasTranslationKey, setHasTranslationKey] = useState(false)
  const [savingAux, setSavingAux] = useState(false)
  // 视觉模型：独立 Key + 保存中状态
  const [visionKeyInput, setVisionKeyInput] = useState('')
  const [hasVisionKey, setHasVisionKey] = useState(false)
  const [savingVision, setSavingVision] = useState(false)
  // 测试连接：进行中的 profile + 各块结果（互不覆盖）
  const [testing, setTesting] = useState<TestProfile | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<TestProfile, TestResult>>>({})

  useEffect(() => {
    if (!loaded) void load()
    void api.settings.hasTranslationApiKey().then(setHasTranslationKey).catch(() => {})
    void api.settings.hasVisionApiKey().then(setHasVisionKey).catch(() => {})
  }, [loaded, load])

  /** 测试连接（按 profile 测各自回落后的生效配置；辅助未配置时主进程回落测主模型） */
  const handleTest = async (profile: TestProfile) => {
    setTesting(profile)
    try {
      const res = await api.ai.testConnection(profile)
      setTestResults((r) => ({ ...r, [profile]: res.ok ? { ok: true, message: '连接成功' } : { ok: false, message: res.error ?? '连接失败' } }))
    } catch (err) {
      setTestResults((r) => ({ ...r, [profile]: { ok: false, message: err instanceof Error ? err.message : '连接失败' } }))
    } finally {
      setTesting(null)
    }
  }

  /** 保存主模型块：主字段 + 可选新主 Key（留空保持不变，加密存储不回显明文） */
  const handleSaveMain = async () => {
    setSavingMain(true)
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
      toast('主模型设置已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingMain(false)
    }
  }

  /** 保存辅助模型块（仅辅助模型两个字段；Key 走独立通道单独保存） */
  const handleSaveAux = async () => {
    setSavingAux(true)
    try {
      await save({ translationBaseURL: settings.translationBaseURL.trim(), translationModel: settings.translationModel.trim() })
      toast('辅助模型设置已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingAux(false)
    }
  }

  /** 保存视觉模型块（仅视觉模型两个字段；Key 走独立通道单独保存） */
  const handleSaveVision = async () => {
    setSavingVision(true)
    try {
      await save({ visionBaseURL: settings.visionBaseURL.trim(), visionModel: settings.visionModel.trim() })
      toast('视觉模型设置已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingVision(false)
    }
  }

  /** 保存辅助模型独立 API Key（留空 = 保持不变，与主 LLM Key 同样的加密通道） */
  const handleSaveTranslationKey = async () => {
    const key = translationKeyInput.trim()
    if (!key) {
      toast('请输入 Key（留空则保持不变）')
      return
    }
    await api.settings.saveTranslationApiKey(key)
    setTranslationKeyInput('')
    setHasTranslationKey(await api.settings.hasTranslationApiKey())
    toast('辅助模型 API Key 已保存')
  }

  /** 保存视觉模型独立 API Key（留空 = 保持不变，与主 LLM Key 同样的加密通道） */
  const handleSaveVisionKey = async () => {
    const key = visionKeyInput.trim()
    if (!key) {
      toast('请输入 Key（留空则保持不变）')
      return
    }
    await api.settings.saveVisionApiKey(key)
    setVisionKeyInput('')
    setHasVisionKey(await api.settings.hasVisionApiKey())
    toast('视觉模型 API Key 已保存')
  }

  if (!loaded) return <Loading />

  return (
    <div className="space-y-4">
      {/* ===== 主模型（主对话链，必填） ===== */}
      <AccordionItem title="主模型" icon={<Cpu size={15} strokeWidth={1.75} />} defaultOpen>
        <div className="space-y-4">
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

          <Field label="模型（model）" hint="如 gpt-4o-mini等，需与 API 兼容">
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

          {/* 上下文管理（A1/A2）：主对话链参数，归属主模型块 */}
          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
              <div className="text-sm text-text">历史消息预算（tokens）</div>
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
                控制发送给模型的历史消息总量上限。超出时自动裁剪较早对话，避免超过模型上下文限制。
                设置为 0 表示不限制（由模型自身限制）。建议值：模型上下文窗口的 70%-80%（为 system prompt 和回复预留空间）。
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

          <TestResultView result={testResults.main} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void handleTest('main')} disabled={testing !== null || !hasApiKey}>
              {testing === 'main' ? '测试中…' : '测试连接'}
            </Button>
            <Button onClick={() => void handleSaveMain()} disabled={savingMain}>
              {savingMain ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </AccordionItem>

      {/* ===== 辅助模型（翻译/结构修复/情景摘要，可选，留空回落主模型） ===== */}
      <AccordionItem title="辅助模型（翻译 / 结构修复 / 情景摘要）（可选）" icon={<Zap size={15} strokeWidth={1.75} />} defaultOpen={false}>
        <div className="space-y-3">
          <div className="text-xs leading-relaxed text-text-muted">
            日语翻译、JSON 修复与情景摘要更新都是机械型小任务：前两者串行在语音首响路径上，情景摘要在每轮
            结束后后台异步更新。建议配置非思考的快速小模型（如 gemini-flash / qwen-turbo / deepseek-chat），
            留空则使用主对话模型
          </div>
          <Input
            value={settings.translationBaseURL}
            onChange={(e) => save({ translationBaseURL: e.target.value })}
            placeholder="辅助模型 API 地址（如 https://api.example.com/v1，留空使用主模型 API 地址）"
          />
          <Input
            value={settings.translationModel}
            onChange={(e) => save({ translationModel: e.target.value })}
            placeholder="辅助模型名（如 gemini-2.0-flash，留空使用主模型）"
          />
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={translationKeyInput}
              onChange={(e) => setTranslationKeyInput(e.target.value)}
              placeholder={hasTranslationKey ? 'sk-****（已配置，留空保持不变）' : '辅助模型 API Key（留空使用主 Key）'}
              className="min-w-0 flex-1"
            />
            <Button variant="outline" onClick={() => void handleSaveTranslationKey()} disabled={!translationKeyInput.trim()}>
              保存 Key
            </Button>
          </div>
          <TestResultView result={testResults.aux} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void handleTest('aux')} disabled={testing !== null}>
              {testing === 'aux' ? '测试中…' : '测试连接'}
            </Button>
            <Button onClick={() => void handleSaveAux()} disabled={savingAux}>
              {savingAux ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </AccordionItem>

      {/* ===== 视觉模型（屏幕感知/立绘打标，可选；独立必填不回落） ===== */}
      <AccordionItem title="视觉模型（屏幕感知 / 立绘打标 用，可选）" icon={<Eye size={15} strokeWidth={1.75} />} defaultOpen={false}>
        <div className="space-y-3">
          <div className="text-xs leading-relaxed text-text-muted">
            用于屏幕感知（角色"偷看"桌面转述话题）与立绘集 AI 视觉打标两类图像理解任务，
            需选择支持图像输入的多模态模型（如 gemini-flash / qwen-vl / gpt-4o-mini）。
            留空则相关功能不启用：屏幕感知自动降级为普通话题，立绘打标不可用
          </div>
          <Input
            value={settings.visionBaseURL}
            onChange={(e) => save({ visionBaseURL: e.target.value })}
            placeholder="视觉模型 API 地址（OpenAI 兼容 chat/completions，需支持图片输入）"
          />
          <Input
            value={settings.visionModel}
            onChange={(e) => save({ visionModel: e.target.value })}
            placeholder="视觉模型名（如 qwen-vl-plus / gpt-4o-mini）"
          />
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={visionKeyInput}
              onChange={(e) => setVisionKeyInput(e.target.value)}
              placeholder={hasVisionKey ? 'sk-****（已配置，留空保持不变）' : '视觉模型 API Key（独立于主 Key）'}
              className="min-w-0 flex-1"
            />
            <Button variant="outline" onClick={() => void handleSaveVisionKey()} disabled={!visionKeyInput.trim()}>
              保存 Key
            </Button>
          </div>
          <TestResultView result={testResults.vision} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void handleTest('vision')} disabled={testing !== null}>
              {testing === 'vision' ? '测试中…' : '测试连接'}
            </Button>
            <Button onClick={() => void handleSaveVision()} disabled={savingVision}>
              {savingVision ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </AccordionItem>
    </div>
  )
}

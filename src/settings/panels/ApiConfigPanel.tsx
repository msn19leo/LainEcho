/**
 * AI API 配置面板（档案制，2026-10-19）：全局「服务商档案库」+ 四类模型各自激活一个档案。
 *  - 档案 = 「名称 + API 地址 + 模型名 + Key」的可复用组合，集中管理、多处引用；
 *  - 主模型（必填）/辅助模型（可选，未启用回落主模型）/视觉模型（可选，不回落）各自下拉选择激活档案；
 *    嵌入模型的选择在「记忆体」面板（同一档案库）；
 *  - Key 安全：按档案独立加密落盘（safeStorage/DPAPI），仅回显掩码（hasKey），明文不出主进程；
 *  - 测试连接按「回落后生效配置」发极简请求（辅助未启用时回落主模型激活档案）。
 */
import { useEffect, useState } from 'react'
import { Check, CheckCircle2, ChevronDown, Cpu, Eye, Pencil, Plus, RefreshCw, Trash2, XCircle, Zap } from 'lucide-react'
import { api } from '../../api'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../store/settingsStore'
import { AccordionItem, Button, ConfirmModal, Field, Input, Loading, Modal, Switch } from '../../components/ui'
import { SelectMenu } from '../../components/DropdownMenu'
import { toast } from '../../components/toast'
import type { ApiProfile } from '../../types'

/** 测试对象 profile（与主进程 ai:test-connection 的参数对应） */
type TestProfile = 'main' | 'aux' | 'vision'
/** 单块测试结果 */
interface TestResult {
  ok: boolean
  message: string
}

/** 档案编辑器状态：create = 新建；edit = 编辑已有档案 */
type EditorState = { mode: 'create' } | { mode: 'edit'; profile: ApiProfile } | null

/** 测试结果显示条（成功绿/失败红，三块复用） */
function TestResultView({ result }: { result: TestResult | undefined }) {
  if (!result) return null
  return (
    <div
      className={`flex items-start gap-2 rounded-[var(--radius-md)] border px-4 py-2 text-sm ${
        result.ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-danger/30 bg-danger/10 text-danger'
      }`}
    >
      <span className="mt-0.5 shrink-0">
        {result.ok ? <CheckCircle2 size={15} strokeWidth={1.75} /> : <XCircle size={15} strokeWidth={1.75} />}
      </span>
      {/* 错误里常带原始 JSON（无空格长串），必须允许任意位置断行，否则会横向撑破容器 */}
      <span className="min-w-0 break-all whitespace-pre-wrap">
        {result.ok ? '连接成功' : result.message}
      </span>
    </div>
  )
}

/** 档案下拉选项文案：名称 · 模型名（未配 Key 追加提示） */
function profileLabel(p: ApiProfile): string {
  const model = p.model.trim() || '未填模型'
  return `${p.name} · ${model}${p.hasKey ? '' : '（未配 Key）'}`
}

/** 「未启用/未配置」占位选项 */
const OFF_OPTION = { value: '', label: '未配置' }
/** 辅助模型的关闭选项（语义 = 回落主模型激活档案） */
const AUX_OFF_OPTION = { value: '', label: '未启用（回落主模型）' }

export function ApiConfigPanel() {
  const { settings, loaded, load, refresh, save } = useSettingsStore()
  const profiles = settings.profiles ?? []

  // 档案编辑器（Modal）与删除确认
  const [editor, setEditor] = useState<EditorState>(null)
  const [formName, setFormName] = useState('')
  const [formBaseURL, setFormBaseURL] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formKey, setFormKey] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [deleting, setDeleting] = useState<ApiProfile | null>(null)

  // 获取可用模型（OpenAI 兼容 /models）：列表展示在模型输入框下方，点击条目回填后收起
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelOptions, setModelOptions] = useState<string[] | null>(null)
  /** 模型下拉列表展开态：▼ 按钮切换，选择条目后自动收起 */
  const [modelListOpen, setModelListOpen] = useState(false)

  // 测试连接：进行中的 profile + 各块结果（互不覆盖）
  const [testing, setTesting] = useState<TestProfile | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<TestProfile, TestResult>>>({})

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  /** 打开档案编辑器（新建 = 空表单；编辑 = 回填档案本体，Key 恒留空待输入） */
  const openEditor = (state: EditorState) => {
    setEditor(state)
    setFormName(state?.mode === 'edit' ? state.profile.name : '')
    setFormBaseURL(state?.mode === 'edit' ? state.profile.baseURL : '')
    setFormModel(state?.mode === 'edit' ? state.profile.model : '')
    setFormKey('')
    setModelOptions(null)
    setModelListOpen(false)
  }

  /**
   * 获取可用模型（OpenAI 兼容 /models）：baseURL 恒用表单现值（用户可能改了未保存）；
   * Key = 表单现值优先，编辑态留空时主进程按 profileId 读存储密钥（明文不出主进程）
   */
  const handleFetchModels = async () => {
    if (!editor) return
    if (!formBaseURL.trim()) return toast('请先填写 API 地址（baseURL）', 'error')
    setFetchingModels(true)
    try {
      const list = await api.settings.listModels({
        profileId: editor.mode === 'edit' ? editor.profile.id : undefined,
        baseURL: formBaseURL,
        key: formKey.trim() || undefined,
      })
      setModelOptions(list)
      setModelListOpen(true)
      toast(`已获取 ${list.length} 个可用模型`)
    } catch (err) {
      toast(err instanceof Error ? err.message : '获取模型列表失败', 'error')
    } finally {
      setFetchingModels(false)
    }
  }

  /** 保存档案（upsert；Key 输入留空 = 编辑时保持原 Key 不变），成功后刷新掩码回显 */
  const handleSaveProfile = async () => {
    if (!editor) return
    if (!formName.trim()) return toast('请填写档案名称', 'error')
    if (!formBaseURL.trim()) return toast('请填写 API 地址（baseURL）', 'error')
    if (!formModel.trim()) return toast('请填写模型名（model）', 'error')
    setSavingProfile(true)
    try {
      await api.settings.saveProfile({
        id: editor.mode === 'edit' ? editor.profile.id : undefined,
        name: formName,
        baseURL: formBaseURL,
        model: formModel,
        key: formKey.trim() || undefined,
      })
      await refresh()
      toast(editor.mode === 'edit' ? '档案已更新' : '档案已创建')
      setEditor(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingProfile(false)
    }
  }

  /** 删除档案（被主/辅/视觉/嵌入任一类引用时主进程会拒绝并给出提示） */
  const handleDeleteProfile = async () => {
    if (!deleting) return
    try {
      await api.settings.deleteProfile(deleting.id)
      await refresh()
      toast('档案已删除')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  /** 切换某类模型的激活档案（立即落盘并广播同步；空串 = 未启用） */
  const setActive = async (
    field: 'activeMainProfileId' | 'activeAuxProfileId' | 'activeVisionProfileId',
    value: string,
  ) => {
    const id = value || null
    if (field === 'activeMainProfileId') await save({ activeMainProfileId: id })
    else if (field === 'activeAuxProfileId') await save({ activeAuxProfileId: id })
    else await save({ activeVisionProfileId: id })
  }

  /** 测试连接（按 profile 测各自回落后的生效配置；辅助未启用时主进程回落测主模型） */
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

  if (!loaded) return <Loading />

  // 各类型的当前激活档案（用于按钮禁用判定）
  const mainActive = profiles.find((p) => p.id === settings.activeMainProfileId)
  const auxActive = profiles.find((p) => p.id === settings.activeAuxProfileId)
  const visionActive = profiles.find((p) => p.id === settings.activeVisionProfileId)
  /** 主模型生效配置是否完整（辅助测试回落时也看它） */
  const mainReady = !!mainActive && mainActive.hasKey
  const profileOptions = profiles.map((p) => ({ value: p.id, label: profileLabel(p) }))

  return (
    <div className="space-y-4">
      {/* ===== 服务商档案库（全局复用：名称 + 地址 + 模型 + Key） ===== */}
      <AccordionItem title="服务商档案库" icon={<Plus size={15} strokeWidth={1.75} />} defaultOpen>
        <div className="space-y-3">
          <div className="text-xs leading-relaxed text-text-muted">
            每个档案 = 一套「API 地址 + 模型名 + API Key」组合，集中管理、可被下方各类模型同时引用。
            换服务商/换 Key 只需切换档案，无需逐处修改。嵌入模型的档案选择在「记忆体」面板。
          </div>
          {profiles.length === 0 && (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
              还没有档案，点击下方「新增档案」创建第一个
            </div>
          )}
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{p.name}</span>
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
                    {p.hasKey ? '已配 Key' : '未配 Key'}
                  </span>
                </div>
                <div className="truncate text-xs text-text-muted">
                  {p.model || '未填模型'} · {p.baseURL || '未填地址'}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => openEditor({ mode: 'edit', profile: p })} title="编辑档案">
                <Pencil size={14} strokeWidth={1.75} />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(p)} title="删除档案">
                <Trash2 size={14} strokeWidth={1.75} />
              </Button>
            </div>
          ))}
          <Button variant="outline" onClick={() => openEditor({ mode: 'create' })}>
            <Plus size={14} strokeWidth={2} />
            新增档案
          </Button>
        </div>
      </AccordionItem>

      {/* ===== 主模型（主对话链，必填） ===== */}
      <AccordionItem title="主模型" icon={<Cpu size={15} strokeWidth={1.75} />} defaultOpen>
        <div className="space-y-4">
          <Field
            label="激活档案"
            hint="主对话链使用的服务商档案；档案的地址/模型/Key 可在「服务商档案库」中修改"
          >
            <SelectMenu
              value={settings.activeMainProfileId ?? ''}
              onChange={(v) => void setActive('activeMainProfileId', v)}
              options={[OFF_OPTION, ...profileOptions]}
              placeholder="未配置（选择一个档案）"
            />
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
            <Button variant="outline" onClick={() => void handleTest('main')} disabled={testing !== null || !mainReady}>
              {testing === 'main' ? '测试中…' : '测试连接'}
            </Button>
          </div>
        </div>
      </AccordionItem>

      {/* ===== 辅助模型（翻译/结构修复/情景摘要，可选，未启用回落主模型档案） ===== */}
      <AccordionItem title="辅助模型（翻译 / 结构修复 / 情景摘要）（可选）" icon={<Zap size={15} strokeWidth={1.75} />} defaultOpen={false}>
        <div className="space-y-3">
          <div className="text-xs leading-relaxed text-text-muted">
            日语翻译、JSON 修复与情景摘要更新都是机械型小任务：前两者串行在语音首响路径上，情景摘要在每轮
            结束后后台异步更新。建议激活非思考的快速小模型档案（如 gemini-flash / qwen-turbo / deepseek-chat），
            未启用则使用主模型激活的档案
          </div>
          <SelectMenu
            value={settings.activeAuxProfileId ?? ''}
            onChange={(v) => void setActive('activeAuxProfileId', v)}
            options={[AUX_OFF_OPTION, ...profileOptions]}
            placeholder="未启用（回落主模型）"
          />
          <TestResultView result={testResults.aux} />
          <Button variant="outline" onClick={() => void handleTest('aux')} disabled={testing !== null || !(auxActive?.hasKey || mainReady)}>
            {testing === 'aux' ? '测试中…' : '测试连接'}
          </Button>
        </div>
      </AccordionItem>

      {/* ===== 视觉模型（屏幕感知/立绘打标/图片转述，可选；独立必填不回落） ===== */}
      <AccordionItem title="视觉模型（屏幕感知 / 立绘打标 / 图片转述 用，可选）" icon={<Eye size={15} strokeWidth={1.75} />} defaultOpen={false}>
        <div className="space-y-3">
          <div className="text-xs leading-relaxed text-text-muted">
            用于屏幕感知（角色"偷看"桌面转述话题）、立绘集 AI 视觉打标、聊天图片转述（读图方式选「视觉模型辅助」时）三类图像理解任务，
            需激活支持图像输入的多模态模型档案（如 gemini-flash / qwen-vl / gpt-4o-mini）。
            未启用则相关功能不使用：屏幕感知自动降级为普通话题，立绘打标不可用，聊天发图会提示模型不支持（均不回落主模型）
          </div>
          <SelectMenu
            value={settings.activeVisionProfileId ?? ''}
            onChange={(v) => void setActive('activeVisionProfileId', v)}
            options={[OFF_OPTION, ...profileOptions]}
            placeholder="未启用（选择一个档案）"
          />
          <TestResultView result={testResults.vision} />
          <Button variant="outline" onClick={() => void handleTest('vision')} disabled={testing !== null || !visionActive?.hasKey}>
            {testing === 'vision' ? '测试中…' : '测试连接'}
          </Button>
        </div>
      </AccordionItem>

      {/* ===== 档案编辑器（Modal） ===== */}
      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === 'edit' ? '编辑档案' : '新增档案'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveProfile()} disabled={savingProfile}>
              {savingProfile ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="档案名称">
            <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="如 DeepSeek 官方 / 硅基流动" />
          </Field>
          <Field label="API 地址（baseURL）" hint="兼容 OpenAI 格式的接口地址，如 https://api.openai.com/v1">
            <Input value={formBaseURL} onChange={(e) => setFormBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="模型（model）" hint="如 deepseek-chat / gpt-4o-mini，需与该 API 兼容；可点「获取可用模型」从服务商拉取列表">
            <div className="flex gap-2">
              <Input value={formModel} onChange={(e) => setFormModel(e.target.value)} placeholder="deepseek-chat" className="min-w-0 flex-1" />
              <Button
                variant="outline"
                onClick={() => setModelListOpen((v) => !v)}
                disabled={fetchingModels || !modelOptions || modelOptions.length === 0}
                title={modelOptions && modelOptions.length > 0 ? '展开/收起可用模型列表' : '先获取可用模型'}
                className="shrink-0 px-2"
              >
                <ChevronDown size={14} strokeWidth={1.75} className={cn('transition-transform', modelListOpen && 'rotate-180')} />
              </Button>
              <Button variant="outline" onClick={() => void handleFetchModels()} disabled={fetchingModels || !formBaseURL.trim()} title={!formBaseURL.trim() ? '先填写 API 地址' : '从该服务商拉取可用模型列表'} className="shrink-0">
                <RefreshCw size={14} strokeWidth={1.75} className={fetchingModels ? 'animate-spin' : undefined} />
                {fetchingModels ? '获取中…' : '获取可用模型'}
              </Button>
            </div>
            {modelListOpen && modelOptions !== null && modelOptions.length > 0 && (
              <div className="mt-2 max-h-44 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface-2">
                {modelOptions.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setFormModel(id)
                      setModelListOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
                      formModel === id
                        ? 'bg-accent/15 font-medium text-accent'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <span className="min-w-0 truncate">{id}</span>
                    {formModel === id && <Check size={14} strokeWidth={2} className="shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field
            label="API Key"
            hint={
              editor?.mode === 'edit' && editor.profile.hasKey
                ? '已配置（sk-****）。留空保持不变；填写新值将替换原 Key（加密存储，不会回显明文）。'
                : '以 Bearer 方式发送，经系统安全存储（DPAPI）加密后落盘。'
            }
          >
            <Input
              type="password"
              value={formKey}
              onChange={(e) => setFormKey(e.target.value)}
              placeholder={editor?.mode === 'edit' && editor.profile.hasKey ? 'sk-****（已配置，留空保持不变）' : 'sk-...'}
              autoComplete="off"
            />
          </Field>
        </div>
      </Modal>

      {/* ===== 删除确认 ===== */}
      <ConfirmModal
        open={deleting !== null}
        title="删除档案"
        message={`确定删除档案「${deleting?.name ?? ''}」吗？其 API Key 将一并清除；正在被使用的档案无法删除。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDeleteProfile()}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

/**
 * 角色卡面板：列表 + 新建/编辑（分 Tab：人设 / 外观 / 声音 / 元数据）/ 删除。
 *
 * 借鉴 airi 多 Tab 编辑器设计，精简为四个 Tab：
 * - 人设：name / description / personality / scenario / greeting / alternateGreetings / messageExample
 * - 外观：modelId / avatar / modelOverride（表情/待机动作覆盖）
 * - 声音：voiceId / ttsOverride（language/autoPlay 覆盖）
 * - 元数据：tags / creator / notes
 */
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { useCharacterStore } from '../../store/characterStore'
import type {
  CharacterCard,
  CharacterCardInput,
  CharacterModelOverride,
  CharacterTTSOverride,
  ExpressionMeta,
  TTSLanguage,
  VoiceReference,
} from '../../types'
import {
  Button,
  Card,
  ConfirmModal,
  Empty,
  Field,
  Input,
  Loading,
  Modal,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '../../components/ui'
import { toast } from '../../components/toast'
import { truncate } from '../../lib/utils'

/** 编辑器 Tab 类型 */
type EditorTab = 'persona' | 'appearance' | 'voice' | 'meta'

/** 编辑器本地状态：对应 CharacterCardInput 的业务字段 */
interface EditorState {
  card: CharacterCard | null
  name: string
  description: string
  personality: string
  scenario: string
  greeting: string
  alternateGreetings: string
  messageExample: string
  modelId: string
  voiceId: string
  // TTS 覆盖
  ttsLanguageOverride: 'global' | TTSLanguage
  ttsAutoPlayOverride: 'global' | boolean
  // 模型覆盖
  expressionOverride: 'global' | string
  idleAnimationOverride: 'global' | string
  // 元数据
  tags: string
  creator: string
  notes: string
}

/** 空编辑器状态 */
const EMPTY_EDITOR: EditorState = {
  card: null,
  name: '',
  description: '',
  personality: '',
  scenario: '',
  greeting: '',
  alternateGreetings: '',
  messageExample: '',
  modelId: '',
  voiceId: '',
  ttsLanguageOverride: 'global',
  ttsAutoPlayOverride: 'global',
  expressionOverride: 'global',
  idleAnimationOverride: 'global',
  tags: '',
  creator: '',
  notes: '',
}

/** 将 CharacterTTSOverride 转为编辑器选择值 */
function ttsLanguageToEditor(v: CharacterTTSOverride | null): 'global' | TTSLanguage {
  return v?.language ?? 'global'
}

function ttsAutoPlayToEditor(v: CharacterTTSOverride | null): 'global' | boolean {
  if (v?.autoPlay === null) return 'global'
  return v?.autoPlay ?? 'global'
}

/** 将编辑器选择值转为 CharacterTTSOverride */
function editorToTtsOverride(language: 'global' | TTSLanguage, autoPlay: 'global' | boolean): CharacterTTSOverride | null {
  const lang = language === 'global' ? null : language
  const play = autoPlay === 'global' ? null : autoPlay
  if (lang === null && play === null) return null
  return { language: lang, autoPlay: play }
}

/** 将 CharacterModelOverride 转为编辑器选择值 */
function expressionToEditor(v: CharacterModelOverride | null): 'global' | string {
  if (v?.selectedExpression === null || v?.selectedExpression === undefined) return 'global'
  return v.selectedExpression
}

function idleAnimToEditor(v: CharacterModelOverride | null): 'global' | string {
  if (v?.idleAnimation === null || v?.idleAnimation === undefined) return 'global'
  return v.idleAnimation
}

/** 将编辑器选择值转为 CharacterModelOverride */
function editorToModelOverride(expression: 'global' | string, idleAnim: 'global' | string): CharacterModelOverride | null {
  const expr = expression === 'global' ? null : expression
  const idle = idleAnim === 'global' ? null : idleAnim
  if (expr === null && idle === null) return null
  return { selectedExpression: expr, idleAnimation: idle }
}

export function CharacterCardPanel() {
  const { cards, loading, load } = useCharacterStore()
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [voices, setVoices] = useState<VoiceReference[]>([])
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])
  const [motionGroups, setMotionGroups] = useState<string[]>([])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [activeTab, setActiveTab] = useState<EditorTab>('persona')
  const [deleting, setDeleting] = useState<CharacterCard | null>(null)
  const [saving, setSaving] = useState(false)

  /** 加载 Live2D 模型列表 */
  const loadModels = async () => {
    const list = await api.model.list()
    setModels(list.map((m) => ({ id: m.id, name: m.name })))
  }

  /** 加载参考音频列表 */
  const loadVoices = async () => {
    try {
      const list = await api.tts.listReferences()
      setVoices(list)
    } catch {
      setVoices([])
    }
  }

  /** 根据 modelId 加载表情列表和动作组（编辑器外观 Tab 用） */
  const loadModelAssets = async (modelId: string) => {
    if (!modelId) {
      setExpressions([])
      setMotionGroups([])
      return
    }
    try {
      const [exprList, groups] = await Promise.all([
        api.model.expressionList(modelId),
        api.model.motionGroups(modelId),
      ])
      setExpressions(exprList)
      setMotionGroups(groups)
    } catch {
      setExpressions([])
      setMotionGroups([])
    }
  }

  useEffect(() => {
    void load()
    void loadModels()
    void loadVoices()
  }, [load])

  // 窗口聚焦时刷新参考音频列表（用户可能在语音合成面板导入新的）
  useEffect(() => {
    const onFocus = () => void loadVoices()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // 编辑器 modelId 变化时加载表情/动作组
  useEffect(() => {
    if (editor?.modelId) void loadModelAssets(editor.modelId)
    else {
      setExpressions([])
      setMotionGroups([])
    }
  }, [editor?.modelId])

  /** 打开新建编辑器 */
  const openCreate = () => {
    setEditor({ ...EMPTY_EDITOR })
    setActiveTab('persona')
  }

  /** 打开编辑现有角色卡 */
  const openEdit = (card: CharacterCard) => {
    setEditor({
      card,
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      greeting: card.greeting,
      alternateGreetings: card.alternateGreetings.join('\n---\n'),
      messageExample: card.messageExample,
      modelId: card.modelId ?? '',
      voiceId: card.voiceId ?? '',
      ttsLanguageOverride: ttsLanguageToEditor(card.ttsOverride),
      ttsAutoPlayOverride: ttsAutoPlayToEditor(card.ttsOverride),
      expressionOverride: expressionToEditor(card.modelOverride),
      idleAnimationOverride: idleAnimToEditor(card.modelOverride),
      tags: card.tags.join(', '),
      creator: card.creator,
      notes: card.notes,
    })
    setActiveTab('persona')
  }

  /** 保存角色卡（新建或更新） */
  const handleSave = async () => {
    if (!editor) return
    setSaving(true)
    try {
      // 解析备选开场白：用 "---" 分隔
      const alternateGreetings = editor.alternateGreetings
        .split(/\n---\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      // 解析标签：用逗号分隔
      const tags = editor.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const input: CharacterCardInput = {
        name: editor.name,
        description: editor.description,
        personality: editor.personality,
        scenario: editor.scenario,
        greeting: editor.greeting,
        alternateGreetings,
        messageExample: editor.messageExample,
        modelId: editor.modelId || null,
        voiceId: editor.voiceId || null,
        ttsOverride: editorToTtsOverride(editor.ttsLanguageOverride, editor.ttsAutoPlayOverride),
        modelOverride: editorToModelOverride(editor.expressionOverride, editor.idleAnimationOverride),
        tags,
        avatar: editor.card?.avatar ?? null,
        creator: editor.creator,
        notes: editor.notes,
      }

      if (editor.card) {
        await api.characterCard.update(editor.card.id, input)
        toast('角色卡已更新')
      } else {
        await api.characterCard.create(input)
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

  /** 删除角色卡 */
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
        <Button onClick={openCreate}>
          <Plus size={14} strokeWidth={2.25} /> 新建角色卡
        </Button>
      </div>

      {loading ? (
        <Loading />
      ) : cards.length === 0 ? (
        <Empty text="还没有角色卡，点击右上角「新建角色卡」开始" />
      ) : (
        cards.map((card) => (
          <Card key={card.id} className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-surface-2 text-sm ring-1 ring-border">
              {card.name.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{card.name}</span>
                {card.modelId && (
                  <span className="rounded-full bg-accent/15 px-2 py-1 text-[10px] text-accent ring-1 ring-accent/30">
                    绑定模型
                  </span>
                )}
                {card.voiceId && (
                  <span className="rounded-full bg-primary-500/15 px-2 py-1 text-[10px] text-primary-400 ring-1 ring-primary-500/30">
                    声音克隆
                  </span>
                )}
                {card.greeting.trim() && (
                  <span className="rounded-full bg-success/15 px-2 py-1 text-[10px] text-success ring-1 ring-success/30">
                    开场白
                  </span>
                )}
                {card.ttsOverride && (
                  <span className="rounded-full bg-warning/15 px-2 py-1 text-[10px] text-warning ring-1 ring-warning/30">
                    TTS覆盖
                  </span>
                )}
                {card.modelOverride && (
                  <span className="rounded-full bg-warning/15 px-2 py-1 text-[10px] text-warning ring-1 ring-warning/30">
                    外观覆盖
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1 text-xs leading-relaxed text-text-muted selectable">
                {card.description.trim() || card.personality.trim() ? (
                  <>
                    {card.description.trim() && (
                      <p className="line-clamp-1">
                        <span className="text-accent">身份</span> · {truncate(card.description, 60)}
                      </p>
                    )}
                    {card.personality.trim() && (
                      <p className="line-clamp-1">
                        <span className="text-accent">性格</span> · {truncate(card.personality, 60)}
                      </p>
                    )}
                  </>
                ) : (
                  <p>（未填写身份与性格）</p>
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

      {/* 新建 / 编辑弹窗：分 Tab 编辑器 */}
      <Modal
        open={!!editor}
        onClose={() => setEditor(null)}
        title={editor?.card ? '编辑角色卡' : '新建角色卡'}
        width={640}
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
            {/* Tab 切换 */}
            <SegmentedControl<EditorTab>
              options={[
                { value: 'persona', label: '人设' },
                { value: 'appearance', label: '外观' },
                { value: 'voice', label: '声音' },
                { value: 'meta', label: '元数据' },
              ]}
              value={activeTab}
              onChange={setActiveTab}
            />

            {/* 人设 Tab */}
            {activeTab === 'persona' && (
              <div className="space-y-4">
                <Field label="名称">
                  <Input
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    placeholder="如：小艾"
                    maxLength={20}
                  />
                </Field>
                <Field label="身份（description）" hint="角色是什么——身份设定，将作为 system prompt 的一部分注入">
                  <Textarea
                    rows={3}
                    value={editor.description}
                    onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                    placeholder="你是一只温柔且话痨的猫娘桌宠，名字叫小艾，住在用户的电脑里……"
                  />
                </Field>
                <Field label="性格（personality）" hint="角色如何思考与表现——行为方式、思维逻辑、说话习惯，将作为 system prompt 的一部分注入">
                  <Textarea
                    rows={3}
                    value={editor.personality}
                    onChange={(e) => setEditor({ ...editor, personality: e.target.value })}
                    placeholder="你会亲昵地称呼用户为「主人」，回答简洁温柔，偶尔撒娇，思考时先描述自己的感受……"
                  />
                </Field>
                <Field label="场景（scenario）" hint="角色所处的情境（可选），将作为 system prompt 的一部分注入">
                  <Textarea
                    rows={2}
                    value={editor.scenario}
                    onChange={(e) => setEditor({ ...editor, scenario: e.target.value })}
                    placeholder="你住在用户的电脑桌面角落，能感知到用户正在使用的软件和系统时间……"
                  />
                </Field>
                <Field label="开场白（greeting）" hint="新会话首条 AI 消息（空 = 不发送开场白）">
                  <Textarea
                    rows={2}
                    value={editor.greeting}
                    onChange={(e) => setEditor({ ...editor, greeting: e.target.value })}
                    placeholder="主人好呀～今天也想和小艾聊天吗？"
                  />
                </Field>
                <Field label="备选开场白" hint="每行用 --- 分隔，新会话时随机选一条（含上面的主开场白）">
                  <Textarea
                    rows={3}
                    value={editor.alternateGreetings}
                    onChange={(e) => setEditor({ ...editor, alternateGreetings: e.target.value })}
                    placeholder={"欢迎回来，主人～\n---\n嗯……主人今天看起来很累呢"}
                  />
                </Field>
                <Field label="示例对话（messageExample）" hint="few-shot 样本，让 LLM 学习角色说话风格。格式：{{char}}: xxx / {{user}}: yyy">
                  <Textarea
                    rows={4}
                    value={editor.messageExample}
                    onChange={(e) => setEditor({ ...editor, messageExample: e.target.value })}
                    placeholder={"{{user}}: 今天天气怎么样？\n{{char}}: 唔……小艾看不到外面的天气呢，但主人的声音听起来心情不错哦～"}
                  />
                </Field>
              </div>
            )}

            {/* 外观 Tab */}
            {activeTab === 'appearance' && (
              <div className="space-y-4">
                <Field label="绑定 Live2D 模型（可选）" hint="不绑定则使用全局当前模型">
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
                <Field label="表情覆盖（modelOverride.selectedExpression）" hint="角色级表情覆盖。需先绑定模型。null = 跟随全局；空串 = 清除表情">
                  <Select
                    value={editor.expressionOverride}
                    onChange={(e) => setEditor({ ...editor, expressionOverride: e.target.value as 'global' | string })}
                    disabled={!editor.modelId}
                  >
                    <option value="global">跟随全局</option>
                    <option value="">清除表情（不应用任何表情）</option>
                    {expressions.map((ex) => (
                      <option key={ex.name} value={ex.name}>
                        {ex.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="待机动作覆盖（modelOverride.idleAnimation）" hint="角色级待机动作组覆盖。需先绑定模型。null = 跟随全局；空串 = 随机动作">
                  <Select
                    value={editor.idleAnimationOverride}
                    onChange={(e) => setEditor({ ...editor, idleAnimationOverride: e.target.value as 'global' | string })}
                    disabled={!editor.modelId}
                  >
                    <option value="global">跟随全局</option>
                    <option value="">随机动作（不指定动作组）</option>
                    {motionGroups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </Select>
                </Field>
                {!editor.modelId && (
                  <p className="text-xs text-text-muted">
                    绑定 Live2D 模型后可选择表情和待机动作覆盖
                  </p>
                )}
              </div>
            )}

            {/* 声音 Tab */}
            {activeTab === 'voice' && (
              <div className="space-y-4">
                <Field label="绑定参考音频（可选）" hint="绑定后 AI 回复将自动用该声音克隆合成语音并驱动口型同步。需先在「语音合成」中导入参考音频。">
                  <Select
                    value={editor.voiceId}
                    onChange={(e) => setEditor({ ...editor, voiceId: e.target.value })}
                  >
                    <option value="">不绑定（不启用 TTS）</option>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="TTS 语言覆盖（ttsOverride.language）" hint="角色级语言覆盖，解决日文角色/中文角色共用全局语言的问题。跟随全局 = 用全局设置">
                  <Select
                    value={editor.ttsLanguageOverride}
                    onChange={(e) => setEditor({ ...editor, ttsLanguageOverride: e.target.value as 'global' | TTSLanguage })}
                    disabled={!editor.voiceId}
                  >
                    <option value="global">跟随全局</option>
                    <option value="zh">强制中文</option>
                    <option value="ja">强制日文</option>
                  </Select>
                </Field>
                <Field label="自动播放覆盖（ttsOverride.autoPlay）" hint="角色级自动播放覆盖。跟随全局 = 用全局设置">
                  <div className="flex items-center gap-3">
                    <Select
                      value={editor.ttsAutoPlayOverride === 'global' ? 'global' : String(editor.ttsAutoPlayOverride)}
                      onChange={(e) => {
                        const v = e.target.value
                        setEditor({
                          ...editor,
                          ttsAutoPlayOverride: v === 'global' ? 'global' : v === 'true',
                        })
                      }}
                      disabled={!editor.voiceId}
                    >
                      <option value="global">跟随全局</option>
                      <option value="true">强制开启</option>
                      <option value="false">强制关闭</option>
                    </Select>
                  </div>
                </Field>
                {!editor.voiceId && (
                  <p className="text-xs text-text-muted">
                    绑定参考音频后可配置 TTS 覆盖
                  </p>
                )}
              </div>
            )}

            {/* 元数据 Tab */}
            {activeTab === 'meta' && (
              <div className="space-y-4">
                <Field label="标签（tags）" hint="用逗号分隔，用于分类管理">
                  <Input
                    value={editor.tags}
                    onChange={(e) => setEditor({ ...editor, tags: e.target.value })}
                    placeholder="猫娘, 温柔, 日系"
                  />
                </Field>
                <Field label="创作者（creator）" hint="角色卡作者署名">
                  <Input
                    value={editor.creator}
                    onChange={(e) => setEditor({ ...editor, creator: e.target.value })}
                    placeholder="你的名字"
                  />
                </Field>
                <Field label="备注（notes）" hint="角色卡使用说明或创作笔记">
                  <Textarea
                    rows={3}
                    value={editor.notes}
                    onChange={(e) => setEditor({ ...editor, notes: e.target.value })}
                    placeholder="这个角色的设计灵感来自……适合用于……"
                  />
                </Field>
              </div>
            )}
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

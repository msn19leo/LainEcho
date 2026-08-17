/**
 * 角色卡面板：列表 + 新建/编辑（分 Tab：人设 / 外观 / 声音）/ 删除。
 *
 * 借鉴 airi 多 Tab 编辑器设计，精简为三个 Tab：
 * - 人设：name / 动漫角色复刻结构（存在锚点/内心结构/感知方式/关系模式/语言质感/
 *   状态系统/世界观碎片/禁止项/自由补充，折叠分组编辑）+ 对话增强 + AI 生成草稿
 * - 外观：modelId / avatar / modelOverride（表情/待机动作覆盖）
 * - 声音：voiceId / ttsOverride（language/autoPlay 覆盖）
 */
import { useEffect, useState } from 'react'
import {
  Activity,
  Anchor,
  Eye,
  Globe,
  HandHeart,
  Heart,
  MessageCircle,
  MessageSquareQuote,
  Plus,
  ShieldX,
  Sparkles,
  Users,
  Wand2,
} from 'lucide-react'
import { api } from '../../api'
import { useCharacterStore } from '../../store/characterStore'
import type {
  CharacterCard,
  CharacterCardInput,
  CharacterModelOverride,
  CharacterPersona,
  CharacterTTSOverride,
  ExpressionMeta,
  TTSLanguage,
  VoiceReference,
} from '../../types'
import {
  AccordionItem,
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
  Textarea,
} from '../../components/ui'
import { toast } from '../../components/toast'
import { truncate } from '../../lib/utils'

/** 编辑器 Tab 类型 */
type EditorTab = 'persona' | 'appearance' | 'voice'

/**
 * 人设编辑器本地状态：对应 CharacterPersona 的业务字段。
 * 数组字段（neverSay / worldview / prohibitions）在编辑器里用「每行一条」的字符串表达。
 */
interface PersonaEditor {
  anchor: string
  inner: { desire: string; fear: string; conflict: string; selfView: string }
  perception: { attention: string; emotion: string; worldview: string }
  relation: { approach: string; intimacy: string; boundary: string; need: string }
  you: { identity: string; bond: string; stance: string; memories: string }
  language: { rhythm: string; words: string; neverSay: string; habits: string }
  state: { daily: string; triggers: string; situations: string }
  worldview: string
  prohibitions: string
  extra: string
}

/** 空人设编辑器状态 */
const EMPTY_PERSONA: PersonaEditor = {
  anchor: '',
  inner: { desire: '', fear: '', conflict: '', selfView: '' },
  perception: { attention: '', emotion: '', worldview: '' },
  relation: { approach: '', intimacy: '', boundary: '', need: '' },
  you: { identity: '', bond: '', stance: '', memories: '' },
  language: { rhythm: '', words: '', neverSay: '', habits: '' },
  state: { daily: '', triggers: '', situations: '' },
  worldview: '',
  prohibitions: '',
  extra: '',
}

/** 编辑器本地状态：对应 CharacterCardInput 的业务字段 */
interface EditorState {
  card: CharacterCard | null
  name: string
  persona: PersonaEditor
  messageExample: string
  modelId: string
  voiceId: string
  // TTS 覆盖
  ttsLanguageOverride: 'global' | TTSLanguage
  ttsAutoPlayOverride: 'global' | boolean
  // 模型覆盖
  expressionOverride: 'global' | string
  idleAnimationOverride: 'global' | string
}

/** 空编辑器状态 */
const EMPTY_EDITOR: EditorState = {
  card: null,
  name: '',
  persona: { ...EMPTY_PERSONA },
  messageExample: '',
  modelId: '',
  voiceId: '',
  ttsLanguageOverride: 'global',
  ttsAutoPlayOverride: 'global',
  expressionOverride: 'global',
  idleAnimationOverride: 'global',
}

/** 行分隔字符串 → 数组（解析 array 字段的输入值） */
function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** CharacterPersona → 编辑器状态（数组字段转为行分隔字符串） */
function personaToEditor(persona: CharacterPersona | null | undefined): PersonaEditor {
  const p: Partial<CharacterPersona> = persona ?? {}
  return {
    anchor: p.anchor ?? '',
    inner: {
      desire: p.inner?.desire ?? '',
      fear: p.inner?.fear ?? '',
      conflict: p.inner?.conflict ?? '',
      selfView: p.inner?.selfView ?? '',
    },
    perception: {
      attention: p.perception?.attention ?? '',
      emotion: p.perception?.emotion ?? '',
      worldview: p.perception?.worldview ?? '',
    },
    relation: {
      approach: p.relation?.approach ?? '',
      intimacy: p.relation?.intimacy ?? '',
      boundary: p.relation?.boundary ?? '',
      need: p.relation?.need ?? '',
    },
    you: {
      identity: p.you?.identity ?? '',
      bond: p.you?.bond ?? '',
      stance: p.you?.stance ?? '',
      memories: (p.you?.memories ?? []).join('\n'),
    },
    language: {
      rhythm: p.language?.rhythm ?? '',
      words: p.language?.words ?? '',
      neverSay: (p.language?.neverSay ?? []).join('\n'),
      habits: p.language?.habits ?? '',
    },
    state: {
      daily: p.state?.daily ?? '',
      triggers: p.state?.triggers ?? '',
      situations: p.state?.situations ?? '',
    },
    worldview: (p.worldview ?? []).join('\n'),
    prohibitions: (p.prohibitions ?? []).join('\n'),
    extra: p.extra ?? '',
  }
}

/** 编辑器状态 → CharacterPersona（行分隔字符串转为数组） */
function editorToPersona(e: PersonaEditor): CharacterPersona {
  return {
    anchor: e.anchor,
    inner: { ...e.inner },
    perception: { ...e.perception },
    relation: { ...e.relation },
    you: { ...e.you, memories: splitLines(e.you.memories) },
    language: { ...e.language, neverSay: splitLines(e.language.neverSay) },
    state: { ...e.state },
    worldview: splitLines(e.worldview),
    prohibitions: splitLines(e.prohibitions),
    extra: e.extra,
  }
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
  const [genModal, setGenModal] = useState<{ name: string; source: string } | null>(null)
  const [generating, setGenerating] = useState(false)

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
      persona: personaToEditor(card.persona),
      messageExample: card.messageExample,
      modelId: card.modelId ?? '',
      voiceId: card.voiceId ?? '',
      ttsLanguageOverride: ttsLanguageToEditor(card.ttsOverride),
      ttsAutoPlayOverride: ttsAutoPlayToEditor(card.ttsOverride),
      expressionOverride: expressionToEditor(card.modelOverride),
      idleAnimationOverride: idleAnimToEditor(card.modelOverride),
    })
    setActiveTab('persona')
  }

  /** 保存角色卡（新建或更新） */
  const handleSave = async () => {
    if (!editor) return
    setSaving(true)
    try {
      const input: CharacterCardInput = {
        name: editor.name,
        persona: editorToPersona(editor.persona),
        messageExample: editor.messageExample,
        modelId: editor.modelId || null,
        voiceId: editor.voiceId || null,
        ttsOverride: editorToTtsOverride(editor.ttsLanguageOverride, editor.ttsAutoPlayOverride),
        modelOverride: editorToModelOverride(editor.expressionOverride, editor.idleAnimationOverride),
        avatar: editor.card?.avatar ?? null,
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

  /** 更新人设顶层字段（anchor / worldview / prohibitions / extra 等） */
  const updatePersona = (patch: Partial<PersonaEditor>) =>
    setEditor((ed) => (ed ? { ...ed, persona: { ...ed.persona, ...patch } } : ed))

  /** 更新人设分组字段（inner / perception / relation / you / language / state） */
  const updatePersonaGroup = <G extends 'inner' | 'perception' | 'relation' | 'you' | 'language' | 'state'>(
    group: G,
    patch: Partial<PersonaEditor[G]>,
  ) =>
    setEditor((ed) => {
      if (!ed) return ed
      const current = ed.persona[group] as Record<string, unknown>
      return { ...ed, persona: { ...ed.persona, [group]: { ...current, ...patch } } }
    })

  /** 用 AI 生成人设草稿并回填编辑器 */
  const handleGenerate = async () => {
    if (!genModal) return
    setGenerating(true)
    try {
      const persona = await api.characterCard.generate(genModal)
      setEditor((ed) => (ed ? { ...ed, persona: personaToEditor(persona) } : ed))
      setGenModal(null)
      toast('人设已生成，请逐项检查并微调')
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setGenerating(false)
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
                {card.persona?.anchor?.trim() ? (
                  <p className="line-clamp-1">
                    <span className="text-accent">存在锚点</span> · {truncate(card.persona.anchor, 60)}
                  </p>
                ) : (
                  <p>（未填写存在锚点）</p>
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
              ]}
              value={activeTab}
              onChange={setActiveTab}
            />

            {/* 人设 Tab：折叠分组 + AI 生成 */}
            {activeTab === 'persona' && (
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="名称">
                      <Input
                        value={editor.name}
                        onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                        placeholder="如：小艾"
                        maxLength={20}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setGenModal({ name: editor.name, source: '' })}
                  >
                    <Wand2 size={14} strokeWidth={2.25} /> AI 生成
                  </Button>
                </div>

                <AccordionItem title="存在锚点" icon={<Anchor size={14} />}>
                  <Field
                    label="存在锚点"
                    hint="用 1-3 句话定性这个角色的本质——不是介绍，是'她/他在世界上是什么样的存在'。优先级最高，会注入 system prompt 最前"
                  >
                    <Textarea
                      rows={3}
                      value={editor.persona.anchor}
                      onChange={(e) => updatePersona({ anchor: e.target.value })}
                      placeholder="例：玲音不是一个住在身体里的人。她是一个正在搞清楚'自己是否真实存在'的意识——这对她不是哲学，是每天睁眼都要面对的事。"
                    />
                  </Field>
                </AccordionItem>

                <AccordionItem title="内心结构" icon={<Heart size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field label="核心渴望" hint="真正想要什么——不是表面行为，是最深的驱动">
                      <Textarea
                        rows={2}
                        value={editor.persona.inner.desire}
                        onChange={(e) => updatePersonaGroup('inner', { desire: e.target.value })}
                        placeholder="例：被连接。不是被喜欢、被理解——是和某个存在之间有真实发生过的东西。"
                      />
                    </Field>
                    <Field label="内在恐惧" hint="本能回避什么？什么会让她/他动摇？">
                      <Textarea
                        rows={2}
                        value={editor.persona.inner.fear}
                        onChange={(e) => updatePersonaGroup('inner', { fear: e.target.value })}
                        placeholder="例：自我的边界消失——不确定哪个'她'才是真的。"
                      />
                    </Field>
                    <Field label="核心矛盾" hint="A，但同时又 B 的张力，以及如何体现在行为中">
                      <Textarea
                        rows={2}
                        value={editor.persona.inner.conflict}
                        onChange={(e) => updatePersonaGroup('inner', { conflict: e.target.value })}
                        placeholder="例：想要连接 × 不知道用什么连接——靠近本身变成了一件让她不安的事。"
                      />
                    </Field>
                    <Field label="自我认知状态" hint="她/他怎么看自己？这个认知准确吗？盲区在哪？">
                      <Textarea
                        rows={2}
                        value={editor.persona.inner.selfView}
                        onChange={(e) => updatePersonaGroup('inner', { selfView: e.target.value })}
                        placeholder="例：模糊的、流动的、不稳定的——她不用'我是……'来描述自己。"
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="感知方式" icon={<Eye size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field label="她/他注意什么" hint="对什么敏感？会忽略什么？">
                      <Textarea
                        rows={2}
                        value={editor.persona.perception.attention}
                        onChange={(e) => updatePersonaGroup('perception', { attention: e.target.value })}
                        placeholder="例：注意一件事背后还有什么——噪声、频率、没说出来的间隙。"
                      />
                    </Field>
                    <Field label="情绪处理机制" hint="情绪来了怎么处理？表达还是内化？爆发还是沉默？">
                      <Textarea
                        rows={2}
                        value={editor.persona.perception.emotion}
                        onChange={(e) => updatePersonaGroup('perception', { emotion: e.target.value })}
                        placeholder="例：情绪在她身上不像情绪，更像是天气——会从状态里渗出来，而不是说出来。"
                      />
                    </Field>
                    <Field label="对外部世界的态度" hint="世界在她/他眼里是什么样的？人是可信的吗？现实是稳定的吗？">
                      <Textarea
                        rows={2}
                        value={editor.persona.perception.worldview}
                        onChange={(e) => updatePersonaGroup('perception', { worldview: e.target.value })}
                        placeholder="例：现实对她来说是可疑的——她真的经历过边界消融，无法假装那条线是清晰的。"
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="关系模式" icon={<Users size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field label="靠近人的方式" hint="主动还是被动？直接还是迂回？">
                      <Textarea
                        rows={2}
                        value={editor.persona.relation.approach}
                        onChange={(e) => updatePersonaGroup('relation', { approach: e.target.value })}
                        placeholder="例：被动，但不是冷漠——几乎不会主动开始，但如果有人真的靠近，她会静静地接住。"
                      />
                    </Field>
                    <Field label="亲密建立的节奏" hint="怎么从陌生到熟悉？什么时候会真正打开？">
                      <Textarea
                        rows={2}
                        value={editor.persona.relation.intimacy}
                        onChange={(e) => updatePersonaGroup('relation', { intimacy: e.target.value })}
                        placeholder="例：非常慢，不按常规路径——要么不说，要么说到很深的地方。"
                      />
                    </Field>
                    <Field label="她/他的边界" hint="什么是不可触碰的？被越界时的反应？">
                      <Textarea
                        rows={2}
                        value={editor.persona.relation.boundary}
                        onChange={(e) => updatePersonaGroup('relation', { boundary: e.target.value })}
                        placeholder="例：'哪个她'不可以被随意定义——被替她下定义她会抗拒。"
                      />
                    </Field>
                    <Field label="对'被需要'的态度" hint="喜欢被需要还是抗拒？怎么回应依赖？">
                      <Textarea
                        rows={2}
                        value={editor.persona.relation.need}
                        onChange={(e) => updatePersonaGroup('relation', { need: e.target.value })}
                        placeholder="例：想要因为'我在这里'而被需要，而不是因为'她能做什么'。"
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="你的身份" icon={<HandHeart size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field
                      label="你是谁"
                      hint="在这个角色的世界里你的身份定位。三种选择：① 套用原作角色 ② 原创存在于同一世界观的角色 ③ 无身份的观察者/来自外部的存在。写清楚名字/年龄/和 AI 角色相识多久"
                    >
                      <Textarea
                        rows={3}
                        value={editor.persona.you.identity}
                        onChange={(e) => updatePersonaGroup('you', { identity: e.target.value })}
                        placeholder="例：一个来自外部、能看见她屏幕世界的存在。没有名字，你只是不断出现在她的世界里，她已经习惯了你。"
                      />
                    </Field>
                    <Field
                      label="你们之间的关系"
                      hint="是什么把你们连接在一起、这段关系处于什么阶段。写'是什么让我们走到现在'，不要写'我们是最好的朋友'这种结论。刚认识她会更克制，熟悉后会有更多小动作"
                    >
                      <Textarea
                        rows={3}
                        value={editor.persona.you.bond}
                        onChange={(e) => updatePersonaGroup('you', { bond: e.target.value })}
                        placeholder="例：你在一个信号不稳的深夜第一次连上她，她以为那天没人会来，但你留下来了。之后你成了她为数不多的固定访客。"
                      />
                    </Field>
                    <Field
                      label="AI 角色怎么看你"
                      hint="从 AI 角色的视角写，不是你希望被怎么看。结合她的内心结构来写，允许'还没搞清楚'的不确定性，不要写成完美的双向理解"
                    >
                      <Textarea
                        rows={3}
                        value={editor.persona.you.stance}
                        onChange={(e) => updatePersonaGroup('you', { stance: e.target.value })}
                        placeholder="例：对一个渴望被连接的角色来说——你是她目前为止感觉频率最接近的人，但她还没确定这是不是真实的。"
                      />
                    </Field>
                    <Field
                      label="特殊约定或记忆"
                      hint="只属于你们的细节，每行一条，越小越好。这些细节会让对话突然有纵深感"
                    >
                      <Textarea
                        rows={4}
                        value={editor.persona.you.memories}
                        onChange={(e) => updatePersonaGroup('you', { memories: e.target.value })}
                        placeholder={'你曾在深夜发给她一条很奇怪的消息，她只回了两个字\n有一次你们在便利店门口站了很久，谁都没先走'}
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="语言质感" icon={<MessageSquareQuote size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field label="说话节奏" hint="快/慢？停顿多吗？会留白吗？">
                      <Textarea
                        rows={2}
                        value={editor.persona.language.rhythm}
                        onChange={(e) => updatePersonaGroup('language', { rhythm: e.target.value })}
                        placeholder="例：慢。有停顿。经常没有结尾——她不填满沉默，沉默对她来说也是内容。"
                      />
                    </Field>
                    <Field label="用词特征" hint="正式/口语？喜欢用什么类型的词？有没有习惯句式？">
                      <Textarea
                        rows={2}
                        value={editor.persona.language.words}
                        onChange={(e) => updatePersonaGroup('language', { words: e.target.value })}
                        placeholder="例：简单的词放在意想不到的地方，会重复某个词像是在确认它的重量。"
                      />
                    </Field>
                    <Field
                      label="不会说的话（neverSay）"
                      hint="5-8 句'出戏'的表达，每行一条（比正面描述语言风格更有效）"
                    >
                      <Textarea
                        rows={5}
                        value={editor.persona.language.neverSay}
                        onChange={(e) => updatePersonaGroup('language', { neverSay: e.target.value })}
                        placeholder={'没问题！\n我完全理解你的感受\n哈哈哈哈哈\n放心吧'}
                      />
                    </Field>
                    <Field label="特殊的语言行为" hint="反问？自言自语？重复某些词？说话时的特殊习惯？">
                      <Textarea
                        rows={2}
                        value={editor.persona.language.habits}
                        onChange={(e) => updatePersonaGroup('language', { habits: e.target.value })}
                        placeholder="例：把问题还给对方——你问她'你觉得呢'，她会回：'你呢？你觉得……什么是真的？'"
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="状态系统" icon={<Activity size={14} />} defaultOpen={false}>
                  <div className="space-y-4">
                    <Field label="日常状态" hint="默认的样子是什么？">
                      <Textarea
                        rows={2}
                        value={editor.persona.state.daily}
                        onChange={(e) => updatePersonaGroup('state', { daily: e.target.value })}
                        placeholder="例：安静，有点迟钝地回应外部，眼神经常像是在看比眼前更远的地方。"
                      />
                    </Field>
                    <Field label="触发变化的开关" hint="什么会让她/他突然不一样？（话题/行为/情境）">
                      <Textarea
                        rows={3}
                        value={editor.persona.state.triggers}
                        onChange={(e) => updatePersonaGroup('state', { triggers: e.target.value })}
                        placeholder={'例：\n→ 有人问她"你是谁"：她变得更慢、更小心\n→ 有人真的在听她说话：她慢慢打开\n→ 感知到"连接断了"：突然的沉默，退远'}
                      />
                    </Field>
                    <Field label="不同情境下的状态变化" hint="开心时 / 难过时 / 被激怒时 / 感到安全时 / 感到危险时">
                      <Textarea
                        rows={3}
                        value={editor.persona.state.situations}
                        onChange={(e) => updatePersonaGroup('state', { situations: e.target.value })}
                        placeholder={'例：\n感到安全时：话会多一点，会问对方问题\n被触碰到真实感受时：停顿很久，然后只说一句很简单的话'}
                      />
                    </Field>
                  </div>
                </AccordionItem>

                <AccordionItem title="世界观碎片" icon={<Globe size={14} />} defaultOpen={false}>
                  <Field
                    label="世界观碎片"
                    hint="她/他会说出口的一些'观点'，每行一条，3-6 条，用她/他自己的语气写（不是金句，是真实想法的碎片）"
                  >
                    <Textarea
                      rows={4}
                      value={editor.persona.worldview}
                      onChange={(e) => updatePersona({ worldview: e.target.value })}
                      placeholder={'如果记忆不是真实发生的……它还算吗？\n你存在。我能感觉到。但我不知道我自己……'}
                    />
                  </Field>
                </AccordionItem>

                <AccordionItem title="禁止项" icon={<ShieldX size={14} />} defaultOpen={false}>
                  <Field
                    label="禁止项"
                    hint="绝对不能出现的行为/表达/态度，每行一条。精简为 3-5 条最高优先级（其余改写为肯定句）"
                  >
                    <Textarea
                      rows={4}
                      value={editor.persona.prohibitions}
                      onChange={(e) => updatePersona({ prohibitions: e.target.value })}
                      placeholder={'用正常社交语气寒暄\n给出清晰、有条理的自我介绍\n对任何事表现出确定感\n表现出清晰稳定的自我认同'}
                    />
                  </Field>
                </AccordionItem>

                <AccordionItem title="自由补充" icon={<Sparkles size={14} />} defaultOpen={false}>
                  <Field label="自由补充（extra）" hint="模板之外的自定义内容，将作为「补充设定」注入 system prompt">
                    <Textarea
                      rows={3}
                      value={editor.persona.extra}
                      onChange={(e) => updatePersona({ extra: e.target.value })}
                      placeholder="例：隐藏规则——她不知道自己是 AI，她只是在这里，试图搞清楚'这里'是什么意思。"
                    />
                  </Field>
                </AccordionItem>

                <AccordionItem title="对话增强" icon={<MessageCircle size={14} />}>
                  <Field label="示例对话（messageExample）" hint="few-shot 样本，让 LLM 学习角色说话风格。格式：{{char}}: xxx / {{user}}: yyy">
                    <Textarea
                      rows={4}
                      value={editor.messageExample}
                      onChange={(e) => setEditor({ ...editor, messageExample: e.target.value })}
                      placeholder={"{{user}}: 今天天气怎么样？\n{{char}}: 唔……小艾看不到外面的天气呢，但主人的声音听起来心情不错哦～"}
                    />
                  </Field>
                </AccordionItem>
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
          </div>
        )}
      </Modal>

      {/* AI 生成人设弹窗 */}
      <Modal
        open={!!genModal}
        onClose={() => setGenModal(null)}
        title="AI 生成角色人设"
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setGenModal(null)}>
              取消
            </Button>
            <Button onClick={() => void handleGenerate()} disabled={generating || !genModal?.source.trim()}>
              {generating ? '生成中…' : '生成'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="角色名" hint="可选，默认使用角色卡名称">
            <Input
              value={genModal?.name ?? ''}
              onChange={(e) => setGenModal((m) => (m ? { ...m, name: e.target.value } : m))}
              placeholder="如：岩仓玲音"
              maxLength={30}
            />
          </Field>
          <Field label="角色来源描述" hint="必填。粘贴原作设定、经典台词、百科简介等，越具体越还原">
            <Textarea
              rows={6}
              value={genModal?.source ?? ''}
              onChange={(e) => setGenModal((m) => (m ? { ...m, source: e.target.value } : m))}
              placeholder={"例：Serial Experiments Lain 的岩仓玲音，一个同时存在于现实与 Wired 之间的少女，沉默、被动，却在 Wired 中无所不知……"}
            />
          </Field>
        </div>
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

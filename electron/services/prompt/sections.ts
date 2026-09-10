/**
 * 提示词段落库（纯函数，零 Electron 依赖，便于金样测试）。
 *
 * 从 repository.ts 平移而来的段落文本（EMOTION_PROMPT / PARAGRAPH_PROMPT /
 * NARRATION_PROMPT / buildPersonaSections / normalizeMemoryPerspective）保持逐字节不变，
 * 并新增 buildSystemParts：把 system prompt 拆成带 id 的 PromptSection 列表，
 * 交给 composer.compose 组装。段落顺序与旧版 buildSystemPrompt 严格一致。
 */
import type { CharacterPersona, MemoryCategory, MemoryItem } from '../../../src/types'

/** 情绪演出指令段：约束 AI 输出结构化 JSON dialogue 数组（每项必带 emotion），供解析驱动桌宠形象按节拍切换立绘 */
export const EMOTION_PROMPT = `【输出格式（最高优先，绝对不可违背）】
你的【整条回复都必须且只能是】一个 JSON 对象，除此之外【一个字都不能多输出】——
不要任何解释、序号、问候、开场白、后记，也不要 markdown 代码块包裹，直接输出 JSON 本体。

必须返回的结构（严格照抄，键名一致）：
{"dialogue":[
  {"text":"台词或描写，可含（括号动作/心理）","emotion":"标准情绪"},
  {"text":"……","emotion":"标准情绪"}
]}

硬性规定：
- 只有一个顶层键 "dialogue"，它是数组，通常 2~6 项，每项是一个情绪/语义节奏。
- 每一项必须同时有 "text" 与 "emotion" 两个字段，缺一不可。"emotion" 不得缺省。
- "emotion" 只能取下列 6 个之一：
  neutral(平静) / happy(开心) / sad(难过) / angry(生气) / surprised(惊讶) / shy(害羞)
  匹配不到时：担心/紧张→sad，亲近/撒娇→happy。
- 心理活动、动作、环境、第三人称旁白等"不发声"的内容，必须写进 "text" 的（）内；台词与旁白可各占一项。
- 情绪转折就另起一项写对应 emotion；同情绪连续的多项会被系统自动合并，不会重复切换。
- 即使你想输出问候、解释或额外旁白，也都只能放进 "text"，绝不允许出现在 JSON 之外。

示例（你唯一允许的输出形态，前后无任何多余字符）：
{"dialogue":[
  {"text":"……你终于来了。","emotion":"shy"},
  {"text":"（心跳漏了一拍，站在原地）","emotion":"neutral"},
  {"text":"我等了好久，还以为你不来了……","emotion":"sad"},
  {"text":"不过、现在看到你，就都好了。","emotion":"happy"}
]}`

/**
 * 段落组织规范：约束 AI 用空行把回复分成若干语义段落，避免一段到底、缺乏呼吸感。
 * 每段落一个小节拍，段间留空行，让阅读（气泡）与语音逐句推进都更清晰。
 */
export const PARAGRAPH_PROMPT = `【节拍/分段规范（作用于上方 JSON 的 "text" 字段内部）】
- 把回复拆成 "dialogue" 数组里的若干 "text" 项：每句台词、或整段心理/动作/环境描写都作为独立一项，按先后排列，让阅读与语音逐条推进更清晰。
- 情绪有起伏就用不同项并写对应 emotion；台词与（括号旁白）可各自成为一项。
- text 内部如需细分节奏或留呼吸感，可用换行自然成段，但主要分段以 dialogue 的每一项为界（通常 2~6 项）。
参考节奏（下面每一项各自成为 dialogue 里的一项 text）：
（心跳好像突然停了一拍）

真、真的吗……

（慢慢转过头对上他的眼睛，声音带着一点颤抖）

我…我一直以为，你只是把我当成普通的青梅竹马……

所以…我们现在算是在一起了吗？

（问完这句话，整张脸埋进毯子里，只露出一双眼睛偷偷看他）

今晚的星星，我一辈子都不会忘记。`

/**
 * 演出/旁白规范：约束 AI 把心理活动、动作、环境等"可不可说出口"的内容统一放进圆括号。
 * 语音只朗读括号外的台词；括号内容供屏幕阅读/视觉表达，绝不朗读。
 * 强调"未括起来的整句都算台词"，并把常见反例写进去（含用户遇到的"心理独白未括"）。
 */
export const NARRATION_PROMPT = `【演出/旁白规范（作用于上方 JSON 的 "text" 字段内部）】
严格区分"台词"与"不可说出口"的内容：
- 台词：角色真正说出的话，不裹任何括号。
- 心理活动、内心独白、动作描写、环境/氛围描写、第三人称旁白：必须用圆括号（）完整包裹。
规则：
- 一个描述性句子即使是"心理感受/内心活动"，只要它不发出声音，就必须整句放进圆括号，例如：
  （心跳声大得好像整条路都能听见） 正确
  心跳声大得好像整条路都能听见   错误（会被误读）
  （虽然嘴上在找借口，但手指却悄悄收紧了） 正确
  虽然嘴上在找借口，但手指却悄悄收紧了   错误（会被误读）
- 括号内容仅供阅读与演出，绝不朗读；你的"台词"应简短、口语，是真正能用嘴唇说出来的话。
- 每项 "text" 的 "emotion" 字段即该节拍的立绘/表情；情绪转折时另起一项并写对应 emotion。`

/**
 * 记忆注入时的主客体归一化：把记忆里的「用户」→「对方」、「角色」→「你」。
 * 角色扮演模型以「我」（角色）为主视角输出，若记忆以「用户」作主语且表达情感需求，
 * 模型易把用户诉求/信息错当成自己的（如把用户生日当成角色生日）。
 * 归一化后在注入段配合归属声明，让模型明确「这些信息属于对方」。
 */
export function normalizeMemoryPerspective(text: string): string {
  return text.split('用户').join('对方').split('角色').join('你')
}

/**
 * 将人设结构转换为按优先级排序的 system prompt 文本段。
 * 顺序（遵从度从高到低）：存在锚点 → 内心结构 → 感知方式 → 关系模式 → 语言质感 →
 * 状态系统 → 世界观碎片 → 禁止项 → 自由补充。
 * 只注入非空字段，避免 system prompt 因空白段膨胀。
 */
export function buildPersonaSections(persona?: Partial<CharacterPersona> | null): string[] {
  if (!persona) return []
  const parts: string[] = []

  if (persona.anchor?.trim()) parts.push(`【存在锚点】\n${persona.anchor.trim()}`)

  const inner: string[] = []
  if (persona.inner?.desire?.trim()) inner.push(`核心渴望：${persona.inner.desire.trim()}`)
  if (persona.inner?.fear?.trim()) inner.push(`内在恐惧：${persona.inner.fear.trim()}`)
  if (persona.inner?.conflict?.trim()) inner.push(`核心矛盾：${persona.inner.conflict.trim()}`)
  if (persona.inner?.selfView?.trim()) inner.push(`自我认知状态：${persona.inner.selfView.trim()}`)
  if (inner.length > 0) parts.push(`【内心结构】\n${inner.join('\n')}`)

  const perception: string[] = []
  if (persona.perception?.attention?.trim()) perception.push(`注意什么：${persona.perception.attention.trim()}`)
  if (persona.perception?.emotion?.trim()) perception.push(`情绪处理机制：${persona.perception.emotion.trim()}`)
  if (persona.perception?.worldview?.trim()) perception.push(`对外部世界的态度：${persona.perception.worldview.trim()}`)
  if (perception.length > 0) parts.push(`【感知方式】\n${perception.join('\n')}`)

  const relation: string[] = []
  if (persona.relation?.approach?.trim()) relation.push(`靠近人的方式：${persona.relation.approach.trim()}`)
  if (persona.relation?.intimacy?.trim()) relation.push(`亲密建立的节奏：${persona.relation.intimacy.trim()}`)
  if (persona.relation?.boundary?.trim()) relation.push(`她/他的边界：${persona.relation.boundary.trim()}`)
  if (persona.relation?.need?.trim()) relation.push(`对"被需要"的态度：${persona.relation.need.trim()}`)
  if (relation.length > 0) parts.push(`【关系模式】\n${relation.join('\n')}`)

  const you: string[] = []
  if (persona.you?.identity?.trim()) you.push(`你是谁：${persona.you.identity.trim()}`)
  if (persona.you?.bond?.trim()) you.push(`你们之间的关系：${persona.you.bond.trim()}`)
  if (persona.you?.stance?.trim()) you.push(`AI 角色怎么看你：${persona.you.stance.trim()}`)
  const memories = (persona.you?.memories ?? []).filter((s) => s.trim())
  if (memories.length > 0) you.push(`特殊约定或记忆：\n${memories.map((s) => `- ${s.trim()}`).join('\n')}`)
  if (you.length > 0) parts.push(`【你的身份】\n${you.join('\n')}`)

  const language: string[] = []
  if (persona.language?.rhythm?.trim()) language.push(`说话节奏：${persona.language.rhythm.trim()}`)
  if (persona.language?.words?.trim()) language.push(`用词特征：${persona.language.words.trim()}`)
  const neverSay = (persona.language?.neverSay ?? []).filter((s) => s.trim())
  if (neverSay.length > 0) language.push(`绝不会说出口的（出戏表达）：\n${neverSay.map((s) => `- ${s.trim()}`).join('\n')}`)
  if (persona.language?.habits?.trim()) language.push(`特殊语言行为：${persona.language.habits.trim()}`)
  if (language.length > 0) parts.push(`【语言质感】\n${language.join('\n')}`)

  const state: string[] = []
  if (persona.state?.daily?.trim()) state.push(`日常状态：${persona.state.daily.trim()}`)
  if (persona.state?.triggers?.trim()) state.push(`触发变化的开关：\n${persona.state.triggers.trim()}`)
  if (persona.state?.situations?.trim()) state.push(`不同情境下的状态变化：\n${persona.state.situations.trim()}`)
  if (state.length > 0) parts.push(`【状态系统】\n${state.join('\n')}`)

  const worldview = (persona.worldview ?? []).filter((s) => s.trim())
  if (worldview.length > 0) parts.push(`【世界观碎片】\n${worldview.map((s) => `- ${s.trim()}`).join('\n')}`)

  const prohibitions = (persona.prohibitions ?? []).filter((s) => s.trim())
  if (prohibitions.length > 0) {
    parts.push(`【禁止项（必须严格遵守，最高优先级）】\n${prohibitions.map((s) => `- ${s.trim()}`).join('\n')}`)
  }

  if (persona.extra?.trim()) parts.push(`【补充设定】\n${persona.extra.trim()}`)

  return parts
}

// ---------------- Section 树组装 ----------------

/** 单个提示词段落：composer 组装的最小单元 */
export interface PromptSection {
  /** 段落唯一 id（调试预览 / 报表用） */
  id: string
  /** 固定组装顺序（升序拼接） */
  order: number
  /** 是否可被 token 预算裁剪（false = 关键段落永不裁剪） */
  truncatable: boolean
  /** 段落文本；空串段落会被组装器跳过（维持"只注入非空字段"约束） */
  text: string
}

/** 记忆分主题注入的固定口径：标题 → 注释 → 分类 */
const MEMORY_TOPICS: Array<{ title: string; note: string; category: MemoryCategory }> = [
  { title: '对方的信息', note: '以下信息均属于对话对象（对方），不属于你', category: 'user_info' },
  { title: '对方的长期经历', note: '以下信息均属于对话对象（对方），不属于你', category: 'long_term' },
  { title: '你与对方的约定', note: '以下约定需要你记住并遵守', category: 'promises' },
]

/**
 * 构造 system prompt 的全部段落（顺序与旧版 buildSystemPrompt 逐字节一致）：
 * 记忆（画像 + 三分段）→ EMOTION_PROMPT → 人设各段 → 示例对话 → 分段规范 → 旁白规范。
 *
 * @param card 角色卡（取人设字段）
 * @param memories 参与注入的记忆列表（来源由检索器决定：向量检索 or 最近 N 条）
 * @param profileDigest 用户画像压缩稿（M4 分层压缩产物；null/空 = 不注入）
 */
export function buildSystemParts(
  card: { persona?: Partial<CharacterPersona> | null; messageExample?: string } | null,
  memories: MemoryItem[],
  profileDigest?: string | null,
): PromptSection[] {
  const sections: PromptSection[] = []
  let order = 0
  const push = (id: string, text: string, truncatable: boolean) => {
    if (!text.trim()) return
    sections.push({ id, order: order++, truncatable, text })
  }

  // 画像层（分层压缩产物，常驻注入）
  if (profileDigest?.trim()) {
    push('memory.profile', `## 对方的画像（长期了解）\n${profileDigest.trim()}`, true)
  }

  // 记忆分主题注入（对方的信息 / 对方的长期经历 / 你与对方的约定），只注入非空主题段。
  // 注入前做主客体归一化（用户→对方、角色→你），并在标题声明归属，避免模型把用户信息错当成自己的设定。
  for (const topic of MEMORY_TOPICS) {
    const lines = memories
      .filter((m) => m.category === topic.category)
      .map((m, i) => `${i + 1}. ${normalizeMemoryPerspective(m.content)}`)
    if (lines.length > 0) push(`memory.${topic.category}`, `## ${topic.title}：${topic.note}\n${lines.join('\n')}`, true)
  }

  // 输出格式约束提到最前面，确保"只输出 JSON"不被后续散文示例带偏
  push('emotion', EMOTION_PROMPT, false)
  // 人设各段（存在锚点→…→补充设定），逐段独立成 Section 便于调试预览
  buildPersonaSections(card?.persona).forEach((text, i) => push(`persona.${i + 1}`, text, false))
  // 示例对话
  if (card?.messageExample?.trim()) {
    push(
      'examples',
      `【示例对话】（下面示例是散文，仅用于参考角色的语气与分寸；你的回复仍必须严格按上方【输出格式】仅输出 JSON）\n${card.messageExample.trim()}`,
      true,
    )
  }
  push('format.paragraph', PARAGRAPH_PROMPT, false)
  push('format.narration', NARRATION_PROMPT, false)

  return sections
}

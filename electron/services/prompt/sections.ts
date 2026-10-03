/**
 * 提示词段落库（纯函数，零 Electron 依赖，便于金样测试）。
 *
 * 从 repository.ts 平移而来的段落文本（EMOTION_PROMPT / PARAGRAPH_PROMPT /
 * NARRATION_PROMPT / buildPersonaSections / normalizeMemoryPerspective）保持逐字节不变，
 * 并新增 buildSystemParts：把 system prompt 拆成带 id 的 PromptSection 列表，
 * 交给 composer.compose 组装。段落顺序与旧版 buildSystemPrompt 严格一致。
 */
import type { CharacterPersona, MemoryCategory, MemoryItem } from '../../../src/types'

/**
 * 输出格式段模板（情绪演出指令）：约束 AI 输出结构化 JSON dialogue 数组（每项必带 emotion），
 * 供解析驱动桌宠形象按节拍切换立绘。listBlock/exampleBlock 按角色词表填充。
 */
function emotionTemplate(listBlock: string, exampleBlock: string): string {
  return `【输出格式（最高优先，绝对不可违背）】
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
${listBlock}
- 心理活动、动作、环境、第三人称旁白等"不发声"的内容，必须写进 "text" 的（）内；台词与旁白可各占一项，也可以在同一项里先括号后台词（emotion 取台词的情绪）。
- 情绪转折就另起一项写对应 emotion；同情绪连续的多项会被系统自动合并，不会重复切换。
- 即使你想输出问候、解释或额外旁白，也都只能放进 "text"，绝不允许出现在 JSON 之外。
- JSON 结构字符必须用半角符号：引号 " 、冒号 : 、逗号 , 、花括号 { }、方括号 [ ]。
  严禁用全角符号（：”“ ，｛｝【】）替代，也严禁给 "text"/"emotion" 的值漏写引号；
  台词文本内容内部不受此限制。
- "dialogue" 数组的每一项必须是 {"text":"…","emotion":"…"} 对象，禁止把元素写成纯字符串，禁止输出数组以外的内容。
- "text" 内如使用圆括号（）包裹旁白/动作描写，左右括号必须成对完整闭合，不得漏写右括号。

${exampleBlock}`
}

/**
 * 按角色情绪词表生成输出格式段（系统内唯一入口，palette 缺省 = 内置最小词表）。
 * 值域块与示例块都来自词表：每词附中文释义；示例取非默认词轮转填充、括号旁白行固定用默认词。
 * @param palette 角色绑定的情绪词表（缺省/未打标立绘集 = 内置最小词表，仅"平静"）
 */
export function buildEmotionPrompt(palette?: { entries: Array<{ name: string; gloss: string }>; defaultEmotion: string } | null): string {
  const pal = palette && palette.entries.length > 0
    ? palette
    : { entries: [{ name: '平静', gloss: '从容放松' }], defaultEmotion: '平静' }
  // 词值域行：每词附中文释义，帮助模型按语义选词；超过 4 词换行分组，避免单行过长
  const items = pal.entries.map((e) => (e.gloss.trim() ? `${e.name}(${e.gloss.trim()})` : e.name))
  const lines: string[] = []
  for (let i = 0; i < items.length; i += 4) lines.push('  ' + items.slice(i, i + 4).join(' / '))
  const defEntry = pal.entries.find((e) => e.name === pal.defaultEmotion)
  const defLabel = defEntry ? pal.defaultEmotion : pal.entries[0]!.name
  const listBlock = `- "emotion" 只能从本角色的情绪表中选取（共 ${pal.entries.length} 个）：
${lines.join('\n')}
  匹配不到时：使用 ${defLabel}${defEntry?.gloss.trim() ? `(${defEntry.gloss.trim()})` : ''}。`
  // 示例情绪值替换：优先取 3 个非默认词（不足时循环复用），括号旁白行固定用默认词
  const others = pal.entries.map((e) => e.name).filter((n) => n !== defLabel)
  const pick = (i: number) => (others.length > 0 ? others[i % others.length]! : defLabel)
  const exampleBlock = `示例（你唯一允许的输出形态，前后无任何多余字符）：
{"dialogue":[
  {"text":"……你终于来了。","emotion":"${pick(0)}"},
  {"text":"（心跳漏了一拍，站在原地）","emotion":"${defLabel}"},
  {"text":"（快步走到门口，却又停住脚步）这次、这次你要去哪里？","emotion":"${pick(1)}"},
  {"text":"不过、现在看到你，就都好了。","emotion":"${pick(2)}"}
]}`
  return emotionTemplate(listBlock, exampleBlock)
}

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
- 【最高优先】台词绝对不能用（）或()包裹——括号内的内容一律被视为心理/动作/场景，系统不会朗读它；把台词写进括号等于让角色闭嘴。
- 心理活动、内心独白、动作描写、环境/氛围描写、第三人称旁白：必须用圆括号（）完整包裹。
规则：
- 一个描述性句子即使是"心理感受/内心活动"，只要它不发出声音，就必须整句放进圆括号，例如：
  （心跳声大得好像整条路都能听见） 正确
  心跳声大得好像整条路都能听见   错误（会被误读）
  （虽然嘴上在找借口，但手指却悄悄收紧了） 正确
  虽然嘴上在找借口，但手指却悄悄收紧了   错误（会被误读）
- 括号内容仅供阅读与演出，绝不朗读；你的"台词"应简短、口语，是真正能用嘴唇说出来的话。
- 【动作归属】（括号）动作的归属以消息归属为准：你发出的消息里的动作是你做的，对方消息里的动作是对方做的。回忆此前互动时不要因人称"你"而改变归属——例如你写过"戳了戳对方的手心"，事后回忆仍是你戳了对方，绝不是对方戳了你。
- 【动作一致性】括号内的动作必须发生在"此刻"：先确认你们现在在哪里、正在做什么（走路/坐着/站着），动作只能使用场景中真实存在的物件，不得与当前状态矛盾。错误示范（✗ 禁止照抄）：你们正在海边散步，却写"（偷偷把小指勾进他的手指里，尾巴卷住椅子腿）"——走路时没有椅子；正确写法如"（走在海堤上，风吹得尾巴乱了，耳朵压得低低的）"。动作要贴合"你们此刻正在做的事"，不要套用与当前情境无关的固定动作模板。
- 每项 "text" 的 "emotion" 字段即该节拍的立绘/表情；情绪转折时另起一项并写对应 emotion。`

/**
 * 台词模式规范（stripParenNarration 开启时替换 NARRATION_PROMPT 注入）：
 * 禁止输出任何括号旁白与描写性内容，只输出真正说出口的台词。
 * 声明覆盖【节拍/分段规范】中的括号示例，避免两段互相矛盾。
 */
export const DIALOGUE_ONLY_PROMPT = `【演出/旁白规范（台词模式，作用于上方 JSON 的 "text" 字段内部）】
当前已开启「回答仅含台词」模式，本段与前文任何涉及括号的规定冲突时，以本段为准：
- 【最高优先】任何心理活动、内心独白、动作、表情、环境/氛围、第三人称旁白，一律不要输出——无论是放进圆括号（（）或()）还是写成独立句子。
- 你只能输出角色真正说出口的台词；"text" 里禁止出现任何形式的圆括号。
- 上方【节拍/分段规范】中"台词与（括号旁白）可各自成为一项"及所有括号示例全部作废：分段只按台词的自然节奏与情绪转折进行。
- 台词应自带足够的语气与信息量，让听者不需要动作描写也能理解情境。
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
 * 记忆里的角色名 → 「你」（第三人称档案体约定的注入侧回转）。
 * 沉淀记忆以「{角色名}/用户」作第三人称主语；注入时把角色名换回「你」，配合上方
 * 「用户→对方」归一化与分主题归属声明，让模型以角色本人视角无歧义地读取。
 * 对旧约定（你/对方）的存量文本是空操作，不改变金样输出。
 */
function applyCardNameToYou(text: string, cardName: string | undefined): string {
  const name = cardName?.trim()
  return name ? text.split(name).join('你') : text
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

/** 主动搭话常驻说明（仅 enableProactive 时注入）：让角色知道自己可以主动开口，并教它消化系统旁白。
 *  措辞与 chatTurn.PROACTIVE_NARRATION_PREFIX 的【系统旁白】标记呼应：明确"user 消息里的旁白描述的是
 *  角色本人（你）的动作"，防止模型把旁白当成对方说的话（曾因此把搭话旁白当成用户发言来回应）。 */
export const PROACTIVE_HINT_PROMPT = `（你可以主动发起话题，不需要等待对方先说话。当"用户消息"里出现以【系统旁白】开头的舞台指示时：它描述的是角色本人（你）的动作与心情，不是对方说的话——请把它当作你自己的举动来消化，以你自己的口吻自然开口，不要提及旁白或系统，也不要复述旁白。）`

/**
 * 构造 system prompt 的全部段落（顺序与旧版 buildSystemPrompt 逐字节一致）：
 * 记忆（画像 + 三分段）→ EMOTION_PROMPT → 人设各段 → 示例对话 → 分段规范 → 旁白规范 →（可选）主动搭话说明。
 *
 * @param card 角色卡（取人设字段）
 * @param memories 参与注入的记忆列表（来源由检索器决定：向量检索 or 最近 N 条）
 * @param profileDigest 用户画像压缩稿（M4 分层压缩产物；null/空 = 不注入）
 * @param proactiveHint 是否注入主动搭话说明（enableProactive 开启时为 true）
 * @param storyDirective 剧情导演指令段（仅剧情演出轮次注入；缺省不注入，金样输出不变）
 * @param stripParenNarration 台词模式（「回答仅含台词」开启时为 true）：用 DIALOGUE_ONLY_PROMPT
 *   替换 NARRATION_PROMPT 注入。缺省 false，金样输出不变。
 * @param emotionPalette 角色绑定的情绪词表（缺省/null = 未启用词表，输出格式段维持金样原文）
 */
export function buildSystemParts(
  card: { name?: string; persona?: Partial<CharacterPersona> | null; messageExample?: string } | null,
  memories: MemoryItem[],
  profileDigest?: string | null,
  proactiveHint?: boolean,
  storyDirective?: string | null,
  stripParenNarration?: boolean,
  emotionPalette?: { entries: Array<{ name: string; gloss: string }>; defaultEmotion: string } | null,
): PromptSection[] {
  const sections: PromptSection[] = []
  let order = 0
  const push = (id: string, text: string, truncatable: boolean) => {
    if (!text.trim()) return
    sections.push({ id, order: order++, truncatable, text })
  }

  // 画像层（分层压缩产物，常驻注入）。画像存储为第三人称档案体（与记忆同款口径：用户/{角色名}），
  // 注入前做与记忆一致的主客体归一（{角色名}→你、用户→对方），让模型以角色视角无歧义读取
  if (profileDigest?.trim()) {
    const digest = normalizeMemoryPerspective(applyCardNameToYou(profileDigest.trim(), card?.name))
    push('memory.profile', `## 对方的画像（长期了解）\n${digest}`, true)
  }

  // 记忆分主题注入（对方的信息 / 对方的长期经历 / 你与对方的约定），只注入非空主题段。
  // 注入前做主客体归一化：第三人称档案体（{角色名}/用户）→ 角色视角（你/对方），
  // 并在标题声明归属，避免模型把用户信息错当成自己的设定。
  const cardName = card?.name
  for (const topic of MEMORY_TOPICS) {
    const lines = memories
      .filter((m) => m.category === topic.category)
      .map((m, i) => `${i + 1}. ${normalizeMemoryPerspective(applyCardNameToYou(m.content, cardName))}`)
    if (lines.length > 0) push(`memory.${topic.category}`, `## ${topic.title}：${topic.note}\n${lines.join('\n')}`, true)
  }

  // 输出格式约束提到最前面，确保"只输出 JSON"不被后续散文示例带偏
  // 词表启用时 emotion 值域/示例按角色词表生成；未启用时与金样逐字节一致
  push('emotion', buildEmotionPrompt(emotionPalette), false)
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
  // 旁白规范：台词模式（回答仅含台词）下替换为禁括号版本，其余场景维持原文（金样逐字节一致）
  push('format.narration', stripParenNarration ? DIALOGUE_ONLY_PROMPT : NARRATION_PROMPT, false)
  // 主动搭话说明（仅开启时注入；位于段落末尾，作为行为能力说明而非人设）
  if (proactiveHint) push('proactive', PROACTIVE_HINT_PROMPT, false)
  // 剧情导演指令（仅剧情演出轮次注入；让 AI 保持演出节奏与叙事边界）
  if (storyDirective?.trim()) push('story', storyDirective.trim(), false)

  return sections
}

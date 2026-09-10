/**
 * PromptComposer 金样测试（零依赖：文本段参考实现内联钉版，防止段落平移/重构导致输出漂移）。
 *
 * 参考实现 referenceBuildSystemPrompt 是重构前 buildSystemPrompt 的逐字节拷贝；
 * 测试把它与新的 buildSystemParts + composeSystemPrompt 组装结果在多组夹具下逐一比对，
 * 任何差异（文本漂移、段落顺序变化、空段处理差异）都会使脚本以非零码退出。
 */
import type { CharacterCard, CharacterPersona, MemoryItem } from '../src/types'
import { buildSystemParts } from '../electron/services/prompt/sections'
import { composeSystemPrompt } from '../electron/services/prompt/composer'

// ---------- 参考实现（重构前 buildSystemPrompt 的逐字节拷贝，禁止修改） ----------

const REF_EMOTION_PROMPT = `【输出格式（最高优先，绝对不可违背）】
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

const REF_PARAGRAPH_PROMPT = `【节拍/分段规范（作用于上方 JSON 的 "text" 字段内部）】
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

const REF_NARRATION_PROMPT = `【演出/旁白规范（作用于上方 JSON 的 "text" 字段内部）】
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

function refNormalizeMemoryPerspective(text: string): string {
  return text.split('用户').join('对方').split('角色').join('你')
}

type Persona = CharacterCard['persona']

/** 空人设基座（与 repository.ts 的 EMPTY_PERSONA 结构一致），夹具在其上覆盖字段 */
const EMPTY_PERSONA: CharacterPersona = {
  anchor: '',
  inner: { desire: '', fear: '', conflict: '', selfView: '' },
  perception: { attention: '', emotion: '', worldview: '' },
  relation: { approach: '', intimacy: '', boundary: '', need: '' },
  you: { identity: '', bond: '', stance: '', memories: [] },
  language: { rhythm: '', words: '', neverSay: [], habits: '' },
  state: { daily: '', triggers: '', situations: '' },
  worldview: [],
  prohibitions: [],
  extra: '',
}

function refBuildPersonaSections(persona?: Partial<Persona> | null): string[] {
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

/** 重构前的 buildSystemPrompt（无画像段；profileDigest 仅在新实现侧验证追加行为） */
function referenceBuildSystemPrompt(
  card: CharacterCard | null,
  memories: MemoryItem[],
  userName = '用户',
): string {
  const parts: string[] = []

  const byCategory = (cat: MemoryItem['category']) => memories.filter((m) => m.category === cat)
  const pushMemories = (title: string, note: string, cat: MemoryItem['category']) => {
    const lines = byCategory(cat).map((m, i) => `${i + 1}. ${refNormalizeMemoryPerspective(m.content)}`)
    if (lines.length > 0) parts.push(`## ${title}：${note}\n${lines.join('\n')}`)
  }
  pushMemories('对方的信息', '以下信息均属于对话对象（对方），不属于你', 'user_info')
  pushMemories('对方的长期经历', '以下信息均属于对话对象（对方），不属于你', 'long_term')
  pushMemories('你与对方的约定', '以下约定需要你记住并遵守', 'promises')

  parts.push(REF_EMOTION_PROMPT)
  parts.push(...refBuildPersonaSections(card?.persona))
  if (card?.messageExample?.trim()) {
    parts.push(`【示例对话】（下面示例是散文，仅用于参考角色的语气与分寸；你的回复仍必须严格按上方【输出格式】仅输出 JSON）\n${card.messageExample.trim()}`)
  }
  parts.push(REF_PARAGRAPH_PROMPT)
  parts.push(REF_NARRATION_PROMPT)
  const joined = parts.join('\n\n')
  return userName ? joined.split('%player%').join(userName) : joined
}

// ---------- 新实现桥接（与 repository.buildSystemPrompt 相同的调用方式） ----------

function newBuildSystemPrompt(
  card: CharacterCard | null,
  memories: MemoryItem[],
  userName = '用户',
  profileDigest?: string | null,
): string {
  return composeSystemPrompt(buildSystemParts(card, memories, profileDigest), { userName }).text
}

// ---------- 夹具与断言 ----------

function mem(id: string, category: MemoryItem['category'], content: string): MemoryItem {
  return { id, content, createdAt: 0, category, characterCardId: null, confirmed: true }
}

interface Fixture {
  name: string
  card: CharacterCard | null
  memories: MemoryItem[]
  userName?: string
  profileDigest?: string | null
}

const fullPersona: Persona = {
  ...EMPTY_PERSONA,
  anchor: '出生于海滨小镇的少女，现在独居在城市公寓。',
  inner: { desire: '被真正理解', fear: '被抛下', conflict: '渴望靠近又害怕受伤', selfView: '平凡但努力的人' },
  perception: { attention: '对方的语气变化', emotion: '先压后爆', worldview: '世界温柔而残酷' },
  relation: { approach: '慢慢靠近', intimacy: '需要长期积累', boundary: '讨厌被命令', need: '希望被需要' },
  you: { identity: '青梅竹马', bond: '十年相识', stance: '珍视对方', memories: ['一起看过流星'] },
  language: { rhythm: '短句为主', words: '偶尔方言', neverSay: ['脏话'], habits: '紧张时摸头发' },
  state: { daily: '安静', triggers: '被夸奖会脸红', situations: '深夜更坦诚' },
  worldview: ['海边的夏天', '旧书店的猫'],
  prohibitions: ['不谈论政治', '不说教'],
  extra: '喜欢椰奶咖啡。',
}

const fullCard: CharacterCard = {
  id: 'card_test',
  name: '测试角色',
  version: 2,
  persona: fullPersona,
  messageExample: '%player%: 今天过得怎么样？\n{{char}}: 还行啦，就是有点想你。',
  modelId: null,
  voiceId: null,
  voiceMode: 'none',
  genieOverride: null,
  ttsOverride: null,
  modelOverride: null,
  renderMode: null,
  spriteId: null,
  emotionMap: null,
  live2dExpressionMap: null,
  avatar: null,
  createdAt: 0,
  updatedAt: 0,
}

const fixtures: Fixture[] = [
  { name: '空卡片 + 无记忆', card: null, memories: [] },
  { name: '完整卡片 + 全分类记忆 + 默认称呼', card: fullCard, memories: [
    mem('m1', 'user_info', '用户喜欢喝椰奶'),
    mem('m2', 'long_term', '上周一起去了海边'),
    mem('m3', 'promises', '你答应陪对方去看流星雨'),
    mem('m4', 'user_info', '角色养的猫叫小雪'),
  ] },
  { name: '%player% 占位符替换', card: fullCard, memories: [], userName: '小海' },
  { name: '空串/空白记忆与空白人设字段过滤', card: { ...fullCard, persona: { anchor: '  ', inner: { desire: '', fear: '', conflict: '', selfView: '' } } as Persona, messageExample: '   ' }, memories: [
    mem('m5', 'user_info', '   '),
    mem('m6', 'long_term', '有效记忆内容'),
  ] },
  { name: '注入画像段（新能力，非金样比对，仅验证可拼接）', card: fullCard, memories: [mem('m7', 'user_info', '对方喜欢星空')], profileDigest: '对方是一名喜欢天文的大学生。' },
]

function main(): number {
  let failed = 0
  for (const fx of fixtures) {
    const reference = referenceBuildSystemPrompt(fx.card, fx.memories, fx.userName ?? '用户')
    const actual = newBuildSystemPrompt(fx.card, fx.memories, fx.userName ?? '用户', fx.profileDigest)
    if (fx.profileDigest) {
      // 画像段为新增能力：只验证画像段位于最前且其余内容与金样一致
      const digestPart = `## 对方的画像（长期了解）\n${fx.profileDigest.trim()}\n\n`
      if (!actual.startsWith(digestPart)) {
        console.error(`[FAIL] ${fx.name}: 画像段缺失或位置错误`)
        failed++
        continue
      }
      if (actual.slice(digestPart.length) !== reference) {
        console.error(`[FAIL] ${fx.name}: 画像段之后的正文与金样不一致`)
        console.error('--- reference head ---\n' + reference.slice(0, 200))
        console.error('--- actual head ---\n' + actual.slice(digestPart.length, digestPart.length + 200))
        failed++
      } else {
        console.log(`[PASS] ${fx.name}`)
      }
      continue
    }
    if (actual !== reference) {
      // 定位首个差异字符，便于修复
      let i = 0
      while (i < Math.min(actual.length, reference.length) && actual[i] === reference[i]) i++
      console.error(`[FAIL] ${fx.name}: 输出与金样不一致（首个差异位于第 ${i} 字符）`)
      console.error('--- reference 上下文 ---\n' + JSON.stringify(reference.slice(Math.max(0, i - 40), i + 40)))
      console.error('--- actual    上下文 ---\n' + JSON.stringify(actual.slice(Math.max(0, i - 40), i + 40)))
      failed++
    } else {
      console.log(`[PASS] ${fx.name}（${actual.length} 字符逐字节一致）`)
    }
  }
  if (failed > 0) {
    console.error(`\n金样测试失败：${failed} 组夹具不一致`)
    return 1
  }
  console.log('\n金样测试全部通过：PromptComposer 输出与重构前逐字节一致')
  return 0
}

process.exit(main())

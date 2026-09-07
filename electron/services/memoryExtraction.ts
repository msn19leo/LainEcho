/**
 * 记忆自动沉淀：会话流式完成后后台调用 LLM 从对话中抽取值得长期记住的信息，
 * 生成「待确认候选」（confirmed=false）写入记忆库，由用户在设置窗确认/删除。
 *
 * - 独立 prompt + 非流式，与主对话的 JSON 输出契约完全隔离；
 * - 同会话 5 分钟冷却，避免连续重试同一批对话；
 * - 与现有记忆做简单内容去重（完全相同或互相包含即跳过）；
 * - 任何失败静默，不阻塞聊天。
 */
import type { ChatMessage, MemoryCategory } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { addPendingMemory, listMemories } from './repository'
import { windowManager } from '../windows/windowManager'

/** 每次沉淀抽取的最近对话条数 */
const EXTRACT_RECENT_MESSAGES = 20
/** 触发沉淀的最小消息条数（低于该值对话太短，几乎无长期信息，跳过避免浪费调用） */
const EXTRACT_MIN_MESSAGES = 6
/** 同会话重复沉淀的最小间隔（毫秒） */
const EXTRACT_COOLDOWN_MS = 5 * 60 * 1000
/**
 * 抽取请求输出 token 上限：需比主对话更大，给思考型模型（如 mimo-v2.5-pro）
 * 的 reasoning 留出空间，否则 content 可能为空字符串
 */
const EXTRACT_MAX_TOKENS = 2048

/** 记录每个会话最近一次沉淀时间（内存态，重启即失效） */
const lastExtractAt = new Map<string, number>()

/** 抽取 prompt：独立上下文，绝不混入 EMOTION_PROMPT 的 JSON dialogue 约束 */
const EXTRACT_SYSTEM_PROMPT =
  '你是一个对话记忆提取助手。从用户与角色之间的对话中，提取值得长期记住的新信息，' +
  '只输出 JSON 本体（不要 markdown 代码块、不要任何解释）：{"memories":[{"category":"user_info","content":"..."}]}\n' +
  '- category 只能是：\n' +
  '  user_info = 用户信息（用户明确表达或透露的个人信息：姓名/年龄/职业/喜好/雷点/习惯/身份等）\n' +
  '  long_term = 长期经历（重要事件、剧情进展、值得记住的时刻）\n' +
  '  promises = 约定与承诺（明确达成的约定、约好的时间地点、答应做的事，如"明天下午两点提醒我"）\n' +
  '- 提取标准放宽：即使出现在角色扮演对话中，只要信息来自用户一侧且具有长期价值就应提取；' +
  '用户的喜好/称呼归为 user_info，明确的约定（含具体时间）归为 promises。\n' +
  '- 表述视角：描述用户信息时用「对方」称呼用户，描述角色承诺时用「你」称呼角色，' +
  '不使用「用户/角色」作主语（例如写「对方的生日是9月11号」而非「用户的生日是9月11号」）。\n' +
  '- 仅当整段对话确实没有任何值得长期记住的新信息时，才返回 {"memories":[]}。'

/** 抽取结果中的单条记忆 */
interface ExtractedMemory {
  category: MemoryCategory
  content: string
}

/** 判断新记忆是否与现有记忆重复（完全相同或互相包含即视为重复） */
function isDuplicate(content: string, existing: string[]): boolean {
  const c = content.trim()
  return existing.some((e) => {
    const et = e.trim()
    return et === c || (et.length > 8 && (et.includes(c) || c.includes(et)))
  })
}

/**
 * 从一次会话的最近对话中抽取记忆候选并写入记忆库。
 * 触发前做同会话冷却、角色卡、API Key、无对话等轻量校验；失败静默。
 * @param params.sessionId 来源会话 id（写入 sourceSessionId 供追溯）
 * @param params.cardId 归属角色卡 id
 * @param params.messages 含本轮 user+assistant 的完整消息序列
 */
export async function extractMemoriesFromSession(params: {
  sessionId: string
  cardId: string
  messages: ChatMessage[]
  settings: { model: string; baseURL: string; apiKey: string }
}): Promise<void> {
  const { sessionId, cardId, messages, settings } = params
  if (!cardId || !settings.apiKey) return
  // 对话过短（不足 3 轮问答）时跳过，避免反复发起注定为空的抽取
  if (messages.length < EXTRACT_MIN_MESSAGES) return

  // 同会话冷却：5 分钟内不重复抽取
  const now = Date.now()
  const last = lastExtractAt.get(sessionId) ?? 0
  if (now - last < EXTRACT_COOLDOWN_MS) return
  lastExtractAt.set(sessionId, now)

  // 取最近一段对话的纯净文本（跳过 UI 元数据）
  const recent = messages.slice(-EXTRACT_RECENT_MESSAGES)
  const dialogueText = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? '用户' : '角色'}: ${m.content}`)
    .join('\n')
    .trim()
  if (!dialogueText) return

  try {
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: `以下是对话：\n${dialogueText}\n\n请提取记忆：` },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        temperature: 0.2,
        stream: false,
        maxTokensOverride: EXTRACT_MAX_TOKENS,
      },
    )
    const parsed = parseExtractionJson(raw)
    if (!parsed || parsed.length === 0) {
      // 打印模型原始返回（截断）与模型名，便于区分「模型判定无信息」/「JSON 解析失败」/「content 为空（思考模型预算被占满）」
      console.log(
        '[memory] 抽取无结果 model=%s 输入对话 %d 字符，原始返回（前 300 字符）：%s',
        settings.model,
        dialogueText.length,
        (raw ?? '').trim().slice(0, 300),
      )
      return
    }

    // 去重：与该角色（含全局背景）现有全部记忆比对
    const existing = (await listMemories()).map((m) => m.content)
    const fresh = parsed.filter((m) => !isDuplicate(m.content, existing))
    if (fresh.length === 0) return

    for (const m of fresh) {
      await addPendingMemory({
        content: m.content,
        category: m.category,
        characterCardId: cardId,
        sourceSessionId: sessionId,
      })
    }
    if (fresh.length > 0) {
      // 广播记忆变更给设置窗刷新（待确认列表）
      windowManager.broadcast('memory:changed')
      console.log('[memory] 自动沉淀 %d 条候选记忆', fresh.length)
    }
  } catch (err) {
    // 沉淀失败静默：不阻塞聊天、不影响用户
    console.warn('[memory] 自动沉淀失败：', err)
  }
}

/** 解析抽取结果 JSON：容忍 markdown 围栏与前后杂文本；无有效记忆返回 null */
function parseExtractionJson(raw: string): ExtractedMemory[] | null {
  const block = raw.replace(/```json\s*/gi, '').replace(/```/g, '')
  const start = block.indexOf('{')
  const end = block.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(block.slice(start, end + 1)) as {
      memories?: Array<{ category?: string; content?: string }>
    }
    if (!Array.isArray(parsed?.memories)) return null
    const valid = parsed.memories
      .filter((m) => {
        const cat = m?.category
        return (
          (cat === 'user_info' || cat === 'long_term' || cat === 'promises') &&
          typeof m?.content === 'string' &&
          m.content.trim()
        )
      })
      .map((m) => ({ category: m!.category! as MemoryCategory, content: m!.content!.trim() }))
    return valid.length > 0 ? valid : null
  } catch {
    return null
  }
}

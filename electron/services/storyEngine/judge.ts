/**
 * AI 判定结局（chapter_end.aiJudge）：章末由 LLM 依据整局 run 对话表现在选项中择一。
 *
 * 实现要点（设计文档 7.1）：
 *  - 复用主 LLM 配置的非流式小调用（独立 system prompt，绝不复用聊天 EMOTION_PROMPT 契约）；
 *  - 剥离 <think> 块、给足 max_tokens（沿用主动搭话旁白教训：思考型模型的 reasoning 计入预算）；
 *  - 输出匹配按 id → label → 包含关系逐级放宽；全部失配 = 判定失败，回退 nextChapter 缺省行为；
 *  - 判定结果写入 run 变量（varName，缺省 ending），供后续章节 condition / branches 引用。
 */
import type { ChatMessage, StoryAiJudge } from '../../../src/types'
import { sendChatCompletion } from '../aiClient'
import { readApiKey } from '../crypto'
import { getSettings } from '../repository'
import type { RunRuntime } from './engine'

/** 判定专用 system prompt：只输出选项 id，不输出任何其他内容 */
const JUDGE_SYSTEM_PROMPT =
  '你是剧情演出的结局裁判。根据给出的对话记录与判定要求，从候选结局中选出最贴切的一个。' +
  '你的回复必须且只能是一个选项的英文标识（id），不要输出解释、引号、标点或其他任何内容。'

/** 对话记录压缩上限（字符）：超长保留开头 1/3 + 结尾 2/3，避免超出上下文 */
const TRANSCRIPT_MAX_CHARS = 6000

/** 把 run 消息压缩成裁判可读的对话记录（导演指令与空文本剔除） */
function buildTranscript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = m.content.trim()
    if (!text || text.startsWith('（剧情演出：')) continue
    const speaker = m.role === 'user' ? (m.meta?.storyKind === 'narration' ? '旁白' : '对方') : '角色'
    lines.push(`${speaker}：${text}`)
  }
  const total = lines.join('\n')
  if (total.length <= TRANSCRIPT_MAX_CHARS) return total
  const head = lines.reduce((acc, l) => (acc.length + l.length + 1 <= TRANSCRIPT_MAX_CHARS / 3 ? `${acc}\n${l}` : acc), '')
  const tailLines: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const joined = tailLines.join('\n')
    if (joined.length + (lines[i] as string).length + 1 > (TRANSCRIPT_MAX_CHARS * 2) / 3) break
    tailLines.unshift(lines[i] as string)
  }
  return `${head}\n……（中间部分省略）……\n${tailLines.join('\n')}`
}

/** 归一化模型输出用于匹配：剥 <think>、去引号/空白/句末标点、转小写 */
function normalizeOutput(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim()
    .replace(/^["'「『]+|["'」』。.!！?？\s]+$/g, '')
    .toLowerCase()
}

/** 在输出中匹配命中的选项：id 精确 → id 包含 → label 包含 */
function matchOption(output: string, options: StoryAiJudge['options']): StoryAiJudge['options'][number] | null {
  const norm = normalizeOutput(output)
  if (!norm) return null
  const byId = options.find((o) => o.id.toLowerCase() === norm)
  if (byId) return byId
  const containsId = options.filter((o) => norm.includes(o.id.toLowerCase()))
  if (containsId.length === 1) return containsId[0]!
  const byLabel = options.find((o) => norm.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(norm))
  if (byLabel) return byLabel
  return null
}

/**
 * 执行 AI 判定：返回命中的选项（失败/无法匹配时 null，由调用方回退缺省行为）。
 * 任何异常（未配置 Key / 网络失败）都视为判定失败并记录日志，不打断演出。
 */
export async function judgeEnding(rt: RunRuntime, judge: StoryAiJudge): Promise<StoryAiJudge['options'][number] | null> {
  try {
    const settings = await getSettings()
    const apiKey = await readApiKey()
    if (!apiKey || !settings.baseURL.trim() || !settings.model.trim()) {
      console.warn('[story] AI 判定跳过：未配置 LLM API（回退缺省章节）')
      return null
    }
    const optionList = judge.options.map((o) => `- ${o.id}：${o.label}`).join('\n')
    const userContent =
      `【判定要求】\n${judge.prompt}\n\n` +
      `【候选结局】\n${optionList}\n\n` +
      `【对话记录（剧情「${rt.bundle.meta.title}」整局演出）】\n${buildTranscript(rt.run.messages)}\n\n` +
      '请只输出最贴切选项的 id。'
    const output = await sendChatCompletion(
      [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.3,
        stream: false,
        // 思考型模型的 reasoning 计入 max_tokens：给足余量避免思考耗尽预算、content 为空
        maxTokensOverride: Math.max(settings.maxTokens ?? 0, 2048),
      },
    )
    const hit = matchOption(output, judge.options)
    if (!hit) {
      console.warn('[story] AI 判定输出无法匹配选项（raw=%j），回退缺省章节', String(output).slice(0, 120))
      return null
    }
    console.log('[story] AI 判定结局：%s（%s）', hit.id, hit.label)
    return hit
  } catch (err) {
    console.warn('[story] AI 判定失败（回退缺省章节）：', err instanceof Error ? err.message : err)
    return null
  }
}

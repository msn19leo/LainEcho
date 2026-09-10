/**
 * 主动搭话策略分发：SCREEN（屏幕感知）与 TOPIC（普通话题）加权轮盘。
 *
 * - 职责拆分：selectIntentKind 只做轮盘决策（快、同步），旁白文本推迟到真正投放时
 *   由 buildNarration 生成——被闸门拦截时不白白调用 LLM，且重试时旁白会重新生成
 *   （网络瞬断导致的"LLM 生成失败 → 固定模板被缓存"问题由此消除）；
 * - 双开关都开启（enableProactive + enableScreenSense）：SCREEN 权重 0.7 / TOPIC 0.3，
 *   即"先感知屏幕，再以屏幕内容搭话"为主、普通话题为辅；
 * - 仅开启主动搭话：SCREEN 权重为 0（等价纯 TOPIC）；
 * - 投放时屏幕感知不可用（未配视觉模型 / 截图失败）→ 自动降级 TOPIC 旁白，绝不阻塞。
 *
 * 旁白文案对齐，以（括号）舞台指示写入对话历史，
 * AI 以自己的口吻消化后自然开口，而非硬拼模板话术。
 */
import type { AppSettings } from '../../../src/types'
import { readApiKey } from '../crypto'
import { sendChatCompletion } from '../aiClient'
import { analyzeScreen } from './screenAnalyzer'

/** 意图类型：屏幕感知 / 普通话题 */
export type ProactiveIntentKind = 'screen' | 'topic'

/** 各意图的 pending 队列 TTL：屏幕转述很快过期，过时即弃 */
export function intentTtlMs(kind: ProactiveIntentKind): number {
  return kind === 'screen' ? 120_000 : 300_000
}

/** 双开关开启时 SCREEN 的轮盘权重（其余归 TOPIC） */
const SCREEN_WEIGHT = 0.7

/** 旁白生成 LLM 调用的输出 token 上限：mimo 等思考型模型的 reasoning 会占用预算，
 *  预算太小会导致 content 为空字符串（同 memoryExtraction 的踩坑），因此放大到与抽取一致 */
const NARRATION_MAX_TOKENS = 2048

/**
 * 轮盘决策（同步、零 I/O）：决定本轮意图类型，旁白推迟到投放时生成。
 */
export function selectIntentKind(settings: AppSettings): ProactiveIntentKind {
  const screenEnabled = settings.enableProactive && settings.enableScreenSense
  if (screenEnabled && Math.random() < SCREEN_WEIGHT) return 'screen'
  return 'topic'
}

/**
 * 投放时生成旁白（闸门通过后才调用，避免无谓的 LLM 消耗）。
 * @param kind 意图类型；screen 感知失败时自动降级为 TOPIC 旁白
 * @returns 括号包裹的舞台指示旁白（永不 throw）
 */
export async function buildNarration(kind: ProactiveIntentKind, settings: AppSettings): Promise<string> {
  const userName = settings.userName || '用户'
  if (kind === 'screen') {
    const analysis = await analyzeScreen()
    if (analysis) {
      return `（你瞥了一眼${userName}的电脑桌面：${analysis}。你忍不住想聊两句。）`
    }
    // 屏幕感知不可用 → 降级 TOPIC 旁白（保证"双开关 = 一定搭话"的体验）
    console.log('[proactive] 屏幕感知不可用，降级为 TOPIC 旁白')
  }
  return topicNarration(settings)
}

/** 当前时段的人话描述（LLM 旁白生成素材，让旁白带时间感） */
function periodLabel(): string {
  const h = new Date().getHours()
  if (h < 5) return '深夜'
  if (h < 9) return '清晨'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

/**
 * 生成 TOPIC 旁白：proactiveLlmNarration 开启时由 LLM 按当前时间段即兴生成多样旁白，
 * 关闭或生成失败时回退固定模板。走主 LLM 配置（非流式、temperature 0.9、小调用）。
 */
async function topicNarration(settings: AppSettings): Promise<string> {
  const fallback = topicNarrationTemplate(settings.userName || '用户')
  if (!settings.proactiveLlmNarration) return fallback
  try {
    const apiKey = await readApiKey()
    if (!apiKey || !settings.baseURL.trim() || !settings.model.trim()) {
      console.log('[proactive] LLM 旁白生成跳过：主 API 配置不完整')
      return fallback
    }
    const system =
      '你是旁白撰稿助手。一位 AI 桌宠角色即将主动搭话，请为它写一句"舞台指示"旁白。要求：\n' +
      '- 一句话，20~40 字，用圆括号（）完整包裹\n' +
      '- 用"你"指代角色本人，用「对方」指代用户\n' +
      '- 结合当前时间段给角色一个自然的小动机（时间段的心绪、随手的小事、莫名的想念等）\n' +
      '- 禁止编造具体的共同回忆或事件，禁止出现系统/旁白等元字眼\n' +
      '- 只输出旁白本身，不要任何解释'
    const user = `当前时间段：${periodLabel()}。请写一句旁白：`
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.9,
        stream: false,
        maxTokensOverride: NARRATION_MAX_TOKENS,
      },
    )
    // 思考型模型（如 mimo）：剥离 <think> 推理块，仅保留正文
    const text = (raw ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[a-z]*\s*/gi, '')
      .replace(/```/g, '')
      .trim()
    if (!text) {
      // reasoning 吃掉全部预算等场景：content 为空，回退模板（打日志便于发现）
      console.warn('[proactive] LLM 旁白生成返回为空（思考型模型预算被 reasoning 占用？），回退模板')
      return fallback
    }
    if (text.length > 80) {
      console.warn('[proactive] LLM 旁白超长（%d 字），回退模板：%s', text.length, text.slice(0, 60))
      return fallback
    }
    console.log('[proactive] LLM 生成话题旁白：%s', text)
    return text
  } catch (err) {
    console.warn('[proactive] LLM 旁白生成失败（回退模板）：', err instanceof Error ? err.message : err)
    return fallback
  }
}

/** 固定模板旁白（LLM 关闭/失败时的兜底） */
function topicNarrationTemplate(userName: string): string {
  return `（你有点想${userName}了，想主动说点什么。）`
}

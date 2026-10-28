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
import { resolveProfile } from '../apiProfiles'
import { sendChatCompletion } from '../aiClient'
import { analyzeScreen, captureScreenImage } from './screenAnalyzer'
import { stripTrailingPunct } from '../../../src/lib/utils'

/** 意图类型：屏幕感知 / 普通话题 */
export type ProactiveIntentKind = 'screen' | 'topic'

/** 各意图的 pending 队列 TTL：屏幕转述很快过期，过时即弃 */
export function intentTtlMs(kind: ProactiveIntentKind): number {
  return kind === 'screen' ? 120_000 : 300_000
}

/** 屏幕搭话占比的兜底值（设置项异常/缺失时使用） */
const DEFAULT_SCREEN_WEIGHT = 70

/** 旁白生成 LLM 调用的输出 token 上限：mimo 等思考型模型的 reasoning 会占用预算，
 *  预算太小会导致 content 为空字符串（同 memoryExtraction 的踩坑），因此放大到与抽取一致 */
const NARRATION_MAX_TOKENS = 2048

/**
 * 轮盘决策（同步、零 I/O）：决定本轮意图类型，旁白推迟到投放时生成。
 *
 * 屏幕占比由设置项 `proactiveScreenWeight`（0–100）控制：只决定"开口时有多少概率
 * 是先看屏幕说的"，不控制频率（频率仍是兴趣值累积 + 每日上限）；
 * 用户点眼睛的主动识屏完全不走这里。
 */
export function selectIntentKind(settings: AppSettings): ProactiveIntentKind {
  if (!(settings.enableProactive && settings.enableScreenSense)) return 'topic'
  const raw = Number(settings.proactiveScreenWeight)
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : DEFAULT_SCREEN_WEIGHT
  return Math.random() * 100 < pct ? 'screen' : 'topic'
}

/** 一次投放的产物：旁白文本 + 可选的当轮临时图片 */
export interface ProactiveDelivery {
  narration: string
  /**
   * 「直读」模式专用：截图作为当轮临时图片直接带给主模型。
   * 不落盘、不写历史；旁白里也不含任何画面描述。
   */
  transientImage?: { base64: string; mime: string }
}

/**
 * 投放时生成旁白（闸门通过后才调用，避免无谓的 LLM 消耗）。
 * @param kind 意图类型；screen 感知失败时自动降级为 TOPIC 旁白
 * @param charName 目标会话的角色名（旁白以第三人称角色名作主语，消除"你=角色"的
 *        人称锚定——曾致模型回忆互动时把角色自己的动作错归属给用户）
 * @param opts.requested 用户主动要求看屏幕（点眼睛）：
 *        - 措辞改为"顺着你的示意看过去"，而不是"忍不住想聊两句"（动机从主动变被动）；
 *        - 感知跳过缓存，必须看到"现在"；
 *        - 按设置 vision.eyeReadMode 选择速览/详述/直读三种识图方式。
 *        主动搭话恒为速览（不读文字、成本最低），不看这个设置。
 * @returns 旁白 +（直读时）临时图片；永不 throw
 */
export async function buildNarration(
  kind: ProactiveIntentKind,
  settings: AppSettings,
  charName: string,
  opts: { requested?: boolean } = {},
): Promise<ProactiveDelivery> {
  const userName = settings.userName || '用户'
  const name = charName.trim() || '角色'
  if (kind === 'screen') {
    const mode = opts.requested ? settings.vision.eyeReadMode : 'ambient'

    // ── 直读：不转述，截图随本轮直接交给主模型 ──
    if (mode === 'native') {
      const shot = await captureScreenImage()
      if (!shot) {
        return { narration: `（${name}顺着${userName}的示意看过去，却什么也没看清。）` }
      }
      // 旁白刻意不含任何画面描述：描述会诱导模型在回复里复述，违背"旁白描述、回复反应"的分工
      return {
        narration: `（${name}顺着${userName}的示意看过去。）`,
        transientImage: { base64: shot.base64, mime: 'image/jpeg' },
      }
    }

    // ── 速览 / 详述：视觉模型转述成文字 ──
    const style = mode === 'detail' ? 'detail' : 'ambient'
    const analysis = await analyzeScreen({ force: !!opts.requested, style })
    if (analysis) {
      // 转述自带句号，模板后面还会补一个 → 先剥掉末尾标点，避免「。。」「。。，」
      const body = stripTrailingPunct(analysis)
      return {
        narration: opts.requested
          ? `（${name}顺着${userName}的示意看过去：${body}。）`
          : `（${name}瞥了一眼${userName}的电脑桌面：${body}，忍不住想聊两句。）`,
      }
    }
    if (opts.requested) {
      // 用户主动要求却看不到：如实说没看清（角色化，比静默无反应好）
      return { narration: `（${name}顺着${userName}的示意看过去，却什么也没看清。）` }
    }
    // 屏幕感知不可用 → 降级 TOPIC 旁白（保证"双开关 = 一定搭话"的体验）
    console.log('[proactive] 屏幕感知不可用，降级为 TOPIC 旁白')
  }
  return { narration: await topicNarration(settings, name) }
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
 * 旁白一律以第三人称角色名作主语（与消费侧【系统旁白】前缀、动作归属规则配套）。
 */
async function topicNarration(settings: AppSettings, charName: string): Promise<string> {
  const fallback = topicNarrationTemplate(charName, settings.userName || '用户')
  if (!settings.proactiveLlmNarration) return fallback
  try {
    // 主模型三元组走档案解析（档案制）：未激活档案时回退固定模板
    const mainCfg = await resolveProfile('main')
    if (!mainCfg) {
      console.log('[proactive] LLM 旁白生成跳过：主模型档案未配置')
      return fallback
    }
    const system =
      '你是旁白撰稿助手。一位 AI 桌宠角色即将主动搭话，请为它写一句"舞台指示"旁白。要求：\n' +
      '- 一句话，20~40 字，用圆括号（）完整包裹\n' +
      `- 以角色名「${charName}」作主语指代角色本人（不要用"你"指代角色），用「对方」指代用户\n` +
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
        model: mainCfg.model,
        baseURL: mainCfg.baseURL,
        apiKey: mainCfg.apiKey,
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

/** 固定模板旁白（LLM 关闭/失败时的兜底）：第三人称角色名作主语，与 LLM 生成口径一致 */
function topicNarrationTemplate(charName: string, userName: string): string {
  return `（${charName}有点想${userName}了，想主动说点什么。）`
}

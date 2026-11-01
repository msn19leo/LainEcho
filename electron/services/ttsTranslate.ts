/**
 * 中日文本互译（TTS 前置步骤）。
 *
 * 2026-10-27 从 genieTts.ts 抽出：本地 Genie-TTS 与本地 SBV2 共用同一条翻译链路，
 * 避免 sbv2Tts 反向依赖 genieTts —— 否则 Genie 调整翻译策略会连带影响 SBV2。
 */
import { sendChatCompletion } from './aiClient'
import { llmRequest, resolveProfile } from './apiProfiles'
import { resolveAuxLlmConfig } from './auxModel'

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF]/
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g

/**
 * “纯中文残句”判定前剔除的字符：数字、空白与常见中英日标点/符号。
 * 目的：17対15、2026年10月31日、第3位 这类“数字 + 汉字”表达不参与纯中文判定。
 */
const RESIDUAL_STRIP_RE =
  /[0-9０-９\s、，,。！？!?…:：；;·・\-—~～%％"'“”‘’「」『』（）()【】\[\]{}]/g

/**
 * 中文专用字符/中文虚词（非穷举，宁可漏判也不误杀合法日语）。
 * 只列中文简体专用字与高频虚词；日语汉字词（以上/最新情報/完了/17対15）不在其中。
 * 维护时务必用 analyzeJaTranslation 的日语汉字词用例回归，避免把正常译文判成中文。
 */
const CHINESE_ONLY_RE =
  /[这你她它哪谁们么吗呢吧啊呀哦啦嘛嘿嗯呗儿很说时过还让给对爱见气开关听语话电头发车东马龙鸟鱼风飞书长门问间闻买卖认识记讲谢请欢边变应该为从个两几实际处带张团园围层岁历亿员单卫厂专业热选远进运达适错铁银钱钟网罗罚胜负责场现环产决态标样确图课题视觉]/

/**
 * 滑窗 n-gram 重复率：模型复读时该值会飙到 1 以上，正常文本接近 0。
 * 2026-10-28 实例：一条 226 字译文把中间整段说了两遍，其它判据全过，产出 38.8 秒音频。
 */
function repeatRatio(body: string, n = 12): number {
  if (body.length < n * 2) return 0
  const seen = new Map<string, number>()
  for (let i = 0; i + n <= body.length; i++) {
    const gram = body.slice(i, i + n)
    seen.set(gram, (seen.get(gram) ?? 0) + 1)
  }
  let dup = 0
  for (const c of seen.values()) if (c > 1) dup += c - 1
  return (dup * n) / body.length
}

export interface JaCheckResult {
  ok: boolean
  reason: string
  /** 便于排障的一行指标，直接进日志 */
  metrics: string
  /** 触发失败的片段（句子级；仅失败时提供，便于日志直接定位） */
  offending?: string
}

/**
 * 判定日语译文是否可用。
 *
 * 2026-10-28 事故：模型把思考过程当译文吐出（"Wait no extra. Need exact." + 大段原文 + 重复开头），
 * 旧规则只逐句查「有汉字但整句无假名」，而垃圾句里混着假名（「この回，原来竟然…」），
 * 于是全部放行 → 264 字送进声库 → jtalk 念英文 → 46 秒噪音。
 *
 * 改为多判据，任一命中即判失败：语言混杂看的是「量」而不是「有没有」。
 * 注 1：旧版「全量简体字黑名单」因误杀合法引用（『让子弹飞』）与真实日语词（把手）被移除。
 *      2026-10-31 改为保守的「数字/标点剔除 + 中文专用字符/虚词」：只认中文专用字，
 *      共享汉字（以上/最新情報/完了）与数字表达（17対15）不拦；独立成句的中文标题仍可能被拦。
 * 注 2：英文判据曾用「白名单外的英文总量」，但模型名层出不穷（Anthropic/DeepSeek/GLM…），
 * 白名单永远补不完，改成只数「小写英文词」——专有名词放行，句子式泄漏才拦。
 */
export function analyzeJaTranslation(out: string, srcText: string): JaCheckResult {
  const body = out.replace(/\s/g, '')
  const total = body.length || 1
  const kana = (out.match(/[\u3040-\u309F\u30A0-\u30FF]/g) ?? []).length
  const kanaRatio = kana / total
  const srcLen = srcText.replace(/\s/g, '').length || 1
  const lengthRatio = total / srcLen

  // 只统计「小写开头、长度 ≥3」的英文词：
  // 专有名词与缩写（OpenAI / Anthropic / GLM / DeepSeek）天然大写开头，属于正常日语外来词；
  // 模型泄漏出来的句子（Wait no extra / industry's ascii）才会带小写词。
  // 这样不依赖白名单，也不用跟着新模型名一直补表。
  const lowerWords = (out.match(LATIN_WORD_RE) ?? []).filter(
    (w) => /^[a-z]/.test(w) && w.length >= 3,
  )
  const dupRatio = repeatRatio(body)

  const metrics =
    `字数=${total} 假名=${(kanaRatio * 100).toFixed(0)}% ` +
    `小写英文=${lowerWords.length}词 长度比=${lengthRatio.toFixed(1)} 重复率=${dupRatio.toFixed(2)}`

  if (HANGUL_RE.test(out)) return { ok: false, reason: '混入韩文', metrics }
  if (lengthRatio > 2.5) {
    return { ok: false, reason: `译文异常冗长（${lengthRatio.toFixed(1)} 倍）`, metrics }
  }
  if (lowerWords.length >= 2) {
    return { ok: false, reason: `混入未翻译英文（${lowerWords.join('/')}）`, metrics }
  }
  if (dupRatio > 0.3) {
    return { ok: false, reason: `译文出现整段重复（${(dupRatio * 100).toFixed(0)}%）`, metrics }
  }
  // 逐句：剔除数字/标点后仍含中文专用字符、且整句无假名 = 未翻译的中文残句。
  // 2026-10-31 修正：不再把“有汉字”等同于中文——17対15、以上、最新情報 等
  // 合法日语汉字/数字表达不再误判；中文专用字符集见 CHINESE_ONLY_RE。
  for (const sentence of out.split(/[。！？!?\n…]+/)) {
    const s = sentence.trim()
    const core = s.replace(RESIDUAL_STRIP_RE, '')
    if (!KANA_RE.test(core) && CHINESE_ONLY_RE.test(core)) {
      return { ok: false, reason: '存在纯中文残句', metrics, offending: s }
    }
  }
  return { ok: true, reason: '', metrics }
}

/**
 * 使用 LLM API 将文本翻译为目标语言。
 * 用于日语 TTS 模型：AI 生成中文文本，翻译为日语后交给 GenieTTS 合成。
 *
 * 校验防线（2026-10-05，"最后一段语音没输出完就结束/语音异常"根因修复）：
 *  - 目标 ja 但结果不含日文假名（思考型模型的 reasoning 会计入 max_tokens 预算，预算过小 →
 *    content 为空；或模型偷懒回显中文原文）→ 强化提示词重试一次；
 *  - 仍失败则抛错（不再静默回退原文合成）——宁可跳过该块语音（文本照常上屏跟读），
 *    也不能让日文声库读中文出怪音；上层 PetApp catch 后按既有静默降级处理。
 * 纯度防线（2026-10-14，"翻译夹杂中文残留/韩文"实锤后补；2026-10-31 修正误判）：
 *  - 含韩文（Hangul 区，实测 "먼저"）→ 判不纯；
 *  - 逐句检查：先剔除数字/标点，剩余仍含**中文专用字符/虚词**且整句无假名 → 未翻译的
 *    中文残句（实测 "那、那算什么呀"）→ 判不纯；不再用"含汉字且无假名"作为判据，
 *    避免把 "17対15"、"以上"、"最新情報" 这类合法日语汉字/数字表达误判为中文；
 *  - 不纯 → 强化提示词重试一次；重试后仍不纯 → 抛错跳过该段语音（文本照常上屏）。
 */
export async function translateText(text: string, targetLang: 'ja' | 'zh'): Promise<string> {
  // P0-2B：翻译走辅助模型（机械任务，主对话模型可能是思考型，延迟 1.3~28.8s 波动）；
  // 未激活辅助档案时回落主模型激活档案的三元组（档案制）
  const cfg = (await resolveAuxLlmConfig()) ?? (await resolveProfile('main'))
  if (!cfg || !cfg.apiKey || !cfg.baseURL.trim() || !cfg.model.trim()) {
    console.warn('[genie] 翻译跳过：未配置 LLM API（主或翻译辅助模型档案）')
    return text
  }
  const langName = targetLang === 'ja' ? '日语' : '中文'
  // 结果校验：ja 至少要含日文假名（平/片假名），zh 至少要含汉字——否则视为翻译失败
  const looksValid = (out: string) =>
    targetLang === 'ja' ? /[\u3040-\u309F\u30A0-\u30FF]/.test(out) : /[\u4e00-\u9fff]/.test(out)
  // 思考型模型的 reasoning 计入 max_tokens 预算：1024 被思考耗尽 → content 为空 →
  // 此前静默回退原文（中文喂日文声库 = "语音异常"根因），抬到 2048 与主对话链路对齐
  const systemPrompt = (strong: boolean) =>
    `你是一个翻译助手。将用户输入的文本翻译为${langName}，只输出翻译结果，不要任何解释、注释或额外内容。保持原文的情感和语气。` +
    (strong
      ? `\n【强制】结果必须是${langName}文本：禁止输出原文语言、禁止夹杂中文/韩文等其他语言的字词、禁止输出空内容、禁止输出任何思考过程。`
      : '')

  let lastOutput = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      lastOutput = await sendChatCompletion(
        [
          { role: 'system', content: systemPrompt(attempt > 1) },
          { role: 'user', content: text },
        ],
        // 档案上的思考开关同样生效；预算不足被截断时 aiClient 会自动翻倍重试一次
        llmRequest(cfg, { temperature: 0.3, stream: false, maxTokensOverride: 2048 }, { aux: true }),
      )
    } catch (err) {
      console.error('[genie] 翻译请求异常（第 %d 次）', attempt, err)
      continue // 请求异常 → 直接重试一次
    }
    const result = lastOutput.trim()
    if (!result || !looksValid(result)) {
      console.warn(
        '[genie] 翻译结果校验失败（第 %d 次）：输出字数=%d 含假名=%s 输出=%j',
        attempt,
        result.length,
        looksValid(result),
        result.slice(0, 60) || '(空)',
      )
      continue
    }
    // 质量校验（仅 ja）：不通过 → 强化提示词重试一次；仍不通过则抛错，
    // 由调用方跳过该段语音（文本照常上屏）。绝不把垃圾文本送进声库——
    // 那会产出一段几十分钟的噪音，比"少一句语音"糟得多。
    if (targetLang === 'ja') {
      const check = analyzeJaTranslation(result, text)
      if (!check.ok) {
        // 两次失败都落日志：第 2 次以前是直接 throw，线上只能看到第 1 次，无法定位
        console.warn(
          '[tts] 译文校验未通过（第 %d 次，%s）→ %s｜%s｜片段=%j｜输出=%j',
          attempt,
          check.reason,
          attempt < 2 ? '强化提示词重试' : '跳过该段语音',
          check.metrics,
          check.offending ?? '',
          result.slice(0, 80),
        )
        if (attempt < 2) continue
        throw new Error(
          `日语翻译校验失败（${check.reason}${check.offending ? `：${check.offending}` : ''}）——跳过该段语音，文本照常上屏`,
        )
      }
      console.log(
        '[tts] 翻译结果：目标=%s 第%d次尝试 判定=ok｜%s｜→ %j',
        targetLang,
        attempt,
        check.metrics,
        result.slice(0, 200),
      )
      return result
    }

    console.log(
      '[tts] 翻译结果：目标=%s 第%d次尝试 字数=%d → %j',
      targetLang,
      attempt,
      result.length,
      result.slice(0, 200),
    )
    return result
  }
  throw new Error('日语翻译校验失败（两次尝试均未得到有效日文）——跳过该块语音，文本照常上屏')
}

// ===== ①翻译/合成并行化（2026-10-22 日志实锤：翻译串行在上一段合成之后，每段白等 2~4s）=====
// speak 事件时刻（windowManager.speak）预发射翻译：翻译走辅助模型（网络 LLM），与本地 GPU 合成
// 无资源竞争——上一段合成期间本段翻译已并行完成，tts:synthesize 到达时直接取结果。
// LRU 32 条；同文本 in-flight 去重（同一 Promise）；失败即弃（合成路径现场直译兜底）。
const translationCache = new Map<string, Promise<string>>()

/** 预发射一段翻译（speak 事件时刻调用；重复调用同文本幂等） */
export function prefetchTranslation(text: string, lang: 'ja' | 'zh'): void {
  const key = `${lang}|${text}`
  if (translationCache.has(key)) return
  const p = translateText(text, lang)
  translationCache.set(key, p)
  if (translationCache.size > 32) {
    const oldest = translationCache.keys().next().value
    if (oldest !== undefined) translationCache.delete(oldest)
  }
  // 预发射期间无人 await：先挂空 catch 防 unhandledRejection（await 原 promise 仍可正常抛出）
  void p.catch(() => {})
  // 失败即弃缓存：后续合成路径取不到会现场直译（与旧行为等价）
  void p.catch(() => {
    translationCache.delete(key)
  })
}

/** 合成路径取译文：预取命中（含 in-flight）直接等它，未命中现场翻译 */
export async function translateWithCache(text: string, lang: 'ja' | 'zh'): Promise<string> {
  const cached = translationCache.get(`${lang}|${text}`)
  if (cached) return cached
  return translateText(text, lang)
}

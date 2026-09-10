/**
 * PromptComposer：提示词段落组装器。
 *
 * 职责：
 *  1. 按 order 升序拼接 PromptSection，跳过空文本段（"只注入非空字段"约束）；
 *  2. 估算各段 token 并生成组装报表（供 prompt:preview 调试预览）；
 *  3. 可选 token 预算裁剪：超预算时按序丢弃 truncatable 段落（关键段落永不裁剪）。
 *
 * 默认不裁剪（budget 缺省），保证与旧版 buildSystemPrompt 输出逐字节一致。
 */
import type { PromptSection } from './sections'

/** 组装报表的单段条目 */
export interface SectionReport {
  id: string
  tokens: number
  included: boolean
}

/** 组装结果：最终文本 + 各段报表 */
export interface ComposedPrompt {
  text: string
  sections: SectionReport[]
}

/**
 * 估算文本 token 数（轻量口径：中文约 1.6 字符/token，英文按 4 字符/token 折算）。
 * 组装器只用于段落级预算取舍与调试展示，不需要精确分词；
 * 精确估算（gpt-tokenizer）在消息层由 token.ts 负责。
 */
export function estimateSectionTokens(text: string): number {
  if (!text) return 0
  // 粗略区分中英文字符比例，逐字符累计
  let cjk = 0
  let other = 0
  for (const ch of text) (ch.codePointAt(0) ?? 0) > 0x2e7f ? cjk++ : other++
  return Math.max(1, Math.ceil(cjk / 1.6 + other / 4))
}

/**
 * 组装提示词：
 * @param sections 段落列表（内部按 order 升序排序，跳过空文本）
 * @param opts.budget 总 token 预算；<=0 或缺省 = 不限制（旧行为）。
 *   预算不足时按组装顺序依次丢弃 truncatable 段（关键段落 emotion/persona/format 永不裁剪）。
 * @param opts.userName %player% 占位符替换值（空串不替换，保持占位符原文）
 */
export function composeSystemPrompt(sections: PromptSection[], opts?: { budget?: number; userName?: string }): ComposedPrompt {
  const ordered = [...sections].sort((a, b) => a.order - b.order)
  const report: SectionReport[] = []
  const kept: string[] = []
  let used = 0
  const budget = opts?.budget && opts.budget > 0 ? opts.budget : 0

  for (const section of ordered) {
    if (!section.text.trim()) continue
    const tokens = estimateSectionTokens(section.text)
    // 预算装填：不可裁剪段落始终保留；可裁剪段落超预算即丢弃（后续段落继续尝试，允许小段插队保留）
    if (budget > 0 && section.truncatable && used + tokens > budget) {
      report.push({ id: section.id, tokens, included: false })
      continue
    }
    used += tokens
    report.push({ id: section.id, tokens, included: true })
    kept.push(section.text)
  }

  const joined = kept.join('\n\n')
  const userName = opts?.userName
  const text = userName ? joined.split('%player%').join(userName) : joined
  return { text, sections: report }
}

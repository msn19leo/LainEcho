/**
 * 触摸演出的「占用窗口」。
 *
 * 触摸反应（Live2D 动作 / 立绘序列切换）期间不应该让主动搭话插进来：
 * 两段演出叠在一起，用户看到的是「动作被打断 + 立绘乱切」。
 *
 * 用「截止时间戳」而不是布尔锁：渲染进程崩溃、被强杀、或某帧抛错没走到收尾时，
 * 布尔锁会永久卡死（主动搭话从此再也不触发），时间窗最坏只是多静默两分钟。
 */

/** 单次上报的最大窗口：防止调用方传错值（如秒当毫秒）导致长时间静默 */
const MAX_WINDOW_MS = 120_000

let until = 0

/** 标记「从现在起 durationMs 内正在演出」；多次调用取较晚的截止时间 */
export function markTouchPerforming(durationMs: number): void {
  const ms = Math.min(MAX_WINDOW_MS, Math.max(0, Math.round(durationMs || 0)))
  if (ms <= 0) return
  until = Math.max(until, Date.now() + ms)
}

/** 当前是否处于触摸演出中（主动搭话的闸门之一） */
export function isTouchPerforming(): boolean {
  return Date.now() < until
}

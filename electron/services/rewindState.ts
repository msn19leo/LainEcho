/**
 * 重答占位状态（独立模块，零依赖）：
 * 截断 → 情景摘要重建 → 重跑启动之间，同会话的发送/二次重答/主动搭话都必须被挡住。
 * 放在独立文件是为了让 chatTurn / proactive scheduler 能查询它而不产生循环依赖。
 */
const active = new Set<string>()

export function addRewindBusy(sessionId: string): void {
  active.add(sessionId)
}

export function removeRewindBusy(sessionId: string): void {
  active.delete(sessionId)
}

export function isRewindBusy(sessionId?: string): boolean {
  return sessionId ? active.has(sessionId) : active.size > 0
}

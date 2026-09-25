/**
 * 主动搭话调度器。
 *
 * - 调度循环：间隔用户可设（settings.proactiveInterestIntervalSec，默认 30s，夹取 10~600s），
 *   setTimeout 链实现——每轮结束后按最新设置排下一轮，改设置无需重启即生效；
 *   兴趣值每轮 +5~10（上限 100），>50 后按 p=(interest-50)/50 掷骰触发；
 * - 防打扰：AI 正在流式回复（isChatBusy）→ 拦截；用户最近 2 分钟内发过消息 → 拦截；
 *   免打扰时段 → 静默跳过；被拦截的意图进入 pending 队列按 TTL 重试（SCREEN 120s / TOPIC 300s）；
 * - 频率限制：每日 maxProactivePerDay 次（用户回复后当日计数重置、兴趣清零）；
 * - 投放：向「最近活跃会话」注入旁白 user 消息（meta.proactive=true），走 runChatTurn 完整管线；
 * - 状态持久化：data/proactive-state.json（重启不丢当日计数与兴趣值）。
 */
import type { AppSettings, ProactiveState } from '../../../src/types'
import { getSettings, listSessions } from '../repository'
import { paths, readJson, writeJson } from '../storage'
import { isChatBusy, runChatTurn } from '../chatTurn'
import { isStoryActive } from '../storyEngine/engine'
import { buildNarration, intentTtlMs, selectIntentKind, type ProactiveIntentKind } from './strategyDispatcher'
import { windowManager } from '../../windows/windowManager'

/** 默认调度间隔（秒）：settings.proactiveInterestIntervalSec 缺失时的兜底 */
const DEFAULT_TICK_SEC = 30
/** 调度间隔夹取范围（秒）：下限防定时器疯转，上限兜底极端输入 */
const MIN_TICK_SEC = 10
const MAX_TICK_SEC = 600
/** 每轮兴趣值增量范围 */
const INTEREST_MIN = 5
const INTEREST_MAX = 10
/** 兴趣值上限 */
const INTEREST_CAP = 100
/** 触发阈值：interest > 50 后才进入概率判定 */
const INTEREST_THRESHOLD = 50
/** 用户最近发消息的冷却时间：冷却期内不投放（兴趣值也已被重置，双保险） */
const USER_RECENT_COOLDOWN_MS = 2 * 60 * 1000

/** 持久化状态（proactive-state.json） */
interface PersistState {
  interest: number
  /** 本地日期 'YYYY-MM-DD'，跨天时 timesToday 归零 */
  dayKey: string
  timesToday: number
  lastSpokeAt: number | null
  lastUserMessageAt: number | null
}

const DEFAULT_STATE: PersistState = {
  interest: 0,
  dayKey: '',
  timesToday: 0,
  lastSpokeAt: null,
  lastUserMessageAt: null,
}

/** 内存缓存（懒加载，落盘与内存同步写） */
let state: PersistState | null = null
let timer: NodeJS.Timeout | null = null
/** 被闸门拦截的待投放意图（只存类型，旁白投放时重新生成；按 TTL 重试，超时作废；内存态即可） */
let pendingIntent: { kind: ProactiveIntentKind; expireAt: number } | null = null
/** 投放互斥：一轮 runChatTurn 未完成前不再投放 */
let delivering = false

/** 本地日期键 'YYYY-MM-DD'（当日计数的归属判定） */
function todayKey(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** [min, max] 闭区间随机整数 */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 懒加载状态：缺失字段用默认值补全；跨天时当日计数归零 */
async function loadState(): Promise<PersistState> {
  if (!state) {
    const saved = await readJson<Partial<PersistState>>(paths.proactiveStateFile, {})
    state = { ...DEFAULT_STATE, ...saved }
  }
  const today = todayKey()
  if (state.dayKey !== today) {
    state.dayKey = today
    state.timesToday = 0
  }
  return state
}

/** 状态落盘（原子写） */
async function persistState(): Promise<void> {
  if (!state) return
  await writeJson(paths.proactiveStateFile, state).catch((err) =>
    console.warn('[proactive] 状态持久化失败：', err),
  )
}

/** 判断当前是否处于免打扰时段（start/end 任一为空 = 不启用；支持跨零点区间） */
function isInQuietHours(qh: AppSettings['quietHours']): boolean {
  if (!qh?.start || !qh?.end) return false
  const toMinutes = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  const start = toMinutes(qh.start)
  const end = toMinutes(qh.end)
  if (start === null || end === null || start === end) return false
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  if (start < end) return nowMin >= start && nowMin < end
  return nowMin >= start || nowMin < end // 跨零点（如 23:00-08:00）
}

/** 组装对外状态负载（含每日上限快照） */
async function statePayload(): Promise<ProactiveState> {
  const st = await loadState()
  let maxPerDay = 3
  try {
    maxPerDay = (await getSettings()).maxProactivePerDay
  } catch {
    // 设置读取失败用默认值
  }
  return {
    interest: st.interest,
    timesToday: st.timesToday,
    maxPerDay,
    lastSpokeAt: st.lastSpokeAt,
    lastUserMessageAt: st.lastUserMessageAt,
  }
}

/** 读取并夹取兴趣值增长间隔（秒）：无效/缺失值回退默认 */
function clampTickSec(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_TICK_SEC
  return Math.min(MAX_TICK_SEC, Math.max(MIN_TICK_SEC, n))
}

/**
 * 广播调度状态给所有窗口（设置面板实时刷新）。
 * 内部按 enableProactive 门控：功能关闭时不推送（避免每 30s 空发 IPC）。
 */
async function broadcastState(): Promise<void> {
  try {
    if (!(await getSettings()).enableProactive) return
  } catch {
    return
  }
  windowManager.broadcast('proactive:state', await statePayload())
}

/**
 * 胶包一层：无论本轮走到哪个分支，结束后都广播一次状态。
 * 兴趣值每轮都在累积，只有每轮广播才能让设置面板的兴趣值实时刷新
 * （否则面板只在成功搭话/用户发消息后才更新）。
 */
async function runCycle(): Promise<void> {
  if (delivering) return
  try {
    await runCycleInner()
  } finally {
    await broadcastState()
  }
}

/** 调度循环单轮（实际逻辑） */
async function runCycleInner(): Promise<void> {
  let settings: AppSettings
  try {
    settings = await getSettings()
  } catch {
    return
  }
  if (!settings.enableProactive) return
  // 免打扰时段：静默跳过（不累积兴趣、不保留 pending）
  if (isInQuietHours(settings.quietHours)) return

  const st = await loadState()

  // 1. 重试被拦截的意图（超 TTL 作废；重试时旁白在 tryDeliver 内重新生成，不会复用旧文本）
  if (pendingIntent) {
    if (Date.now() > pendingIntent.expireAt) {
      console.log('[proactive] pending 意图过期作废')
      pendingIntent = null
    } else if (await tryDeliver(pendingIntent.kind, settings, st)) {
      pendingIntent = null
      await persistState()
      return
    }
  }

  // 2. 兴趣值累积
  st.interest = Math.min(INTEREST_CAP, st.interest + randInt(INTEREST_MIN, INTEREST_MAX))

  // 3. 每日限额
  if (st.timesToday >= settings.maxProactivePerDay) {
    await persistState()
    return
  }
  // 4. 触发阈值 + 概率掷骰：p = (interest - 50) / 50
  if (st.interest <= INTEREST_THRESHOLD) {
    await persistState()
    return
  }
  if (Math.random() >= (st.interest - INTEREST_THRESHOLD) / INTEREST_THRESHOLD) {
    await persistState()
    return
  }

  // 5. 轮盘决策（仅定类型；旁白推迟到投放时生成，被闸门拦截时不白白调用 LLM）
  const kind = selectIntentKind(settings)

  // 6. 投放；被闸门拦截（非免打扰原因）→ 入 pending 队列下轮重试
  if (await tryDeliver(kind, settings, st)) {
    pendingIntent = null
    await persistState()
    return
  }
  const ttl = intentTtlMs(kind)
  pendingIntent = { kind, expireAt: Date.now() + ttl }
  console.log('[proactive] 意图进入 pending 队列（kind=%s ttl=%ds）', kind, Math.round(ttl / 1000))
  await persistState()
}

/**
 * 尝试投放一轮搭话：闸门校验 → 投放时才生成旁白（重试即重新生成）→
 * 向最近活跃会话注入旁白 → runChatTurn 完整管线。
 * @returns true = 已成功投放（消耗当日次数）
 */
async function tryDeliver(kind: ProactiveIntentKind, settings: AppSettings, st: PersistState): Promise<boolean> {
  if (delivering) return false
  // 闸门 1：AI 正在流式回复（打断体验差）
  if (isChatBusy()) return false
  // 闸门 1.5：剧情演出进行中（剧情期间旁白会打断演出节奏）
  if (isStoryActive()) return false
  // 闸门 2：用户最近 2 分钟内发过消息（兴趣值也已被重置，双保险）
  if (st.lastUserMessageAt && Date.now() - st.lastUserMessageAt < USER_RECENT_COOLDOWN_MS) return false
  // 闸门 3：免打扰时段（调度层已拦截，此处兜底）
  if (isInQuietHours(settings.quietHours)) return false

  // 目标会话：最近活跃会话（无任何会话时静默跳过）
  let target
  try {
    const sessions = await listSessions()
    target = sessions[0]
  } catch {
    return false
  }
  if (!target) return false

  // 闸门全过后才生成旁白：LLM 生成 / 屏幕感知转述（screen 失败内部降级 TOPIC 旁白）。
  // 旁白以目标会话的角色名作第三人称主语（消除"你=角色"的人称锚定，见 strategyDispatcher）
  const narration = await buildNarration(kind, settings, target.characterCardName ?? '')

  delivering = true
  try {
    await runChatTurn({ sessionId: target.id, content: narration, meta: { proactive: true } })
    st.timesToday += 1
    st.interest = 0
    st.lastSpokeAt = Date.now()
    console.log('[proactive] 搭话完成 → 会话 %s（今日第 %d 次）', target.id, st.timesToday)
    void broadcastState()
    return true
  } catch (err) {
    // 生成失败不入 pending（重试同样会失败；兴趣值保留，下轮掷骰再试）
    console.warn('[proactive] 搭话生成失败：', err instanceof Error ? err.message : err)
    return false
  } finally {
    delivering = false
  }
}

/**
 * 启动调度循环（app ready 后调用一次；重复调用幂等）。
 *
 * setTimeout 链而非 setInterval：每轮 runCycle 结束后读取最新设置计算下一轮间隔，
 * 用户在设置里改"兴趣值增长间隔"后下一轮自然生效，无需重启调度器。
 */
export function startProactiveScheduler(): void {
  if (timer) return
  const loop = async (): Promise<void> => {
    try {
      await runCycle()
    } finally {
      let sec = DEFAULT_TICK_SEC
      try {
        sec = clampTickSec((await getSettings()).proactiveInterestIntervalSec)
      } catch {
        // 设置读取失败用默认间隔
      }
      timer = setTimeout(() => void loop(), sec * 1000)
    }
  }
  void loop()
  console.log('[proactive] 调度器已启动（间隔=用户可设，默认 %ds）', DEFAULT_TICK_SEC)
}

/**
 * 用户主动发消息的通知（ai:send-message 时调用）：
 * 兴趣值清零、当日搭话计数重置、更新冷却时间戳。
 */
export async function noteUserMessage(_sessionId: string): Promise<void> {
  try {
    const st = await loadState()
    st.interest = 0
    st.timesToday = 0
    st.lastUserMessageAt = Date.now()
    pendingIntent = null
    await persistState()
    void broadcastState()
  } catch (err) {
    console.warn('[proactive] noteUserMessage 失败：', err)
  }
}

/** 读取调度状态（proactive:get-state） */
export async function getProactiveState(): Promise<ProactiveState> {
  return statePayload()
}

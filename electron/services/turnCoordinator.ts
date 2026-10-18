/**
 * TurnCoordinator —— 方案A主进程回合文档状态机（docs/方案A-主进程回合文档与幂等快照协议.md）。
 *
 * 职责：维护每轮普通聊天回答的唯一状态文档（TurnDocument）：
 *  - 文档生命周期：begin（流式开始）/ renew（重试轮换代）/ finish（落盘）/ discard（错误清理）
 *  - segments 填充：syncFromPartial 以全量 partial 驱动 → 对象闭合切片 → 只增不减地追加底稿分段
 *  - 语音进度记账（字符口径）：markProgress 单调取 max——语音播到哪、两窗文本就放行到哪
 *  - 快照分发：脏标记 + 30ms 节流，广播 ai:turn-state 全量快照
 *  - 看门狗：reading 阶段超时无进度强制落定（兜底语音链全灭/上报丢失的永久 reading）
 *
 * 边界（硬约束，见设计文档 §9）：
 *  - 仅服务普通聊天轮次（store 覆盖的剧情轮次不创建文档，剧情系统零接触）；
 *  - 不落盘、不做 TTS 组装决策（chatTurn 保留编排权，文档只做状态承载）。
 */
import type { TurnDocument, TurnPhase, TurnSegment } from '../../src/types'
import { extractDialogueObjects, extractStreamingJsonText, extractScriptChunkDelta } from './emotion'
import { windowManager } from '../windows/windowManager'

/** 快照广播节流间隔（毫秒）：流式 delta 高频到达，合并为最多 30ms 一次全量广播 */
const BROADCAST_THROTTLE_MS = 30

/**
 * reading 看门狗（毫秒，进度/心跳重置式）：每次收到语音进度变化**或宠物窗工作心跳**都重新计时；
 * 连续该时长既无进度也无心跳且未收尾 → 强制落定。兜底"宠物窗未运行/语音链全灭/上报丢失"的永久 reading。
 * 注意：①不可从 markReading 起一次性计时——慢速 TTS（翻译+合成每段 10-25s）全程可超一分钟，
 * 一次性计时会在语音正常播放中被误杀（2026-10-14 15:55 轮实锤）；②阈值须大于"单段最坏合成
 * 时长"——最后一段合成 48s 实测（15:55:15 发起→15:56:04 完成），45s 会在 speaking→spoken
 * 间隙误杀，故取 90s；③宠物窗在合成/播放进行中每 15s 上行工作心跳（markReadingPing）——
 * Genie 翻译偶发耗时数分钟（20:29 轮 3 分钟实测），无心跳保护会被"进度停滞"误判强制落定，
 * 两窗文本提前放行、语音迟到才播（2026-10-14 20:30 轮实锤）。
 */
const READING_WATCHDOG_MS = 90_000

/** 当前文档（普通聊天轮次进行中/刚结束时非 null；剧情轮次恒 null） */
let doc: TurnDocument | null = null

/**
 * ② 纯文本直通模式（2026-10-15 漂移轮去静默）：模型放弃 JSON 契约输出剧本/纯文本时，
 * extractDialogueObjects 恒零产出（JSON 闭合切片器认不出），prose 兜底段又被语音门控
 * 卡死（speakingChars=0）→ 全程零投递。直通模式改由 syncFromPartialScript 以括号/标点
 * 规则增量入稿，segments 与语音链直通产出同构（文本/顺序一致），揭示门控照常工作。
 */
let scriptMode = false
/** 直通切片游标（与 chatTurn 语音链 speechCursor 相互独立、对同一整形源同构递增） */
let scriptCursor = 0

/** 重置直通模式状态（beginTurn/renewTurn 换代时） */
function resetScriptMode(): void {
  scriptMode = false
  scriptCursor = 0
}

/** 脏标记 + 节流定时器 */
let dirty = false
let throttleTimer: NodeJS.Timeout | null = null

/** reading 看门狗定时器 */
let watchdogTimer: NodeJS.Timeout | null = null

/** 生成 turnId：时间戳 + 随机后缀（同毫秒多轮也唯一） */
function newTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 标脏并安排节流广播（文档存在时才广播） */
function markDirty(): void {
  if (!doc) return
  dirty = true
  if (throttleTimer) return
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    if (!dirty || !doc) return
    dirty = false
    // 全量快照广播（幂等：渲染端整体替换）
    windowManager.broadcastAI('ai:turn-state', { doc: { ...doc, segments: doc.segments.map((s) => ({ ...s })) } })
  }, BROADCAST_THROTTLE_MS)
}

/** 取消 reading 看门狗 */
function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

/**
 * 开启新回合文档（普通聊天轮流式开始时调用；剧情轮次 store 覆盖时不调用）。
 * 若上一轮文档尚在（异常残留），直接覆盖——文档以最新轮次为准。
 * @param voice 本轮是否启用语音跟读（渲染端据此门控文本揭示：有语音 → 段随语音进度显示）
 */
export function beginTurn(sessionId: string, user: { content: string; timestamp: number; meta: import('../../src/types').ChatMessageMeta | null }, voice: boolean): string {
  clearWatchdog()
  resetScriptMode()
  doc = {
    turnId: newTurnId(),
    sessionId,
    phase: 'generating',
    user,
    segments: [],
    trailing: '',
    voice,
    spokenChars: 0,
    speakingChars: 0,
  }
  markDirty()
  return doc.turnId
}

/**
 * 重试轮换代：segments 整体重建、trailing/进度清零、turnId 更新（旧快照凭 turnId 失效，
 * 渲染端见新 turnId 整体重置 → 天然清屏，消灭"残片+新文"拼接）。
 * @returns 新 turnId；无文档（剧情轮）返回 null
 */
export function renewTurn(): string | null {
  if (!doc) return null
  doc.turnId = newTurnId()
  doc.segments = []
  doc.trailing = ''
  doc.spokenChars = 0
  doc.speakingChars = 0
  resetScriptMode()
  markDirty()
  return doc.turnId
}

/**
 * 进入直通模式（chatTurn 漂移判定命中时调用）：清掉既有 segments（含 prose 兜底段——
 * 直通后由分段粒度的脚本项接管，单一兜底 speak 段会让全部内容旁白化/台词化错位）。
 */
export function beginScriptMode(): void {
  if (!doc) return
  scriptMode = true
  scriptCursor = 0
  doc.segments = []
  doc.trailing = ''
  markDirty()
}

/**
 * 直通切片入稿：以括号/标点规则从整形后的纯文本增量提取 speak/narr 项并追加进 segments。
 * 游标为模块态（与语音链互不影响）；幂等性由游标单调保证（同一文本重复调用零新增）。
 * @param force 结束冲刷（流结束时 true，把未达封段条件的尾巴也入稿）
 */
export function syncFromPartialScript(
  partial: string,
  palette?: import('../../src/types').EmotionPaletteRef | null,
  force = false,
): Array<{ text: string; emotion: string; kind: 'speak' | 'narr' }> {
  if (!doc || !scriptMode) return []
  const { items, cursor } = extractScriptChunkDelta(partial, scriptCursor, palette, force)
  scriptCursor = cursor
  const fresh: Array<{ text: string; emotion: string; kind: 'speak' | 'narr' }> = []
  for (const it of items) {
    doc.segments.push({ id: doc.segments.length, text: it.text, kind: it.kind, emotion: it.emotion, state: 'closed' })
    fresh.push(it)
  }
  if (fresh.length > 0) markDirty()
  return fresh
}

/**
 * 全量切片入口：由 chatTurn 在每次 flush 时用累积 partial 调用。
 * 闭合项数只增不减（与已入稿数比较，新增项追加进 segments），trailing 记录书写中尾部。
 *
 * 变体兜底（2026-10-14 15:53 轮实锤）：模型偶发输出对象闭合切片器暂时认不出的形态，
 * 流式首 flush 就把半截文本（如「（鲸鱼」）建成 speak 底稿段，后续真闭合项到达后被追加
 * 在其后面 → 全部错位（旁白样式错乱、结束后才对）。修复：兜底段与闭合项**互斥**——
 * 真闭合项出现时兜底段让位（整段删除、后续项正常追加）；兜底段存在期间不再追加新项。
 * 判定标志：segments[0] 带 fallback 标记（内存态，不入快照契约）。
 */
export function syncFromPartial(partial: string, palette?: import('../../src/types').EmotionPaletteRef | null): Array<{ text: string; emotion: string; kind: 'speak' | 'narr' }> {
  if (!doc) return []
  const { closed, trailing } = extractDialogueObjects(partial, palette)
  const fresh: Array<{ text: string; emotion: string; kind: 'speak' | 'narr' }> = []
  /** 现存兜底段（fallback 标记记在 emotion 前缀哨兵上，见下方入稿处） */
  const hasFallback = doc.segments.length > 0 && (doc.segments[0] as TurnSegment & { __fallback?: boolean }).__fallback === true
  if (hasFallback && closed.length > 0) {
    // 真闭合项已出现：兜底段让位（切片器恢复，重建为闭合项序列）
    doc.segments = []
    dirty = true
  }
  const blocked = (doc.segments.length > 0 && (doc.segments[0] as TurnSegment & { __fallback?: boolean }).__fallback === true)
  // 幂等对齐：已入稿数之前的项跳过（闭合列表只增不减，切片器输出单调）
  if (!blocked) {
    for (let i = doc.segments.length; i < closed.length; i++) {
      const it = closed[i]!
      doc.segments.push({ id: doc.segments.length, text: it.text, kind: it.kind, emotion: it.emotion, state: 'closed' })
      fresh.push(it)
    }
  }
  if (doc.trailing !== trailing) {
    doc.trailing = trailing
    dirty = true
  }
  // 变体兜底：闭合项与 trailing 全空但流式文本提取有内容 → 单一 speak 底稿段
  if (doc.segments.length === 0 && closed.length === 0 && !trailing.trim()) {
    const prose = extractStreamingJsonText(partial).trim()
    if (prose) {
      const seg: TurnSegment & { __fallback?: boolean } = { id: 0, text: prose, kind: 'speak', emotion: '平静', state: 'closed' }
      seg.__fallback = true
      doc.segments.push(seg)
      doc.trailing = ''
      fresh.push({ text: prose, emotion: '平静', kind: 'speak' })
      dirty = true
    }
  } else if (blocked && closed.length === 0) {
    // 兜底段随流式增长更新（模型放弃 JSON 契约输出纯文本时唯一的底稿段）——
    // 早先只在首帧创建一次、之后冻结，语音门控的揭示总量停在几个字上（2026-10-14 20:44 轮实锤）
    const prose = extractStreamingJsonText(partial).trim()
    const head = doc.segments[0] as TurnSegment & { __fallback?: boolean }
    if (prose && prose !== head.text) {
      head.text = prose
      dirty = true
    }
  }
  if (fresh.length > 0) markDirty()
  else if (dirty) markDirty() // trailing 已标脏，合并节流
  return fresh
}

/** 文本流结束（落盘前）：phase → reading（语音跟读阶段）并启动看门狗 */
export function markReading(): void {
  if (!doc) return
  doc.phase = 'reading'
  doc.readingAt = Date.now()
  markDirty()
  armWatchdog()
}

/** 启动/重置看门狗（进度重置式：每次进度推进都重新计时） */
function armWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    if (!doc || doc.phase !== 'reading') return
    if (doc.speakingChars > 0 || doc.spokenChars > 0) {
      // 有过进度但没等到 reading-done：也强制落定（进度停滞超时，语音链异常）
      console.warn('[turn] reading 看门狗触发（进度停滞）spokenChars=%d speakingChars=%d → 强制落定', doc.spokenChars, doc.speakingChars)
    } else {
      console.warn('[turn] reading 看门狗触发（零进度，语音链疑似全灭/宠物窗未消费）→ 强制落定')
    }
    forceFinish()
  }, READING_WATCHDOG_MS)
}

/** 修正本轮语音可用性标记（chatTurn 在 settings/角色卡加载完成、voiceActive 求值后调用） */
export function markVoice(voice: boolean): void {
  if (!doc || doc.voice === voice) return
  doc.voice = voice
  markDirty()
}

/**
 * 语音进度记账（字符口径，方案A主门控）：宠物窗每消费一个槽位上行累计字符数。
 * 单调取 max（乱序/重复上报无害）；speaking ≥ spoken，差值 = 正在播放的块。
 * 渲染端揭示上限 = speakingChars、下限（快进）= spokenChars——与提取器变体/合音/兜底完全解耦。
 */
export function markProgress(turnId: string, speakingChars: number, spokenChars: number): void {
  if (!doc || doc.turnId !== turnId) return
  const s = Number.isFinite(speakingChars) ? Math.max(0, Math.floor(speakingChars)) : 0
  const p = Number.isFinite(spokenChars) ? Math.max(0, Math.floor(spokenChars)) : 0
  const nextSpeaking = Math.max(doc.speakingChars, s)
  const nextSpoken = Math.min(nextSpeaking, Math.max(doc.spokenChars, p))
  if (nextSpeaking === doc.speakingChars && nextSpoken === doc.spokenChars) return
  doc.speakingChars = nextSpeaking
  doc.spokenChars = nextSpoken
  // 进度重置式看门狗：有任何推进就重新计时（慢速 TTS 全程不误杀；语音链真死才超时）
  if (doc.phase === 'reading') armWatchdog()
  markDirty()
}

/**
 * 语音链工作心跳（宠物窗合成/播放进行中周期上行）：仅重置看门狗计时，不改动进度数据。
 * 语义：链路活着（哪怕进度暂时停滞）→ 不强制落定；真正全灭（无进度且无心跳）才超时兜底。
 */
export function markReadingPing(turnId: string): void {
  if (!doc || doc.turnId !== turnId || doc.phase !== 'reading') return
  armWatchdog()
}

/**
 * 语音跟读收尾（宠物窗在语音/旁白槽位全部消费完后上行）：phase → done。
 * 幂等（重复上报/无文档/turnId 不匹配直接忽略）；final 由最近一次 finish/abort 或此处兜底补齐。
 * done 快照立即广播不节流——渲染端靠它落定型。
 */
export function markReadingDone(turnId: string): void {
  if (!doc || doc.turnId !== turnId) return
  if (doc.phase === 'done') return
  forceFinish()
}

/** 强制落定（正常收尾与看门狗共用的终态路径） */
function forceFinish(): void {
  if (!doc) return
  clearWatchdog()
  doc.phase = 'done'
  if (!doc.final && doc.segments.length > 0) {
    // 兜底 final：由 segments 映射（正常路径 final 已由 finishTurn/abortTurn 填充）
    doc.final = segmentsToFinalMessage(doc)
  }
  broadcastDone()
}

/** 由文档 segments 生成定型消息（final 缺失时的兜底映射） */
function segmentsToFinalMessage(doc: TurnDocument): import('../../src/types').ChatMessage {
  const content = doc.segments.map((s) => (s.kind === 'narr' ? `（${s.text.replace(/^[（(]|[）)]$/g, '')}）` : s.text)).join('\n')
  const lastSpeak = [...doc.segments].reverse().find((s) => s.kind === 'speak')
  return { role: 'assistant', content, emotion: lastSpeak?.emotion, timestamp: Date.now() }
}

/** done 快照立即广播（不节流）并清掉挂起的节流定时器 */
function broadcastDone(): void {
  if (!doc) return
  clearWatchdog()
  windowManager.broadcastAI('ai:turn-done', { doc: { ...doc, segments: doc.segments.map((s) => ({ ...s })) } })
  dirty = false
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = null
  }
}

/** 文本流结束但无语音（直接落盘定型）：phase → done 并携带 final */
export function finishTurn(final: import('../../src/types').ChatMessage): void {
  if (!doc) return
  doc.phase = 'done'
  doc.final = final
  // done 快照必须立即送达（不节流）：渲染端靠它落定
  broadcastDone()
}

/** 回合异常终止（错误/取消）：文档置 done（final 由调用方传入已流出部分或省略） */
export function abortTurn(final?: import('../../src/types').ChatMessage): void {
  if (!doc) return
  doc.phase = 'done'
  if (final) doc.final = final
  broadcastDone()
}

/** 拉取当前快照（ai:get-turn-snapshot invoke；无文档返回 null。原子读、幂等） */
export function getSnapshot(): TurnDocument | null {
  if (!doc) return null
  return { ...doc, segments: doc.segments.map((s) => ({ ...s })) }
}

/** 当前文档的 turnId（无文档返回 null；chatTurn 语音上行校验用） */
export function currentTurnId(): string | null {
  return doc?.turnId ?? null
}

/** 当前文档只读引用（chatTurn 语音块组装读 segments 用；禁止修改） */
export function getDoc(): Readonly<TurnDocument> | null {
  return doc
}

/** phase 类型再导出（chatTurn 判断用） */
export type { TurnPhase }

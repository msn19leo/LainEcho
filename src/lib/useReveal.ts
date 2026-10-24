/**
 * 逐字揭示游标 hook（方案A字符口径门控）：
 *
 *  - speed：每字毫秒；<=0 即时全显。打字循环带时间余额折算（自适应追赶）——实测速率恒等于
 *    标称 speed，不受主线程负载拖慢（否则上游债务等待时钟估错，尾字迟到，见 useEffect 内注释）。
 *  - 门控（voiceGated）：cap=已开播字符数（speakingChars）、floor=已完播字符数（spokenChars）
 *    ——语音播到哪、文本就放行到哪（文本不跑在语音前）。
 *  - **floor 快进只在换代时对齐一次**（turnKey 变化 = 新轮/重试换代/中途挂载）：
 *    覆盖"窗口中途打开快进已播前缀"的场景；直播期间忽略 floor——否则零时长旁白槽位
 *    消费时 spoken 瞬间跳过整段旁白，揭示游标被快进 → 旁白一次性整段输出而非打字机流式
 *    （2026-10-14 晚实锤）。直播中由 cap 门控 + 打字机速度推进即可。
 *  - 非门控（无语音轮）：cap=total、floor=0，退化为纯打字机。
 *
 * 主进程单调取 max（markProgress），渲染端只做 clamp——游标本体只增不减、不因文本增长重置。
 */
import { useEffect, useRef, useState } from 'react'

export function useGatedRevealCount(turnKey: string | null, total: number, speed: number, voiceGated: boolean, turnFinished: boolean, capChars: number, floorChars: number): { count: number; typing: boolean } {
  const [visible, setVisible] = useState(0)
  const visibleRef = useRef(0)
  /** 已对齐的换代代际（turnKey）；null = 尚未初始化 */
  const initKeyRef = useRef<string | null>(null)

  // 渲染期 clamp：门控上限/下限与总长每帧重算（来自快照，单调）
  const effTotal = Math.max(0, total)
  // 门控上限：朗读中 = 已开播字符数；**turnFinished（phase=done）= 本轮文本已全部定型的权威信号，
  // 上限直接放开到全文**——宠物窗按槽位累计的进度与文档分段总量存在细微口径差（块内换行/trim/
  // 拆分丢空白），一旦少报几个字，收尾揭示会永远差几个字、光标常驻（2026-10-14 22:19 轮实锤）；
  // 放开后任何记账漂移最多表现为尾字稍快打完，不再可能永久卡死。
  const cap = voiceGated ? (turnFinished ? effTotal : Math.min(capChars, effTotal)) : effTotal
  const floor = voiceGated ? Math.min(floorChars, cap) : 0

  // 换代初始化：turnKey 变化时把游标对齐到 floor 一次——
  // 中途挂载/开窗 → floor=已播前缀（快进直显）；新轮开始 → floor=0（归零重来）。
  // 此后直播期间不再跟随 floor（旁白零时长槽位不再瞬跳整段）。
  if (initKeyRef.current !== turnKey) {
    initKeyRef.current = turnKey
    visibleRef.current = floor
    setVisible(floor)
  } else if (visibleRef.current > effTotal) {
    // 回缩防护（快照异常回退）：游标不得超前总长/上限
    visibleRef.current = effTotal
    setVisible(effTotal)
  } else if (visibleRef.current > cap) {
    // 门控收紧（快照回退等异常）：回落
    visibleRef.current = cap
    setVisible(cap)
  }

  const capRef = useRef(cap)
  capRef.current = cap
  const totalRef = useRef(effTotal)
  totalRef.current = effTotal

  useEffect(() => {
    // 即时模式：直顶上限（每帧随 cap 放行）
    if (speed <= 0) {
      visibleRef.current = Number.MAX_SAFE_INTEGER
      setVisible(Number.MAX_SAFE_INTEGER)
      return
    }
    // 自适应追赶打字循环（时间余额折算）：setInterval 实际间隔受主线程负载（Live2D 渲染/
    // 每字一次的组件重渲染）拖慢，固定 +1 字会让实测打字速度慢于标称 speed——上游债务等待
    // 时钟（PetApp revealDueAt = delta × 标称每字毫秒）据此估错，下一段语音开播时上一段
    // 尾字还没打完（2026-10-19 23:00 轮实锤：旁白 43 字瞬跳后尾字迟到）。改为累计真实
    // 流逝时间折算本 tick 应补字数，一次补齐并合并为单次 setVisible 重渲染——平均速率
    // 恒等于标称速度，债务时钟的"标称恒速模型"与现实吻合。
    let lastTick = Date.now()
    /** 未消费的时间余额（ms）：不足一字的零头留到下个 tick */
    let creditMs = 0
    const timer = setInterval(() => {
      const now = Date.now()
      creditMs += now - lastTick
      lastTick = now
      const chars = Math.floor(creditMs / speed)
      if (chars > 0) {
        creditMs -= chars * speed
        // 只追上限不超总长：门控下 cap 随语音进度增长，游标自然被放行；
        // 一次补多字不超 cap——打字机可以追平上限，永不越过（文本不跑在语音前）
        const capNow = Math.min(capRef.current, totalRef.current)
        if (visibleRef.current < capNow) {
          visibleRef.current = Math.min(capNow, visibleRef.current + chars)
          setVisible(visibleRef.current)
          return
        }
      }
      // 无字可打（追平上限/折算不足一字）：余额封顶一字——cap 停滞（等语音）期间不攒量，
      // 避免 cap 瞬跳（旁白零时长槽位一次解锁整段）后攒下的余额一口气全显、破坏逐字效果
      if (creditMs > speed) creditMs = speed
    }, speed)
    return () => clearInterval(timer)
  }, [speed])

  // 打字中 = 游标落后于门控上限（还有已放行未打出的字，打字机正在逐字输出 → 光标静态常显）；
  // 追平上限 = 等待新文本（cap 停住等音频推进/下一段 → 光标转闪烁）。
  // 速度<=0（即时全显）恒非打字中。光标态消费者见 MessageList/PetContentList 的 --waiting 类。
  const count = Math.min(visible, effTotal)
  return { count, typing: speed > 0 && count < cap }
}

/** 按揭示游标把分段序列切片：返回已揭示的段（最后一段可能是部分文本） */
export function sliceSegmentsByCount<T extends { text: string; kind: 'speak' | 'narr' }>(segments: T[], count: number): Array<{ text: string; kind: 'speak' | 'narr' }> {
  const out: Array<{ text: string; kind: 'speak' | 'narr' }> = []
  let remaining = count
  for (const seg of segments) {
    if (remaining <= 0) break
    if (seg.text.length <= remaining) {
      out.push({ text: seg.text, kind: seg.kind })
      remaining -= seg.text.length
    } else {
      out.push({ text: seg.text.slice(0, remaining), kind: seg.kind })
      remaining = 0
    }
  }
  return out
}

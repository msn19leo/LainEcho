/**
 * 消息流（airi 风格竖向对话流）。
 *
 * 设计：
 *   - 用户消息靠右（气泡右对齐）：品牌纯色底（深色青 / 浅色淡蓝）+ 主色光晕，文字左对齐。
 *   - AI 消息靠左：毛玻璃卡片 + 主色调边框。
 *   - 流式输出带流光打字机光标（.streaming-cursor，见 index.css）。
 *   - 消息出现使用 popSlideUp 弹性入场（scale 0.96 + y 12，0.4s 弹性曲线），逐条轻微错落。
 *   - 滚动优化（T3）：新消息/流式更新仅在用户接近底部时自动滚到底，且用瞬时滚动替代
 *     smooth，避免每个 token 都做一次平滑滚动造成卡顿。
 *   - 末条 AI 由常驻槽位（LastAiSlot）接管：roundActive 期间定型行不再由 map 渲染，
 *     直播（流式/跟读）与定型两个阶段在同一槽位内切换，不经历「卸载 → 重挂载」，
 *     从根上消除回答收尾时入场动画重播造成的气泡闪烁。
 */
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { api } from '../api'

import { typingSpeedToMs, useSettingsStore } from '../store/settingsStore'
import { Typewriter } from '../components/Typewriter'
import { cn, formatTime, groupLiveSegments, groupMessageBubbles, narrBubbleText, type MessageBubbleGroup } from '../lib/utils'
import { sliceSegmentsByCount, useGatedRevealCount } from '../lib/useReveal'
import { liveSegmentsOf, useTurnDocStore } from '../store/turnDocStore'
import { useAutoScrollBottom } from '../lib/useAutoScrollBottom'
import { PositionedMenu } from '../components/DropdownMenu'
import { RewindEditBox, rewindTargetFor, useRewind } from '../components/messageRewind'
import type { ChatMessage } from '../types'
import { popSlideUp, springElastic } from '../lib/motion'

/** 距底部小于该阈值视为"接近底部"，此时才自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD = 80

export function MessageList() {
  // 逐字速度由独立的 LastAiSlot 组件内部读取（见函数 LastAiSlot）
  const messages = useSessionStore((s) => s.messages)
  // 顶层订阅直播源：仅用于 roundActive 上升沿判定（本轮是否开始过）
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const streaming = useSessionStore((s) => s.streaming)
  const streamError = useSessionStore((s) => s.streamError)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const currentCardName = useCurrentCardName()
  // 方案A：快照（roundActive 上升沿判定用；LastAiSlot 内部另有自己的快照订阅）
  const roundTurnDoc = useTurnDocStore((s) => s.doc)
  const roundTurnSeq = useTurnDocStore((s) => s.seq)
  const roundTurnLive = useMemo(() => liveSegmentsOf(roundTurnDoc), [roundTurnDoc])
  // roundActive 用：未终态才视为直播活跃（done 后回退定型渲染）
  const roundTurnActive = !!roundTurnDoc && roundTurnDoc.phase !== 'done' && roundTurnDoc.sessionId === currentSessionId
  const listRef = useRef<HTMLDivElement>(null)
  /** 内容区外层（观测其实际高度以在打字机/流式增长时自动滚到底） */
  const contentRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  /** 最后一条 AI 消息（用于按需分段展示合成分段，便于阅读） */
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  })()

  /**
   * 本轮活跃标记：自本视图内第一轮流式/直播内容出现起为 true，
   * 期间末条 AI 消息交给 LastAiSlot 接管（map 跳过）；
   * 切换会话时重置（渲染期间调整，避免重置落后一帧）。
   */
  const [roundSession, setRoundSession] = useState(currentSessionId)
  const [roundActive, setRoundActive] = useState(false)
  // 会话切换重置后若直播源仍活跃，必须让 roundActive 回真——否则 LastAiSlot 不接管，
  // 落盘全文直接定型显示（跟读中打开聊天窗的场景B，2026-10-13 22:44/22:54 截图）。
  // 关键：认领补发的 segments 在 loadSession（异步）完成之前到达，重置发生在最后一次
  // segments 更新之后，仅依赖 segments 引用变化不够——必须把 currentSessionId 一并列入
  // 依赖（loadSession 完成必然改变它 → effect 重跑 → segments 非空 → roundActive 回真）。
  if (roundSession !== currentSessionId) {
    setRoundSession(currentSessionId)
    setRoundActive(false)
  }
  useEffect(() => {
    // 方案A单源：快照存在（属于当前会话且未 done）即直播活跃——认领=拉快照后，
    // 快照到达本身就是接管信号（生成中/跟读中开窗的两个场景由此结构性解决）。
    // 加门：快照必须有内容（segments/trailing 非空）才置真——新轮 beginTurn 瞬间快照
    // 尚空，此时接管会让空槽位顶没上一轮定型回答几秒（2026-10-14 15:53 实锤）。
    const snapshotHasContent = !!roundTurnDoc && (roundTurnDoc.segments.length > 0 || roundTurnDoc.trailing.length > 0)
    if (streaming || (roundTurnActive && snapshotHasContent)) {
      setRoundActive(true)
    }
  }, [currentSessionId, streaming, roundTurnActive, roundTurnLive, roundTurnSeq, roundTurnDoc])

  /**
   * 本轮用户气泡（方案A权威源）：快照自含本轮 user 消息，直播期间只要 messages 里还没有
   * 它就从 doc 补渲染——用户消息回合结束才落盘，中途开窗/本地列表被覆盖时气泡不消失。
   * 去重按全量扫描（内容+时间戳双匹配，落盘消息与 doc.user 的 timestamp 同源）：
   * 只看末条会在 stream-done 落定 assistant 后失效 → 用户气泡重复出现，done 后又消失
   * （2026-10-14 20:27 轮实锤）。
   */
  const docUser = roundTurnActive ? roundTurnDoc?.user : undefined
  const showDocUser =
    !!docUser?.content &&
    !messages.some(
      (m) => m.role === 'user' && m.content === docUser.content && Math.abs((m.timestamp ?? 0) - (docUser.timestamp ?? 0)) < 2000,
    )

  /**
   * 末条 AI 是否为本轮消息（timestamp 晚于本轮 user）：直播槽位只顶替本轮的定型消息，
   * 上一轮的定型消息在生成/跟读期间保持可见（与桌宠窗同规则，2026-10-14 20:44 轮对齐）。
   */
  const lastAssistantMsg = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined
  const lastAssistantIsCurrentTurn =
    !!lastAssistantMsg &&
    !!roundTurnDoc &&
    roundTurnDoc.sessionId === currentSessionId &&
    (lastAssistantMsg.timestamp ?? 0) > (roundTurnDoc.user?.timestamp ?? Number.MAX_SAFE_INTEGER)

  // 监听滚动：用户上翻看历史时不强制拉回底部
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
  }

  // 内容高度增长（含打字机逐字 reveal、流式、跟读追加段）时自动滚到底；
  // 仅在用户接近底部时跟随，尊重其上翻历史
  useAutoScrollBottom(listRef, contentRef, nearBottomRef, [messages, streaming, streamError])

  /** 消息重答（最后一轮）：右键气泡 → 编辑并重发 / 重新回答（与桌宠迷你会话框共用逻辑） */
  const rewind = useRewind()

  if (messages.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-8" style={{ background: 'var(--bg-base)' }}>
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: springElastic }}
          className="text-center"
        >
          <motion.div
            className="mb-3 text-4xl"
            animate={{ y: [0, -7, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            👋
          </motion.div>
          <p className="text-sm font-medium text-text-2">
            和 {currentCardName || '桌宠'} 打个招呼吧
          </p>
          <p className="mt-1.5 text-xs text-text-muted">发送第一条消息，开启与桌宠的对话</p>
        </motion.div>
      </div>
    )
  }

  return (
    <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4" style={{ background: 'var(--bg-base)' }}>
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef} className="space-y-4">
      {messages.map((msg, i) => {
        // roundActive 期间（非流式生成中），末条 AI 定型行由 LastAiSlot 接管：map 跳过，
        // 槽位在原气泡位置渲染直播（打字机）或定型排版，交接不重挂载、不重播入场动画。
        // 仅顶替**本轮**的消息（见 lastAssistantIsCurrentTurn），上一轮定型消息保持可见
        if (roundActive && !streaming && msg.role === 'assistant' && i === lastAssistantIndex && lastAssistantIsCurrentTurn) {
          return null
        }
        const isUser = msg.role === 'user'
        // 主动搭话旁白：弱化的居中斜体行（非用户气泡），标识"角色主动开口"的舞台指示
        if (isUser && msg.meta?.proactive) {
          return (
            <motion.div key={i} {...popSlideUp} transition={{ ...popSlideUp.transition, delay: Math.min(i * 0.04, 0.32) }} className="my-3 flex justify-center">
              <p className="max-w-[85%] text-center text-xs italic leading-relaxed text-text-muted selectable">{msg.content}</p>
            </motion.div>
          )
        }
        return (
          <motion.div
            key={i}
            {...popSlideUp}
            // roundActive 期间末条 AI 从槽位移交回 map（新一轮流式开始）时跳过入场动画，避免交接闪烁
            initial={roundActive && i === lastAssistantIndex ? false : undefined}
            transition={{ ...popSlideUp.transition, delay: Math.min(i * 0.04, 0.32) }}
            className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
            onContextMenu={(e) => {
              // 消息重答入口（仅最后一轮）：user 气泡=编辑并重发，assistant 气泡=重新回答
              const kind = rewindTargetFor(i, messages, streaming)
              if (!kind) return
              e.preventDefault()
              rewind.openMenu(kind, e.clientX, e.clientY)
            }}
          >
            <div className="max-w-[80%] text-left">
              <div className={cn('mb-1 flex items-center gap-2 px-1 text-xs text-text-muted', isUser && 'justify-end')}>
                <span>{isUser ? '你' : currentCardName || 'AI'}</span>
                {msg.timestamp && <span>{formatTime(msg.timestamp)}</span>}
              </div>
              {isUser && rewind.editing && i === messages.length - 2 ? (
                // 气泡原位编辑（最后一轮 user）：textarea 替换气泡，确认 = 编辑并重发
                <RewindEditBox initial={msg.content} onConfirm={rewind.confirmEdit} onCancel={rewind.cancelEdit} />
              ) : (
                <div
                  className={cn(
                    'selectable whitespace-pre-wrap break-words px-4 py-2.5 text-sm leading-relaxed',
                    isUser
                      ? // 用户气泡：品牌纯色底 + 主色光晕（深色青 / 浅色淡蓝，与主题呼应）
                        'rounded-[var(--radius-lg)] rounded-br-[var(--radius-md)] bg-primary-gradient text-[var(--on-brand)] shadow-[var(--shadow-glow-primary)]'
                      : // AI 气泡：毛玻璃卡片 + 主色调边框
                        'glass rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] text-text',
                  )}
                >
                  {isUser ? (
                    msg.content
                  ) : (
                    <AssistantBubbles message={msg} />
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )
      })}

      {/* 本轮用户气泡（快照权威源）：messages 缺它时由 doc.user 补上，形态与常规用户气泡一致；
          proactive 旁白轮与常规 proactive 渲染同款（居中弱化斜体行，非用户气泡） */}
      {showDocUser && (
        docUser!.meta?.proactive ? (
          <motion.div {...popSlideUp} className="my-3 flex justify-center">
            <p className="max-w-[85%] text-center text-xs italic leading-relaxed text-text-muted selectable">{docUser!.content}</p>
          </motion.div>
        ) : (
          <motion.div {...popSlideUp} className="flex justify-end">
            <div className="max-w-[80%] text-left">
              <div className="mb-1 flex items-center gap-2 px-1 text-xs text-text-muted">
                <span>你</span>
                {docUser!.timestamp && <span>{formatTime(docUser!.timestamp)}</span>}
              </div>
              <div className="selectable whitespace-pre-wrap break-words rounded-[var(--radius-lg)] rounded-br-[var(--radius-md)] bg-primary-gradient px-4 py-2.5 text-sm leading-relaxed text-[var(--on-brand)] shadow-[var(--shadow-glow-primary)]">
                {docUser!.content}
              </div>
            </div>
          </motion.div>
        )
      )}

      {/* 末条 AI 常驻槽位：roundActive 期间接管直播（流式/跟读打字机）与定型渲染，
          交接在组件内部完成，不重挂载、不重播入场动画 */}
      {roundActive ? (
        <LastAiSlot
          name={currentCardName || 'AI'}
          message={lastAssistantIndex >= 0 ? (messages[lastAssistantIndex] as ChatMessage) : undefined}
          listRef={listRef}
          nearBottomRef={nearBottomRef}
        />
      ) : null}

      {/* 两窗统一的失败提示（基于消息流判定，窗口重载后依然可见）：
          末条是用户消息且不在生成中 = 这轮没有 AI 回复落盘；消息上的 error 字段携带具体原因。
          发送下一条消息并成功落定后（末条变为 assistant）自动消失。
          直播期间（roundTurnActive）不提示——中途开窗时消息列表尚未补齐属正常态。 */}
      {(() => {
        if (roundTurnActive) return null
        const lastMessage = messages[messages.length - 1]
        const lastIsUser = !!lastMessage && lastMessage.role === 'user' && !lastMessage.meta?.proactive
        // streamError 横幅仅覆盖"末条不是用户消息"的失败（如建会话失败）；末条挂起时由下方提示接管，避免重复
        return (
          <>
            {streamError && !streaming && !lastIsUser && (
              <div className="flex justify-center">
                <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  <AlertTriangle size={14} strokeWidth={1.75} />
                  {streamError}
                </div>
              </div>
            )}
            {!streaming && lastIsUser && (
              <div className="flex justify-center">
                <div
                  className="flex max-w-[85%] items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 py-2 text-xs"
                  style={{ color: 'var(--warning)' }}
                >
                  <AlertTriangle size={14} strokeWidth={1.75} />
                  <span>
                    上一条消息未收到回复
                    {lastMessage!.error ? `：${lastMessage.error}` : '（可能网络中断或服务暂不可用）'}
                  </span>
                </div>
              </div>
            )}
          </>
        )
      })()}
      {/* 消息重答右键菜单：编辑并重发（最后一轮 user）/ 重新回答（最后一轮 assistant） */}
      <PositionedMenu
        x={rewind.menu?.x ?? 0}
        y={rewind.menu?.y ?? 0}
        open={!!rewind.menu}
        items={
          rewind.menu?.kind === 'edit'
            ? [{ key: 'edit', label: '编辑并重发', onSelect: rewind.confirmMenu }]
            : [{ key: 'regen', label: '重新回答', onSelect: rewind.confirmMenu }]
        }
        onClose={rewind.closeMenu}
      />
      </div>
    </div>
  )
}

/**
 * 末条 AI 常驻槽位：roundActive 期间接管末条 AI 消息的显示。
 *
 * - 直播阶段：跟读显示 readingText 打字机（宠物窗随语音段段追加的镜像），非跟读显示
 *   streamingContent 打字机；行为与原 StreamingBubble 一致。
 * - 定型阶段：流式结束且直播源排空后，同一位置直接渲染定型排版（AssistantBubbles 多气泡），
 *   无重挂载、无入场动画重播——这是消除"回答收尾气泡闪烁"的关键。
 * - 定型阶段持续到本轮视图结束（切换会话重置），期间该行由 map 跳过，不重复渲染。
 */
function LastAiSlot({
  name,
  message,
  listRef,
  nearBottomRef,
}: {
  name: string
  /** 接管的末条 AI 消息（定型阶段渲染其内容；中止等场景可能尚未落盘 → undefined） */
  message: ChatMessage | undefined
  listRef: RefObject<HTMLDivElement | null>
  nearBottomRef: RefObject<boolean>
}) {
  const streaming = useSessionStore((s) => s.streaming)
  // ===== 方案A第3步：单源切换——turnDocStore 是唯一直播数据源 =====
  // 旧镜像链（chatReadingStore.segments/readingActive、readingDone 标志）退役；
  // 快照自含分段、语音进度与阶段，定型判定由 phase=done 推导。
  const turnDoc = useTurnDocStore((s) => s.doc)
  const turnSeq = useTurnDocStore((s) => s.seq)
  const currentSessionIdLocal = useSessionStore((s) => s.currentSessionId)
  const turnLive = useMemo(() => liveSegmentsOf(turnDoc), [turnDoc])
  const docForSession = !!turnDoc && turnDoc.sessionId === currentSessionIdLocal
  /** phase 未终态 = phase 级直播 */
  const phaseLive = docForSession && turnDoc!.phase !== 'done'
  /**
   * 尾字打字代际：phase 翻 done 的瞬间若本地揭示尚未追平（收尾段是零时长旁白槽位时
   * reading-done 与最后一次进度同时到达），直播气泡保持挂载继续打完再换定型——
   * 直接切定型会把尾段整段一次性顶上（2026-10-14 20:46 轮实锤）。turnId 变化自动失效。
   */
  const tailTypingRef = useRef<string | null>(null)
  if (phaseLive) tailTypingRef.current = turnDoc!.turnId
  /** 直播渲染候选（含尾字打字期）：turnKey 依赖它保持稳定，跨 done 翻转不重置揭示游标 */
  const liveCandidate = docForSession && (phaseLive || tailTypingRef.current === turnDoc?.turnId)
  /** 直播总字符量（segments + trailing，与门控游标同口径） */
  const liveTextTotal = turnDoc ? turnDoc.segments.reduce((n, s) => n + s.text.length, 0) + turnDoc.trailing.length : 0
  // 逐字速度：从全局设置读文字显示速度档（0-100）并换算为每字间隔毫秒
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? 80)
  const typeSpeed = typingSpeedToMs(textSpeed)
  // 跟读揭示游标（方案A字符口径门控）：有语音轮 → 已开播字符内才可见（文本不跑在语音前），
  // 已完播前缀快进（仅换代/挂载时对齐一次，直播中零时长旁白槽位不瞬跳）；无语音轮 → 纯打字机。
  const gated = docForSession && !!turnDoc?.voice
  const { count: revealCount, typing: revealTyping } = useGatedRevealCount(
    liveCandidate ? turnDoc!.turnId : null,
    liveTextTotal,
    typeSpeed,
    gated,
    !phaseLive,
    turnDoc?.speakingChars ?? 0,
    turnDoc?.spokenChars ?? 0,
  )
  /** 直播渲染中：phase 未终态，或已终态但本窗揭示尚未追平（尾字打字中） */
  const liveRendering = !!liveCandidate && (phaseLive || revealCount < liveTextTotal)
  /** 直播活动：揭示未追平（= 光标是否显示的唯一条件） */
  const liveReadingActive = liveRendering && revealCount < liveTextTotal
  /** 光标态：打字推进中静态常显（revealTyping），等待新文本（追平门控上限）时闪烁 */
  const liveCursorMode: 'typing' | 'waiting' = revealTyping ? 'typing' : 'waiting'
  /** 直播分段（单源：快照） */
  const liveSegments = liveRendering ? turnLive : []

  // 流式内容更新时跟随滚动（复用父级列表，仅在接近底部时瞬时滚动）
  useEffect(() => {
    const el = listRef.current
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [revealCount, turnSeq, listRef, nearBottomRef])

  // 定型判定（方案A单源）：直播渲染结束（phase=done 且揭示追平）→ 定型渲染。
  // 快照 phase + 本地揭示游标共同决定——尾字打字期间保持直播渲染，避免尾段整段跳变。
  const finalized = !liveRendering

  if (finalized) {
    // 中止/失败等场景消息可能尚未落盘：无可渲染内容，直接隐藏（与原"气泡隐藏"语义一致）
    if (!message) return null
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] text-left">
          <div className="mb-1 flex items-center gap-2 px-1 text-xs text-text-muted">
            <span>{name}</span>
            {message.timestamp && <span>{formatTime(message.timestamp)}</span>}
          </div>
          <div className="glass selectable whitespace-pre-wrap break-words rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
            <AssistantBubbles message={message} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <motion.div {...popSlideUp} className="flex justify-start">
      <div className="max-w-[80%] text-left">
        <div className="mb-1 px-1 text-xs text-text-muted">{name}</div>
        <div className="glass selectable rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
          {/* 直播气泡（方案A单源+语音门控+定型同构渲染）：可见分段经 groupLiveSegments 分组后
              与定型共用 ChatBubbleGroups——旁白弱化样式（自动补（））、台词样式、行距与定型完全一致，
              收尾无重排。有语音轮：语音播到哪段、文本跟到哪段（未播段不显示，已播段快进直显）；
              无语音轮：trailing 流式打字机（与生成同速）。 */}
          {(() => {
            const gatedShown = sliceSegmentsByCount(liveSegments, revealCount)
            if (gatedShown.length > 0) {
              return <ChatBubbleGroups groups={groupLiveSegments(gatedShown)} cursor={liveReadingActive ? liveCursorMode : undefined} />
            }
            // 门控下尚无可见内容（首段语音未开始）：光标占位（等待文本 → 闪烁）；无语音轮走 trailing 打字机
            if (gated) {
              return (
                <span className="whitespace-pre-wrap break-words">
                  {liveReadingActive && <span className="streaming-cursor streaming-cursor--waiting" />}
                </span>
              )
            }
            return (
              <Typewriter
                text={turnDoc?.trailing ?? ''}
                speed={typeSpeed}
                className="whitespace-pre-wrap break-words"
                complete={!streaming}
                onDone={() => {}}
                noCursor={liveReadingActive}
              />
            )
          })()}
        </div>
      </div>
    </motion.div>
  )
}

/**
 * 显示前规范化文本：把模型输出的连续换行（含多余空行）统一压成单个换行，去掉过密的空行。
 * 气泡 pre-wrap 保留单换行即可有自然的段间换行。
 */
function normalizeParagraphs(text: string): string {
  return text.replace(/\n+/g, '\n')
}

/**
 * 气泡分组渲染（定型与直播共用同一渲染路径）：
 * narr 组渲染为弱化旁白气泡（自动补（）），speak 组保持台词气泡样式（组内 <br/> 分隔）。
 * cursor='typing'|'waiting' 时在最后一组末尾挂流式光标——'typing'=打字推进中（静态常显）、
 * 'waiting'=等待新文本（闪烁）；直播收尾态与定型 DOM 完全一致，交接零重排。
 */
function ChatBubbleGroups({ groups, cursor }: { groups: MessageBubbleGroup[]; cursor?: 'typing' | 'waiting' }) {
  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((g, gi) => {
        const isLastGroup = gi === groups.length - 1
        if (g.kind === 'narr') {
          return (
            <div
              key={gi}
              className="selectable whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-dashed border-border px-3 py-1.5 text-[13px] italic leading-relaxed text-text-muted"
            >
              {g.texts.map((t, ti) => (
                <Fragment key={ti}>
                  {ti > 0 && <br />}
                  {narrBubbleText(t)}
                  {isLastGroup && ti === g.texts.length - 1 && cursor && <span className={cursor === 'waiting' ? 'streaming-cursor streaming-cursor--waiting' : 'streaming-cursor'} />}
                </Fragment>
              ))}
            </div>
          )
        }
        return (
          <div key={gi} className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
            {g.texts.map((t, ti) => (
              <Fragment key={ti}>
                {ti > 0 && <br />}
                {t}
                {isLastGroup && ti === g.texts.length - 1 && cursor && <span className={cursor === 'waiting' ? 'streaming-cursor streaming-cursor--waiting' : 'streaming-cursor'} />}
              </Fragment>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * AI 回复多气泡渲染（定型路径）：按 kind 分组连续同类段（连续同类合并为一个气泡）。
 * 分组只影响显示，不影响存储（chunks 仍逐段落盘，立绘/语音仍按段驱动）。
 */
function AssistantBubbles({ message }: { message: ChatMessage }) {
  const groups = groupMessageBubbles(normalizeParagraphs(message.content), message.chunks)
  return <ChatBubbleGroups groups={groups} />
}

/** 获取当前角色卡名称（独立 hook，避免 MessageList 因 cards 变化整体重算） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}

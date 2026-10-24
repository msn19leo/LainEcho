/**
 * 宠物窗会话记录列表：
 * - 圆角气泡列表，左右对齐；用户/AI 气泡上方带小名牌，AI 用角色名+角色色表达状态（不塞文字标签）。
 * - 正在生成的那条做"逐字打印"（对已到达的 streamingContent 做打字机 reveal）。
 * 内容随 useSessionStore（宠物窗镜像）与聊天窗同步。
 *
 * 方案A直播渲染（与定型同构）：直播可见分段经 groupLiveSegments 分组后，与定型消息
 * （PetBubbleGroups）共用同一渲染组件——输出时什么样，结束时就什么样，无收尾重排/样式跳变。
 * 进行中轮次的用户气泡以快照 doc.user 为权威源渲染（messages 丢失/被覆盖时气泡不消失）。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { typingSpeedToMs, useSettingsStore } from '../store/settingsStore'
import { Typewriter } from '../components/Typewriter'
import { cn, groupLiveSegments, groupMessageBubbles, narrBubbleText, type MessageBubbleGroup } from '../lib/utils'
import { createScrollPin, useAutoScrollBottom } from '../lib/useAutoScrollBottom'
import { sliceSegmentsByCount, useGatedRevealCount } from '../lib/useReveal'
import { liveSegmentsOf, useTurnDocStore } from '../store/turnDocStore'

/** 当前使用中的角色名（AI 名牌用） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}

/** 单个旁白气泡的紧凑展示：默认展开，点击可折叠（宠物窗内容区窄，折叠省空间）。
 *  展开/折叠时经 onToggleExpand 通知列表创建滚动锚（抑制自动滚底），避免高度变化把列表拉到底部。
 *  children：可选尾随内容（直播态的流式光标），定型路径不传。 */
function PetNarrBubble({ text, onToggleExpand, children }: { text: string; onToggleExpand?: () => void; children?: React.ReactNode }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div
      onClick={(e) => {
        e.stopPropagation()
        onToggleExpand?.()
        setExpanded((v) => !v)
      }}
      className={cn(
        'selectable max-w-full cursor-pointer rounded-[4px] border border-dashed border-[var(--border-strong)] bg-[var(--bg-surface)]/40 px-1.5 py-0.5 text-[11px] italic leading-[15px] text-text-muted',
        !expanded && 'truncate whitespace-nowrap',
      )}
      title={expanded ? '点击收起' : '点击展开'}
    >
      {narrBubbleText(text)}
      {children}
    </div>
  )
}

/**
 * 气泡分组渲染（宠物窗紧凑版，定型与直播共用同一渲染路径）：
 * 连续同类合并；旁白渲染为 PetNarrBubble（与定型一致），台词合并为一个 div（<br/> 分隔）。
 * cursor='typing'|'waiting' 时在最后一组末尾挂流式光标（'typing'=打字推进中静态常显、
 * 'waiting'=等待新文本闪烁；直播收尾态与定型 DOM 完全一致）。
 */
function PetBubbleGroups({ groups, cursor, onNarrToggle }: { groups: MessageBubbleGroup[]; cursor?: 'typing' | 'waiting'; onNarrToggle?: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      {groups.map((g, gi) => {
        const isLastGroup = gi === groups.length - 1
        if (g.kind === 'narr') {
          return (
            <Fragment key={gi}>
              {g.texts.map((t, ti) => (
                <PetNarrBubble key={ti} text={t} onToggleExpand={onNarrToggle}>
                  {isLastGroup && ti === g.texts.length - 1 && cursor ? <span className={cursor === 'waiting' ? 'streaming-cursor streaming-cursor--waiting' : 'streaming-cursor'} /> : null}
                </PetNarrBubble>
              ))}
            </Fragment>
          )
        }
        return (
          <div key={gi} className="selectable whitespace-pre-wrap break-words">
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

/** 定型 AI 消息的多气泡渲染：分组逻辑与直播同口径（groupMessageBubbles） */
function PetAssistantBubbles({ content, chunks, onNarrToggle }: { content: string; chunks?: Array<{ text: string; kind?: 'speak' | 'narr' }> | null; onNarrToggle?: () => void }) {
  const groups = groupMessageBubbles((content || '').replace(/\n+/g, '\n'), chunks)
  return <PetBubbleGroups groups={groups} onNarrToggle={onNarrToggle} />
}

export function PetContentList() {
  /** 逐字速度：从全局设置读文字显示速度档（0-100）并换算为每字间隔毫秒；跟读与流式共用同一速度 */
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? 80)
  const typeSpeed = typingSpeedToMs(textSpeed)
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  // ===== 方案A第3步：单源切换——turnDocStore 是唯一直播数据源 =====
  // 旧跟读累积链（petReadingStore.displayedText/segments）退役；朗读进度由
  // ai:turn-progress 上行进文档、随快照分发，两窗同源天然一致。
  const turnDoc = useTurnDocStore((s) => s.doc)
  const turnSeq = useTurnDocStore((s) => s.seq)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const turnLive = useMemo(() => liveSegmentsOf(turnDoc), [turnDoc])
  const docForSession = !!turnDoc && turnDoc.sessionId === currentSessionId
  /** phase 未终态 = phase 级直播 */
  const phaseLive = docForSession && turnDoc!.phase !== 'done'
  /**
   * 尾字打字代际：phase 翻 done 的瞬间若本地揭示尚未追平（收尾段是零时长旁白槽位时
   * reading-done 与最后一次进度同时到达），直播气泡保持挂载继续打完，再换定型渲染——
   * 直接卸载会把尾段整段一次性顶上（2026-10-14 20:46 轮实锤）。turnId 变化自动失效。
   */
  const tailTypingRef = useRef<string | null>(null)
  if (phaseLive) tailTypingRef.current = turnDoc!.turnId
  /** 直播渲染候选（含尾字打字期）：turnKey 依赖它保持稳定，跨 done 翻转不重置揭示游标 */
  const liveCandidate = docForSession && (phaseLive || tailTypingRef.current === turnDoc?.turnId)
  /** 直播总字符量（segments + trailing，与门控游标同口径） */
  const liveTextTotal = turnDoc ? turnDoc.segments.reduce((n, s) => n + s.text.length, 0) + turnDoc.trailing.length : 0
  /** 朗读期间隐藏最后一条已落定的 AI 消息（由跟读气泡顶替，避免与定型全文重复） */
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  })()
  const aiName = useCurrentCardName()
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 内容区外层：观测实际高度以在打字机/流式/跟读增长时自动滚到底 */
  const contentRef = useRef<HTMLDivElement>(null)
  // 揭示游标（方案A字符口径门控）：有语音轮 → 已开播字符内才可见、已完播前缀快进（仅换代时对齐）；
  // 无语音轮 → 全文可揭示（纯打字机）。与聊天窗 LastAiSlot 同一算法同一口径。
  const gated = docForSession && !!turnDoc?.voice
  const { count: petRevealCount, typing: petRevealTyping } = useGatedRevealCount(
    liveCandidate ? turnDoc!.turnId : null,
    liveTextTotal,
    typeSpeed,
    gated,
    !phaseLive,
    turnDoc?.speakingChars ?? 0,
    turnDoc?.spokenChars ?? 0,
  )
  /** 直播渲染中：phase 未终态，或已终态但本窗揭示尚未追平（尾字打字中） */
  const liveRendering = !!liveCandidate && (phaseLive || petRevealCount < liveTextTotal)
  /** 直播活动：揭示未追平（= 光标是否显示的唯一条件） */
  const liveReadingActive = liveRendering && petRevealCount < liveTextTotal
  /** 光标态：打字推进中静态常显（petRevealTyping），等待新文本（追平门控上限）时闪烁 */
  const liveCursorMode: 'typing' | 'waiting' = petRevealTyping ? 'typing' : 'waiting'
  /** 直播分段（单源：快照） */
  const liveSegments = liveRendering ? turnLive : []
  /**
   * 隐藏末条定型 AI 的门：仅当它是**本轮**的消息（timestamp 晚于本轮 user，即已落盘待语音消费）
   * 才由直播气泡顶替——上一轮的定型消息永不隐藏（早先按"揭示数>0"门控，语音未开播的整段
   * 等待期定型全文会提前渲染、下面再挂一个空的准备输出气泡，且与聊天窗不对称，2026-10-14 20:44 轮实锤）。
   */
  const lastAssistantMsg = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined
  const lastAssistantIsCurrentTurn =
    !!lastAssistantMsg && !!turnDoc && (lastAssistantMsg.timestamp ?? 0) > (turnDoc.user?.timestamp ?? Number.MAX_SAFE_INTEGER)
  const takeoverReady = liveRendering && lastAssistantIsCurrentTurn
  /**
   * 本轮用户气泡（方案A权威源）：快照自含本轮 user 消息，turnActive 期间只要 messages
   * 里还没有它就从 doc 补渲染——用户气泡在任何"本地列表被覆盖/窗口中途打开"场景下都不消失
   * （user 消息回合结束才落盘，中途磁盘快照天然缺它）。
   * 去重按全量扫描（内容+时间戳双匹配，落盘消息与 doc.user 的 timestamp 同源）：
   * 只看末条会在 stream-done 落定 assistant 后失效 → 用户气泡重复出现，done 后又消失
   * （2026-10-14 20:27 轮实锤）。
   */
  const docUser = liveRendering ? turnDoc?.user : undefined
  const showDocUser =
    !!docUser?.content &&
    !messages.some(
      (m) => m.role === 'user' && m.content === docUser.content && Math.abs((m.timestamp ?? 0) - (docUser.timestamp ?? 0)) < 2000,
    )
  /**
   * 贴底跟随（上翻暂停）：距底超阈值且**滚动方向向上**才暂停（程序性拉底是向下跳，
   * 不会误关——否则自动贴底会被自己的滚动事件自锁死）；滚回近底恢复。
   * 替换早先的恒 true（"体积小始终贴底"）：打开聊天框后的挂载追平/分批加载期内容高度
   * 持续增长，ResizeObserver 反复强拉底部，用户上翻历史被拽回（2026-10-16 轮实锤）。
   * 阈值按小窗口取 min(60px, 视口高×0.3)：轻微触碰仍贴底，明显上翻即暂停。
   */
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const threshold = Math.min(60, el.clientHeight * 0.3)
      if (distance <= threshold) {
        followRef.current = true
      } else if (el.scrollTop < lastScrollTopRef.current) {
        followRef.current = false
      }
      lastScrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  /** 旁白气泡展开/收起的滚动锚：临时抑制自动滚底并保持锚点，避免高度变化把列表拉到底部 */
  const pinScroll = useMemo(() => createScrollPin(followRef, scrollRef), [])

  // 内容高度增长（打字机逐字 reveal、流式、跟读追加段）时自动滚到底
  useAutoScrollBottom(scrollRef, contentRef, followRef, [messages, streaming, liveSegments, turnSeq])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-2 py-1 text-[13px] leading-[16px] text-text" onWheel={(e) => e.stopPropagation()}>
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef}>
      {messages.map((msg, i) => {
        // 隐藏末条定型 AI 的判定（方案A单源）：takeoverReady（直播气泡已有可见内容）时由
        // 快照气泡接管，隐藏末条定型消息避免重复；直播结束（done）即恢复定型消息。
        if (takeoverReady && msg.role === 'assistant' && i === lastAssistantIndex) {
          return null
        }
        const isUser = msg.role === 'user'
        // 主动搭话旁白：弱化的居中斜体行（非用户气泡），标识"角色主动开口"的舞台指示
        if (isUser && msg.meta?.proactive) {
          return (
            <div key={i} className="my-2 flex justify-center">
              <p className="max-w-[92%] text-center text-[11px] italic leading-relaxed text-text-muted selectable">{msg.content}</p>
            </div>
          )
        }
        return (
          <div key={i} className={cn('my-1 flex flex-col', isUser ? 'items-end' : 'items-start')}>
            {/* 名牌：用户=你；AI=角色名（用角色色表达说话人/状态） */}
            <span
              className={cn(
                'mb-0.5 select-none px-1 text-[10px] font-medium',
                isUser ? 'text-text-muted' : 'text-[var(--primary-400)]',
              )}
            >
              {isUser ? '你' : aiName}
            </span>
            <div
              className={cn(
                'max-w-[90%] selectable whitespace-pre-wrap break-words rounded-[5px] px-2 py-1',
                isUser
                  ? 'bg-primary-gradient text-[var(--on-brand)]'
                  : 'border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 text-text',
              )}
            >
              {isUser ? (
                msg.content.replace(/\n+/g, '\n')
              ) : (
                <PetAssistantBubbles content={msg.content} chunks={msg.chunks} onNarrToggle={pinScroll} />
              )}
            </div>
          </div>
        )
      })}

      {/* 本轮用户气泡（快照权威源）：messages 缺它时由 doc.user 补上，形态与常规用户气泡一致 */}
      {showDocUser && (
        docUser!.meta?.proactive ? (
          <div className="my-2 flex justify-center">
            <p className="max-w-[92%] text-center text-[11px] italic leading-relaxed text-text-muted selectable">{docUser!.content}</p>
          </div>
        ) : (
          <div className="my-1 flex flex-col items-end">
            <span className="mb-0.5 select-none px-1 text-[10px] font-medium text-text-muted">你</span>
            <div className="max-w-[90%] selectable whitespace-pre-wrap break-words rounded-[5px] bg-primary-gradient px-2 py-1 text-[var(--on-brand)]">
              {docUser!.content.replace(/\n+/g, '\n')}
            </div>
          </div>
        )
      )}

      {/* 失败提示（与聊天窗统一）：末条是用户消息且不在生成中 = 这轮没有 AI 回复落盘；
          消息上的 error 字段携带具体原因，窗口重载后依然可见。下一条消息成功落定后自动消失。
          直播期间（turnActive）不提示——中途开窗时消息列表尚未补齐属正常态。 */}
      {(() => {
        if (liveRendering) return null
        const lastMessage = messages[messages.length - 1]
        // 末条是旁白/剧情消息（非真实用户输入）时不提示"未收到回复"
        const lastIsUser = !!lastMessage && lastMessage.role === 'user' && !lastMessage.meta?.proactive
        return lastIsUser && !streaming ? (
          <div className="my-1 flex justify-center">
            <p
              className="max-w-[92%] rounded-[5px] border border-border bg-[var(--bg-surface)]/70 px-2 py-1 text-center text-[10px]"
              style={{ color: 'var(--warning)' }}
            >
              上一条消息未收到回复
              {lastMessage!.error ? `：${lastMessage.error}` : '（可能网络中断或服务暂不可用）'}
            </p>
          </div>
        ) : null
      })()}

      {/* 直播气泡（方案A单源+语音门控+定型同构渲染）：liveRendering 时由快照分段驱动——生成中
          （trailing 增长）与跟读中（spoken 进度推进）同一渲染路径；可见分段经 groupLiveSegments
          分组后与定型共用 PetBubbleGroups——旁白弱化样式（自动补（））、台词样式、行距与定型完全一致。
          有语音轮：未播段不显示、已播前缀快进（仅换代对齐）、播到哪打到哪；无语音轮：纯打字机。 */}
      {liveRendering && (
        <div className="my-1 flex flex-col items-start">
          <span className="mb-0.5 select-none px-1 text-[10px] font-medium text-[var(--primary-400)]">{aiName}</span>
          {(() => {
            const gatedShown = sliceSegmentsByCount(liveSegments, petRevealCount)
            if (gatedShown.length > 0) {
              return (
                <div className="max-w-[90%] rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
                  <PetBubbleGroups groups={groupLiveSegments(gatedShown)} cursor={liveReadingActive ? liveCursorMode : undefined} onNarrToggle={pinScroll} />
                </div>
              )
            }
            // 门控下尚无可见内容：有语音轮 → 光标占位（首段语音未开始，等待文本 → 闪烁）；
            // 无语音轮 → trailing 打字机
            if (gated) {
              return (
                <span className="max-w-[90%] whitespace-pre-wrap break-words rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
                  {liveReadingActive && <span className="streaming-cursor streaming-cursor--waiting" />}
                </span>
              )
            }
            return (
              <span className="max-w-[90%] whitespace-pre-wrap break-words rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
                {/* 无语音模式：trailing 即流式文本（快照尾部），打字机揭示 */}
                <Typewriter
                  text={turnDoc?.trailing ?? ''}
                  speed={typeSpeed}
                  className="whitespace-pre-wrap break-words"
                  complete={!streaming}
                  onDone={() => {}}
                  noCursor={liveReadingActive}
                />
              </span>
            )
          })()}
        </div>
      )}
      </div>
    </div>
  )
}

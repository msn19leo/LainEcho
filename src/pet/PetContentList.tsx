/**
 * 宠物窗会话记录列表：
 * - 圆角气泡列表，左右对齐；用户/AI 气泡上方带小名牌，AI 用角色名+角色色表达情绪（不塞文字标签）。
 * - 正在生成的那条做"逐字打印"（对已到达的 streamingContent 做打字机 reveal）。
 * 内容随 useSessionStore（宠物窗镜像）与聊天窗同步。
 */
import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { typingSpeedToMs, useSettingsStore } from '../store/settingsStore'
import { usePetReadingStore } from './petReadingStore'
import { Typewriter } from '../components/Typewriter'
import { cn } from '../lib/utils'
import { useAutoScrollBottom } from '../lib/useAutoScrollBottom'

/** 当前使用中的角色名（AI 名牌用） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}

export function PetContentList() {
  /** 逐字速度：从全局设置读文字显示速度档（0-100）并换算为每字间隔毫秒；跟读与流式共用同一速度 */
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? 80)
  const typeSpeed = typingSpeedToMs(textSpeed)
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const revealMode = usePetReadingStore((s) => s.mode)
  const displayedText = usePetReadingStore((s) => s.displayedText)
  const readingActive = usePetReadingStore((s) => s.active)
  const playing = usePetReadingStore((s) => s.playing)
  /** 语音跟读模式：从第一刻起就用段级跟读气泡（空内容+跳动光标占位，等首块语音） */
  const following = revealMode === 'follow'
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
  /** 宠物窗内容框体积小，始终贴底跟随（不因用户上翻而停顿） */
  const followRef = useRef(true)

  // 内容高度增长（打字机逐字 reveal、流式、跟读追加段）时自动滚到底
  useAutoScrollBottom(scrollRef, contentRef, followRef, [messages, streaming, streamingContent, displayedText])

  // 即时模式（textSpeed=0 → typeSpeed<=0）下 Typewriter 全量直显、不会触发 onDone 清空 streamingContent，
  // 会导致"定型消息被持续隐藏、气泡不同步"。流式一结束即清空，让已落定的完整消息上屏。
  useEffect(() => {
    if (!streaming && streamingContent.length > 0 && typeSpeed <= 0) {
      useSessionStore.setState({ streamingContent: '' })
    }
  }, [streaming, streamingContent, typeSpeed])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-2 py-1 text-[13px] leading-[16px] text-text" onWheel={(e) => e.stopPropagation()}>
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef}>
      {messages.map((msg, i) => {
        // 隐藏末条定型 AI 的判定（须确有内容可显示，才由跟读/流式气泡接管，避免误藏上一条已落定回答）：
        //  - 跟读：仅当语音正在朗读（readingActive）时才隐藏；朗读结束（active 下降沿）即恢复定型消息，
        //    不依赖 displayedText——否则朗读结束只清 streamingContent 而 displayedText 残留，
        //    会把定型消息持续隐藏、跟读气泡又已让位 = "气泡消失"。
        //  - 流式（非跟读）：streamingContent 尚有内容（揭示未完）时隐藏。
        if (!streaming && ((following && readingActive) || (!following && streamingContent.length > 0)) && msg.role === 'assistant' && i === lastAssistantIndex) {
          console.log('[sync] pet 隐藏末条AI 下标=%d 原因(following=%s,readingActive=%s,dt=%d,sc=%d)', i, following, readingActive, displayedText.length, streamingContent.length)
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
            {/* 名牌：用户=你；AI=角色名（用角色色表达说话人/情绪） */}
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
                  ? 'bg-primary-gradient text-white'
                  : 'border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 text-text',
              )}
            >
              {msg.content.replace(/\n+/g, '\n')}
            </div>
          </div>
        )
      })}

      {/* 失败提示（与聊天窗统一）：末条是用户消息且不在生成中 = 这轮没有 AI 回复落盘；
          消息上的 error 字段携带具体原因，窗口重载后依然可见。下一条消息成功落定后自动消失。 */}
      {(() => {
        const lastMessage = messages[messages.length - 1]
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

      {/* 跟读气泡显示：跟读仅当语音正在朗读（readingActive）时出现（语音未到先空位+光标等待）；
          非跟读在 streamingContent 尚有内容时出现。均排除"朗读结束后的残留态"，避免空气泡 */}
      {(streaming || (!following && streamingContent.length > 0) || (following && readingActive)) && (
        <div className="my-1 flex flex-col items-start">
          <span className="mb-0.5 select-none px-1 text-[10px] font-medium text-[var(--primary-400)]">{aiName}</span>
          <span className="max-w-[90%] whitespace-pre-wrap break-words rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
            {/* 跟读显示 displayedText（随语音段落逐段追加，段随语音推进）；非跟读显示 streamingContent（LLM 流式全文）。
                跟读用语音驱动文本：杜绝"全文先打字完、语音后到"的不同步；打完不清（由朗读结束清），
                非跟读 complete+onDone 打完即清。 */}
            {following ? (
              <span className="whitespace-pre-wrap break-words">
                <Typewriter text={displayedText} speed={typeSpeed} noCursor />
                {(streaming || playing || readingActive) && <span className="streaming-cursor" />}
              </span>
            ) : (
              <Typewriter
                text={streamingContent}
                speed={typeSpeed}
                className="whitespace-pre-wrap break-words"
                complete={!streaming}
                onDone={() => useSessionStore.setState({ streamingContent: '' })}
              />
            )}
          </span>
        </div>
      )}
      </div>
    </div>
  )
}
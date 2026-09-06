/**
 * 宠物窗会话记录列表：
 * - 圆角气泡列表，左右对齐；用户/AI 气泡上方带小名牌，AI 用角色名+角色色表达情绪（不塞文字标签）。
 * - 正在生成的那条做"逐字打印"（对已到达的 streamingContent 做打字机 reveal）。
 * 内容随 useSessionStore（宠物窗镜像）与聊天窗同步。
 */
import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { usePetReadingStore } from './petReadingStore'
import { Typewriter } from '../components/Typewriter'
import { cn } from '../lib/utils'
import { useAutoScrollBottom } from '../lib/useAutoScrollBottom'

/** 无语音逐字速度：固定每字间隔（毫秒） */
const TYPEWRITER_SPEED = 25

/** 当前使用中的角色名（AI 名牌用） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}

export function PetContentList() {
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const revealMode = usePetReadingStore((s) => s.mode)
  const displayedText = usePetReadingStore((s) => s.displayedText)
  const readingActive = usePetReadingStore((s) => s.active)
  const playing = usePetReadingStore((s) => s.playing)
  /** 语音跟读模式：从第一刻起就用段级跟读气泡（空内容+跳动光标占位，等首块语音） */
  const following = revealMode === 'follow'
  /** 本轮语音跟读流程是否进行中：期间用语音气泡，并隐藏已落定的完整定型消息，避免先露出整段再消失 */
  const voiceFollowing = readingActive
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

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-2 py-1 text-[13px] leading-[16px] text-text" onWheel={(e) => e.stopPropagation()}>
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef}>
      {messages.map((msg, i) => {
        // 本轮语音跟读流程进行中（active）即隐藏最后一条已定型的 AI 消息，由跟读气泡接管。
        // active 仅在语音真正开始朗读（onSpeak）为真，故此处无需再要求 displayedText>0——
        // 否则 LLM 已跟读完成但语音音频尚未备好（displayedText 仍为空）时，会先露出整段再"消失"。
        if (!streaming && voiceFollowing && msg.role === 'assistant' && i === lastAssistantIndex)
          return null
        const isUser = msg.role === 'user'
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

      {(streaming || voiceFollowing) && (
        <div className="my-1 flex flex-col items-start">
          <span className="mb-0.5 select-none px-1 text-[10px] font-medium text-[var(--primary-400)]">{aiName}</span>
          <span className="max-w-[90%] whitespace-pre-wrap break-words rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
            {/* 跟读：确有朗读文本时随音频逐字 reveal；否则走即时或固定速度打字机，
                避免无语音轮因 mode 残留而显示空白 */}
            {following ? (
              <span className="whitespace-pre-wrap break-words">
                {/* 追加式打字机：整段回复随语音段追加写入 displayedText，打字机流式打出，无替换/无闪烁 */}
                <Typewriter text={displayedText} speed={TYPEWRITER_SPEED} />
                {(streaming || playing || readingActive) && <span className="streaming-cursor" />}
              </span>
            ) : (
              <Typewriter text={streamingContent} speed={TYPEWRITER_SPEED} />
            )}
          </span>
        </div>
      )}
      </div>
    </div>
  )
}
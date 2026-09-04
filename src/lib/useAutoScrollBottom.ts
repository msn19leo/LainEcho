/**
 * 内容高度增长时自动滚动到底部的 hook。
 *
 * 为什么用 ResizeObserver 而非"文本值变化"驱动：
 * 流式 / 语音跟读的 Typewriter 是**逐字 reveal**——目标 text 的值在一个时间片内不变，
 * 但 DOM 高度却每帧在增长。若只在 messages/streaming/readingText 等「值」变化时手动
 * setScrollTop，打字机逐字阶段滚动条会纹丝不动，直到下一段值变化才"跳"到底部。
 * ResizeObserver 观测内容实际高度，任何来源的高度增长（打字机、流式、追加段落、定型气泡）
 * 都会触发滚动，做到了真正持续贴底。
 *
 * 用法：给滚动容器的"内容区"套一层 div 并传入 contentRef，滚动容器本体传 scrollRef。
 *   const scrollRef = useRef<HTMLDivElement>(null)
 *   const contentRef = useRef<HTMLDivElement>(null)
 *   useAutoScrollBottom(scrollRef, contentRef, enabledRef, [messages, streaming])
 */
import { useLayoutEffect, type DependencyList, type RefObject } from 'react'

/**
 * 让滚动容器在内容高度增长时自动滚到底。
 * @param scrollRef  滚动容器（overflow 的那个元素）
 * @param contentRef 内容区外层（高度随内容伸缩，供 ResizeObserver 观测）
 * @param enabledRef 只有当该 ref 为 true 时才跟随（聊天窗用于"用户上翻历史时暂停"；
 *                   宠物窗可传一个恒 true 的 ref 表示始终贴底）
 * @param deps       内容出现/消失等会影响"何时建立观测"的信号（如 messages、streaming）
 */
export function useAutoScrollBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  enabledRef: RefObject<boolean>,
  deps: DependencyList = [],
): void {
  // 观测内容高度：任何高度增长都触发滚动（打字机逐字增长也能被持续捕获）
  useLayoutEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const scrollToBottom = () => {
      if (enabledRef.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(scrollToBottom)
    ro.observe(content)
    // 首次观测/建立时立即滚一次，覆盖"内容已存在但还没触发 resize"的情况
    scrollToBottom()
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, contentRef, ...deps])
}
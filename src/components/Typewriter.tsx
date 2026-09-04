/**
 * 逐字打印组件：对增量到达的流式文本做打字机 reveal，速度可配。
 *
 * - speed：每字间隔毫秒；speed<=0 时即时全显（不逐字、不显示游标）。
 * - 可见量用 ref 记忆、只增不减：文本继续增长时从上次位置继续 reveal，
 *   不做每 text 变化的 0 重置，避免流式期间反复重播/抖动。
 * - 仅当 speed 变化时重建定时器；text 增长不重建，保证打字节奏连续。
 */
import { useEffect, useRef, useState } from 'react'

export function Typewriter({ text, speed, className }: { text: string; speed: number; className?: string }) {
  const [visible, setVisible] = useState(0)
  const visibleRef = useRef(0)
  // 渲染时同步最新目标文本，供 interval 回调读取（interval 闭包不持有陈旧 text）
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    if (speed <= 0) return
    const s = setInterval(() => {
      // 只在还有未 reveal 文本时才推进一格；没有新文本时暂停递增，
      // 避免在等待新段落期间 visible 超前，导致新段落追加时整段瞬间显示。
      if (visibleRef.current < textRef.current.length) {
        visibleRef.current += 1
        setVisible(visibleRef.current)
      }
    }, speed)
    return () => clearInterval(s)
  }, [speed])

  // 即时模式：直接全量显示，不逐字不点游标
  if (speed <= 0) return <span className={className}>{text}</span>

  return (
    <span className={className}>
      {text.slice(0, Math.min(visible, text.length))}
      {visible < text.length && <span className="streaming-cursor" />}
    </span>
  )
}
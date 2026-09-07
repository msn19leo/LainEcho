/**
 * 通用设置面板：收纳不便归入其它模块的通用设置项。
 * - 文字显示速度（0-100 速度档）：控制聊天窗 / 桌宠气泡里文字的逐字显示快慢。
 * - 显示文字样本：用当前速度实时预览一段逐字打出的文字，带闪烁光标，打完后暂停 1 秒自动重播。
 */
import { useEffect, useRef, useState } from 'react'
import { Type } from 'lucide-react'
import { useSettingsStore, typingSpeedToMs } from '../../store/settingsStore'
import { Card, Slider } from '../../components/ui'

// 文字速度档位的默认值（与 settingsStore DEFAULT_SETTINGS.textSpeed 保持一致）
const DEFAULT_TEXT_SPEED = 80
/** 样本演示文案 */
const SAMPLE_TEXT = '嗨，我是 LainEcho · 来看看当前的文字显示速度'

/**
 * 文字样本预览：按指定速度档逐字打出 SAMPLE_TEXT，带闪烁光标，
 * 打完后暂停 1 秒自动重播；速度变化时立即重置重播。
 */
function TextSpeedSample({ speed }: { speed: number }) {
  const delay = typingSpeedToMs(speed)
  // 用 ref 记录已显示字数，interval 闭包不持有陈旧值；epoch 每轮重播 +1 触发 effect 重建
  const cur = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const [visible, setVisible] = useState(0)

  // 速度变化 → 重置样本文本并立即重播
  useEffect(() => {
    cur.current = 0
    setVisible(0)
    setEpoch((e) => e + 1)
  }, [speed])

  // 逐字播放；即时档（<=0）直接全显；打完后暂停 1 秒再重播
  useEffect(() => {
    if (delay <= 0) {
      setVisible(SAMPLE_TEXT.length)
      return
    }
    let alive = true
    const iv = setInterval(() => {
      cur.current += 1
      if (cur.current >= SAMPLE_TEXT.length) {
        setVisible(SAMPLE_TEXT.length)
        clearInterval(iv)
        setTimeout(() => {
          if (!alive) return
          cur.current = 0
          setVisible(0)
          setEpoch((e) => e + 1)
        }, 1000)
      } else {
        setVisible(cur.current)
      }
    }, delay)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [delay, epoch])

  return (
    <span className="whitespace-pre-wrap break-words">
      {SAMPLE_TEXT.slice(0, visible)}
      {visible < SAMPLE_TEXT.length && <span className="streaming-cursor" />}
    </span>
  )
}

export function GeneralPanel() {
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? DEFAULT_TEXT_SPEED)
  const save = useSettingsStore((s) => s.save)

  /** 保存文字显示速度（滑块实时生效） */
  const handleSpeedChange = (v: number) => {
    void save({ textSpeed: Math.round(v) })
  }

  return (
    <div className="space-y-4">
      {/* 面板顶部标题由 SettingsLayout 的 PanelView 统一渲染，此处只放内容 */}
      <Card className="p-5">
        <div className="space-y-4">
          {/* 文字显示速度 */}
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary-500/10 text-primary-400">
              <Type size={16} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text">文字显示速度</div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                控制聊天窗与桌宠气泡里文字的逐字显示快慢。数值越大越快，选择一个你看着舒服的节奏。
              </div>
            </div>
          </div>

          <Slider
            label="速度"
            value={textSpeed}
            min={1}
            max={100}
            step={1}
            defaultValue={DEFAULT_TEXT_SPEED}
            onChange={handleSpeedChange}
            format={(v) => `${v}`}
          />

          {/* 显示文字样本 */}
          <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-4 py-3">
            <div className="mb-1 text-xs text-text-muted">显示文字样本</div>
            <div className="min-h-[2.5em] text-sm leading-relaxed text-text">
              <TextSpeedSample speed={textSpeed} />
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
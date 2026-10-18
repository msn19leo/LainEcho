/**
 * 通用设置面板：收纳不便归入其它模块的通用设置项。
 * - 文字显示速度（0-100 速度档）：控制聊天窗 / 桌宠气泡里文字的逐字显示快慢。
 * - 显示文字样本：用当前速度实时预览一段逐字打出的文字，带闪烁光标，打完后暂停 1 秒自动重播。
 * - 回答仅含台词：普通聊天不生成也不显示（）内的心理/动作/环境描写（剧情模式与主动搭话旁白不受影响）。
 */
import { useEffect, useRef, useState } from 'react'
import { MessageSquareText, RefreshCw, Type } from 'lucide-react'
import { api } from '../../api'
import { useSettingsStore, typingSpeedToMs } from '../../store/settingsStore'
import { Button, Card, Slider, Switch, Textarea } from '../../components/ui'
import { toast } from '../../components/toast'

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
  const stripParenNarration = useSettingsStore((s) => s.settings.stripParenNarration)
  const timeAwarenessEnabled = useSettingsStore((s) => s.settings.timeAwarenessEnabled ?? true)
  const voiceTextFollowAudio = useSettingsStore((s) => s.settings.voiceTextFollowAudio ?? true)
  const enableSceneDigest = useSettingsStore((s) => s.settings.enableSceneDigest ?? true)
  const save = useSettingsStore((s) => s.save)

  // 情景摘要缓存编辑块：最近活跃会话的摘要文本（可查看/编辑/保存/刷新）
  const [sceneInfo, setSceneInfo] = useState<{ sessionId: string; title: string; digest: string } | null>(null)
  const [sceneText, setSceneText] = useState('')
  const [sceneSaving, setSceneSaving] = useState(false)

  /** 拉取最近活跃会话的情景摘要（挂载与手动刷新时调用；刷新会覆盖未保存的编辑） */
  const loadSceneDigest = async () => {
    try {
      const info = await api.session.getSceneDigest()
      setSceneInfo(info)
      setSceneText(info?.digest ?? '')
    } catch {
      // 拉取失败保持现状（面板仍可用，只是看不到缓存）
    }
  }

  /** 保存编辑后的情景摘要（空串=清空缓存，下一轮只剩系统活跃状态行，之后由辅助模型重新生成） */
  const handleSaveSceneDigest = async () => {
    if (!sceneInfo) return
    setSceneSaving(true)
    try {
      await api.session.setSceneDigest(sceneInfo.sessionId, sceneText)
      toast(sceneText.trim() ? '情景摘要已保存，下一轮生效' : '情景摘要已清空')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSceneSaving(false)
    }
  }

  useEffect(() => {
    void loadSceneDigest()
  }, [])

  /** 保存文字显示速度（滑块实时生效） */
  const handleSpeedChange = (v: number) => {
    void save({ textSpeed: Math.round(v) })
  }

  return (
    <div className="space-y-4">
      {/* 面板顶部标题由 SettingsLayout 的 PanelView 统一渲染，此处只放内容 */}
      <Card className="p-5">
        <div className="space-y-4">
          {/* 回答仅含台词 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">回答仅含台词</div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                开启后普通聊天不生成也不显示（）内的心理、动作、环境描写，AI 只输出真正说出口的台词；
                历史记录同步剥离。剧情模式与主动搭话的开场旁白不受影响。下一轮回复生效
              </div>
            </div>
            <Switch checked={stripParenNarration} onChange={(v) => void save({ stripParenNarration: v })} />
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">AI 时间感知</div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
              开启后 AI 获知当前真实时间与每条消息的发送时刻，可准确回答"现在几点""聊了多久"类问题；
              关闭则完全不发送时间信息。下一轮回复生效
            </div>
          </div>
          <Switch checked={timeAwarenessEnabled} onChange={(v) => void save({ timeAwarenessEnabled: v })} />
        </div>
      </Card>

      <Card className="p-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">情景摘要缓存</div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                每轮对话结束后由辅助模型在后台更新一份"此刻场景状态"，注入下一轮，
                减少旁白/台词与当前场景的错位；更新异步进行，不影响回复速度
              </div>
            </div>
            <Switch checked={enableSceneDigest} onChange={(v) => void save({ enableSceneDigest: v })} />
          </div>

          {/* 摘要查看/编辑块：显示最近活跃会话的缓存，可手动修正（下一轮注入编辑后的文本） */}
          <div
            className={`space-y-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-4 py-3 ${
              enableSceneDigest ? '' : 'opacity-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-xs text-text-muted">
                {sceneInfo ? `当前会话：${sceneInfo.title}` : '暂无会话'}
              </div>
              <Button
                variant="outline"
                className="shrink-0 px-2 py-1 text-xs"
                onClick={() => void loadSceneDigest()}
                title="重新拉取（会覆盖未保存的编辑）"
              >
                <RefreshCw size={13} strokeWidth={1.75} />
              </Button>
            </div>
            <Textarea
              value={sceneText}
              onChange={(e) => setSceneText(e.target.value)}
              disabled={!enableSceneDigest}
              rows={5}
              className="disabled:cursor-not-allowed disabled:opacity-60"
              placeholder="暂无缓存，首轮对话结束后自动生成"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                className="px-3 py-1 text-xs"
                onClick={() => void handleSaveSceneDigest()}
                disabled={!enableSceneDigest || !sceneInfo || sceneSaving || sceneText === (sceneInfo?.digest ?? '')}
              >
                {sceneSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      </Card>

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

          {/* 语音文本跟随语音逐字显示 */}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <div className="text-sm text-text">语音文本跟随语音逐字显示</div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                开启时台词文本按语音的实际播放进度逐字放行（与语音严格同步）；关闭时台词文本在语音开播时
                按「文字显示速度」整句打出（可能快于语音播完）。旁白文本始终按文字显示速度输出；剧情系统
                不受影响。下一轮语音生效
              </div>
            </div>
            <Switch checked={voiceTextFollowAudio} onChange={(v) => void save({ voiceTextFollowAudio: v })} />
          </div>
        </div>
      </Card>
    </div>
  )
}
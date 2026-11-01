/**
 * 通用设置面板：外观 / 对话行为 / 场景 三个分区。
 *
 * 布局走 Section + SettingRow（见 docs/settings-redesign.md §3）：
 * - 一个分区只画一个边框，行之间用分隔线，替代原先「每个开关一张 Card」。
 * - 外观主题并入本页（原在主页单独一张卡）。
 * - Genie-TTS 的截断判定参数已迁至「语音合成 › Genie-TTS › 截断与质量」。
 */
import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { useSettingsStore, typingSpeedToMs } from '../../store/settingsStore'
import { Button, SegmentedControl, Slider, Switch, Textarea } from '../../components/ui'
import { ThemeSwitcher } from '../../components/ThemeSwitcher'
import { Section, SettingRow } from '../components/PanelShell'
import { toast } from '../../components/toast'

// 文字速度档位的默认值（与 settingsStore DEFAULT_SETTINGS.textSpeed 保持一致）
const DEFAULT_TEXT_SPEED = 80
/** 桌宠窗口默认尺寸（与主进程 PET_DEFAULT_* 一致） */
const PET_W_DEFAULT = 300
const PET_H_DEFAULT = 480
/**
 * 尺寸范围。下限是硬性的（再小会挤按钮 / 裁角色）；
 * 上限只是封顶值，实际可用范围由当前屏幕工作区决定（见 petMaxW/petMaxH）。
 */
const PET_W_MIN = 240
const PET_H_MIN = 380
const PET_W_MAX_CAP = 900
const PET_H_MAX_CAP = 1000
/**
 * 预设：窗口只给"可用范围"，不放大角色（角色大小归「角色模型 → 缩放」）。
 * 三档按同一宽高比给不同留白，默认档 = 旧版固定尺寸。
 */
const PET_PRESETS = [
  { id: 'compact', label: '紧凑', width: 300, height: 480 },
  { id: 'normal', label: '标准', width: 360, height: 600 },
  { id: 'large', label: '宽大', width: 440, height: 760 },
] as const

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
  const petWindow = useSettingsStore((s) => s.settings.petWindow)

  /**
   * 上限跟着屏幕走：`window.screen.avail*` 给的就是 DIP，与窗口尺寸同单位，
   * 已扣掉任务栏。留 40px 余量，免得窗口贴死屏幕边缘后拖不动。
   */
  const petMaxW = Math.max(PET_W_MIN, Math.min(PET_W_MAX_CAP, (window.screen?.availWidth || PET_W_MAX_CAP) - 40))
  const petMaxH = Math.max(PET_H_MIN, Math.min(PET_H_MAX_CAP, (window.screen?.availHeight || PET_H_MAX_CAP) - 40))

  // 窗口尺寸：拖动滑块时只更新本地显示，停 150ms 才落盘（避免每一帧都触发 setBounds）
  const [petW, setPetW] = useState(petWindow?.width ?? PET_W_DEFAULT)
  const [petH, setPetH] = useState(petWindow?.height ?? PET_H_DEFAULT)
  const petSaveTimer = useRef<number | null>(null)
  // 外部变化（另一窗口改动 / 主进程夹取后回写）同步回本地，避免显示与实际不一致
  useEffect(() => {
    if (!petWindow) return
    setPetW(petWindow.width)
    setPetH(petWindow.height)
  }, [petWindow?.width, petWindow?.height])
  useEffect(() => () => {
    if (petSaveTimer.current) window.clearTimeout(petSaveTimer.current)
  }, [])

  /** 改窗口尺寸：本地即时反馈 + 防抖落盘（保存后主进程按底边中点调整实际窗口） */
  const applyPetSize = (w: number, h: number) => {
    const width = Math.min(petMaxW, Math.max(PET_W_MIN, Math.round(w)))
    const height = Math.min(petMaxH, Math.max(PET_H_MIN, Math.round(h)))
    setPetW(width)
    setPetH(height)
    if (petSaveTimer.current) window.clearTimeout(petSaveTimer.current)
    petSaveTimer.current = window.setTimeout(() => {
      petSaveTimer.current = null
      // 只提交尺寸：位置由主进程在拖动结束时记录，渲染端持有的 x/y 可能已过时
      void save({ petWindow: { width, height } })
    }, 150)
  }

  /** 当前尺寸命中的预设（都不命中 = 自定义） */
  const petPreset =
    PET_PRESETS.find((p) => p.width === petW && p.height === petH)?.id ?? 'custom'

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
    // 聊天窗切换/新建会话后刷新：编辑块跟随当前会话（未聊过的会话 = 空缓存）
    return api.pet.onCurrentSessionChanged(() => {
      void loadSceneDigest()
    })
  }, [])

  /** 保存文字显示速度（滑块实时生效） */
  const handleSpeedChange = (v: number) => {
    void save({ textSpeed: Math.round(v) })
  }

  return (
    <div>
      {/* ===== 外观 ===== */}
      <Section title="外观">
        <SettingRow title="外观主题" desc="跟随系统时按系统偏好自动切换">
          <ThemeSwitcher compact />
        </SettingRow>

        <SettingRow
          title="文字显示速度"
          desc="控制聊天窗与桌宠气泡里文字的逐字显示快慢，数值越大越快"
        >
          <Slider
            value={textSpeed}
            min={1}
            max={100}
            step={1}
            defaultValue={DEFAULT_TEXT_SPEED}
            onChange={handleSpeedChange}
            format={(v) => `${v}`}
          />
        </SettingRow>

        {/* 样本预览：不占独立卡片，作为速度行的补充内容接在同一容器内 */}
        <div className="px-4 py-2.5">
          <div className="mb-1 text-[11px] text-text-muted">显示样本</div>
          <div className="min-h-[1.5em] text-[12.5px] leading-relaxed text-text">
            <TextSpeedSample speed={textSpeed} />
          </div>
        </div>
      </Section>

      {/* ===== 桌宠窗口 ===== */}
      <Section title="桌宠窗口" hint={`${petW} × ${petH}`}>
        <SettingRow
          title="尺寸预设"
          desc="只改变窗口可用范围，不改变角色大小；想让角色变大请到「角色模型 → 缩放与位置」调整"
        >
          <SegmentedControl<string>
            value={petPreset}
            onChange={(v) => {
              const preset = PET_PRESETS.find((x) => x.id === v)
              if (preset) applyPetSize(preset.width, preset.height)
            }}
            options={PET_PRESETS.map((x) => ({ value: x.id as string, label: x.label }))}
          />
        </SettingRow>

        <SettingRow
          title="宽度"
          desc={
            <>
              影响左右留白与迷你气泡的宽度
              <br />
              上限 = min(屏幕可用宽度 − 40, 900) → 当前 {petMaxW}
            </>
          }
        >
          <Slider
            value={petW}
            min={PET_W_MIN}
            max={petMaxW}
            step={10}
            defaultValue={PET_W_DEFAULT}
            onChange={(v) => applyPetSize(v, petH)}
            format={(v) => `${v}`}
            editable
          />
        </SettingRow>

        <SettingRow
          title="高度"
          desc={
            <>
              影响上下留白；窗口比角色矮时会裁掉上下边缘
              <br />
              上限 = min(屏幕可用高度 − 40, 1000) → 当前 {petMaxH}
            </>
          }
        >
          <Slider
            value={petH}
            min={PET_H_MIN}
            max={petMaxH}
            step={10}
            defaultValue={PET_H_DEFAULT}
            onChange={(v) => applyPetSize(petW, v)}
            format={(v) => `${v}`}
            editable
          />
        </SettingRow>

      </Section>

      {/* ===== 对话行为 ===== */}
      <Section title="对话行为">
        <SettingRow
          title="回答仅含台词"
          desc="不生成也不显示（）内的心理、动作、环境描写，历史记录同步剥离；剧情模式与主动搭话旁白不受影响"
          onClick={() => void save({ stripParenNarration: !stripParenNarration })}
        >
          <Switch checked={stripParenNarration} onChange={(v) => void save({ stripParenNarration: v })} />
        </SettingRow>

        <SettingRow
          title="AI 时间感知"
          desc="让角色知道当前真实时间与每条消息的发送时刻，可准确回答「现在几点」「聊了多久」"
          onClick={() => void save({ timeAwarenessEnabled: !timeAwarenessEnabled })}
        >
          <Switch checked={timeAwarenessEnabled} onChange={(v) => void save({ timeAwarenessEnabled: v })} />
        </SettingRow>

        <SettingRow
          title="语音文本跟随语音"
          desc="台词按语音实际播放进度逐字放行；关闭则按文字速度整句打出，可能快于语音播完"
          onClick={() => void save({ voiceTextFollowAudio: !voiceTextFollowAudio })}
        >
          <Switch checked={voiceTextFollowAudio} onChange={(v) => void save({ voiceTextFollowAudio: v })} />
        </SettingRow>
      </Section>

      {/* ===== 场景 ===== */}
      <Section title="场景">
        <SettingRow
          title="情景摘要缓存"
          desc="每轮对话后由辅助模型在后台更新一份「此刻场景状态」注入下一轮，减少旁白/台词与场景错位"
          onClick={() => void save({ enableSceneDigest: !enableSceneDigest })}
        >
          <Switch checked={enableSceneDigest} onChange={(v) => void save({ enableSceneDigest: v })} />
        </SettingRow>

        {/* 编辑块仅在开启时展开：关闭后看不到缓存也无从编辑，平铺常驻会白占 180px */}
        {enableSceneDigest && (
          <div className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[11px] text-text-muted">
                {sceneInfo ? `当前会话：${sceneInfo.title}` : '暂无会话'}
              </div>
              <Button
                variant="outline"
                className="shrink-0 px-2 py-1 text-[11px]"
                onClick={() => void loadSceneDigest()}
                title="重新拉取（会覆盖未保存的编辑）"
              >
                <RefreshCw size={12} strokeWidth={1.75} />
              </Button>
            </div>
            <Textarea
              value={sceneText}
              onChange={(e) => setSceneText(e.target.value)}
              rows={4}
              placeholder="暂无缓存，首轮对话结束后自动生成"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                className="px-3 py-1 text-[11px]"
                onClick={() => void handleSaveSceneDigest()}
                disabled={!sceneInfo || sceneSaving || sceneText === (sceneInfo?.digest ?? '')}
              >
                {sceneSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

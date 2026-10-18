/**
 * 主动搭话面板：开关（主动搭话 / 屏幕感知级联）+ 频率与免打扰（每日上限 / 免打扰时段）+
 * 调度状态实时展示（兴趣值/今日次数/最近搭话时间）。
 *
 * - 屏幕感知开关级联于主动搭话：总开关关闭时禁用（并自动保存关闭态，避免残留开启）
 * - 视觉模型（屏幕感知/立绘打标用）在「AI API 配置」面板独立配置；未配置时屏幕感知自动降级为普通话题
 */
import { useEffect, useState } from 'react'
import { Eye, Radio, Sparkles } from 'lucide-react'
import { api } from '../../api'
import { Switch } from '../../components/ui'
import { useSettingsStore } from '../../store/settingsStore'
import type { ProactiveState } from '../../types'

export function ProactivePanel() {
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const saveSettings = useSettingsStore((s) => s.save)

  /** 调度状态（兴趣值/当日次数/最近搭话时间），订阅广播实时刷新 */
  const [state, setState] = useState<ProactiveState | null>(null)

  useEffect(() => {
    if (!settingsLoaded) void loadSettings()
    void api.proactive.getState().then(setState).catch(() => setState(null))
    // 订阅状态广播：每次成功搭话 / 用户消息重置后刷新
    const unsub = api.proactive.onState((s) => setState(s))
    return unsub
  }, [settingsLoaded, loadSettings])

  /** 切换主动搭话总开关：关闭时级联关闭屏幕感知（避免残留开启） */
  const handleToggleProactive = async (v: boolean) => {
    const patch = v
      ? { enableProactive: true }
      : { enableProactive: false, enableScreenSense: false }
    await saveSettings(patch)
  }

  return (
    <div className="space-y-3">
      {/* 主动搭话总开关 */}
      <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div>
          <div className="text-sm text-text">主动搭话</div>
          <div className="text-xs text-text-muted">
            桌宠在长时间无交互后由角色主动开口（宠物窗气泡 + 语音）；每次搭话走完整聊天管线，会消耗一次模型调用
          </div>
        </div>
        <Switch checked={settings.enableProactive} onChange={(v) => void handleToggleProactive(v)} />
      </div>

      {/* 屏幕感知（级联于主动搭话） */}
      <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div>
          <div className="flex items-center gap-1.5 text-sm text-text">
            <Eye size={14} strokeWidth={1.75} color="var(--accent-500)" />
            屏幕感知
          </div>
          <div className="text-xs text-text-muted">
            与主动搭话同时开启时：角色先"偷看"你的桌面（截图仅内存流转、不落盘），再以看到的内容搭话；
            视觉模型在「AI API 配置」中配置，感知失败或未配置时自动降级为普通话题
          </div>
        </div>
        <Switch
          checked={settings.enableScreenSense}
          onChange={(v) => void saveSettings({ enableScreenSense: v })}
          // 级联禁用：总开关关闭时不可单独开启屏幕感知
          disabled={!settings.enableProactive}
        />
      </div>

      {/* 话题旁白风格：LLM 随机生成 vs 固定模板 */}
      {settings.enableProactive && (
        <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
          <div>
            <div className="text-sm text-text">旁白由 AI 随机生成</div>
            <div className="text-xs text-text-muted">
              普通话题搭话前由模型按当前时间段即兴写一句旁白（每次搭话多一次小调用）；
              关闭则使用固定模板。屏幕感知旁白不受此开关影响
            </div>
          </div>
          <Switch
            checked={settings.proactiveLlmNarration}
            onChange={(v) => void saveSettings({ proactiveLlmNarration: v })}
            disabled={!settings.enableProactive}
          />
        </div>
      )}

      {/* 视觉模型配置已移至「AI API 配置」面板（屏幕感知/立绘打标共用） */}

      {/* 频率与免打扰 */}
      <div className="space-y-3 rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div className="text-sm text-text">频率与免打扰</div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="shrink-0">每日搭话上限</span>
          <input
            type="number"
            min={0}
            max={20}
            value={settings.maxProactivePerDay}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isNaN(v)) void saveSettings({ maxProactivePerDay: Math.min(20, Math.max(0, Math.floor(v))) })
            }}
            className="w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <span>（你回复一条消息后计数会重置、兴趣值清零）</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="shrink-0">兴趣值增长间隔</span>
          <input
            type="number"
            min={10}
            max={600}
            step={5}
            value={settings.proactiveInterestIntervalSec}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isNaN(v)) void saveSettings({ proactiveInterestIntervalSec: Math.min(600, Math.max(10, Math.floor(v))) })
            }}
            className="w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <span>秒（每 X 秒累积一轮兴趣值 +5~10，越小搭话越频繁；改完下一轮自动生效）</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="shrink-0">免打扰时段</span>
          <input
            type="time"
            value={settings.quietHours.start}
            onChange={(e) => void saveSettings({ quietHours: { ...settings.quietHours, start: e.target.value } })}
            className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <span>至</span>
          <input
            type="time"
            value={settings.quietHours.end}
            onChange={(e) => void saveSettings({ quietHours: { ...settings.quietHours, end: e.target.value } })}
            className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <span>（两端都填才生效，支持跨零点如 23:00-08:00；留空 = 不启用）</span>
        </div>
      </div>

      {/* 调度状态（实时） */}
      <div className="space-y-2 rounded-[var(--radius-md)] bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-1.5 text-sm text-text">
          <Radio size={14} strokeWidth={1.75} color="var(--primary-400)" />
          调度状态
        </div>
        {state ? (
          <div className="grid grid-cols-3 gap-2 text-xs text-text-2">
            <div>
              兴趣值：
              <span className="font-semibold text-text">{state.interest}</span>
              <span className="text-text-muted"> / 100（&gt;50 后按概率触发）</span>
            </div>
            <div>
              今日已搭话：
              <span className="font-semibold text-text">{state.timesToday}</span>
              {/* 上限直接读设置存储（保存即更新）；state.maxPerDay 是调度器 tick 时的快照，会滞后一轮 */}
              <span className="text-text-muted"> / {settings.maxProactivePerDay}</span>
            </div>
            <div>
              最近搭话：
              <span className="font-semibold text-text">
                {state.lastSpokeAt ? new Date(state.lastSpokeAt).toLocaleTimeString('zh-CN') : '尚未搭话'}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <Sparkles size={12} strokeWidth={1.75} />
            状态加载中…
          </div>
        )}
      </div>
    </div>
  )
}

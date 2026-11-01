/**
 * 主动搭话面板：开关与行为 / 频率与免打扰 / 调度状态。
 *
 * - 屏幕感知开关与视觉模型配置在「视觉感知」面板，且不级联于本开关
 *   （眼睛按钮让用户随时能要求角色看一眼，与"角色自己开口"无关）。
 * - 布局走 Section + SettingRow（见 docs/settings-redesign.md §3）。
 */
import { useEffect, useState } from 'react'
import { Radio, Sparkles } from 'lucide-react'
import { api } from '../../api'
import { Switch } from '../../components/ui'
import { useSettingsStore } from '../../store/settingsStore'
import { Section, SettingRow } from '../components/PanelShell'
import type { ProactiveState } from '../../types'

/** 数字输入框的统一样式（与 SettingRow 右侧控件列对齐） */
const numInput =
  'w-16 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-right text-xs tabular-nums text-text outline-none transition-colors focus:border-[var(--border-strong)] disabled:opacity-40'

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

  /**
   * 切换主动搭话总开关。
   * 不级联关闭屏幕感知：眼睛按钮（用户主动识屏）独立于主动搭话，
   * 关掉搭话不该连带关掉"我想让它看一眼"的能力。
   */
  const handleToggleProactive = async (v: boolean) => {
    await saveSettings({ enableProactive: v })
  }

  return (
    <div>
      {/* ===== 开关与行为 ===== */}
      <Section title="开关与行为">
        <SettingRow
          title="主动搭话"
          desc="桌宠在长时间无交互后由角色主动开口（宠物窗气泡 + 语音）；每次搭话走完整聊天管线，会消耗一次模型调用"
          onClick={() => void handleToggleProactive(!settings.enableProactive)}
        >
          <Switch checked={settings.enableProactive} onChange={(v) => void handleToggleProactive(v)} />
        </SettingRow>

        <SettingRow
          title="旁白由 AI 随机生成"
          desc="普通话题搭话前由模型按当前时间段即兴写一句旁白（每次多一次小调用）；关闭则使用固定模板。屏幕感知旁白不受影响"
          disabled={!settings.enableProactive}
          onClick={() => void saveSettings({ proactiveLlmNarration: !settings.proactiveLlmNarration })}
        >
          <Switch
            checked={settings.proactiveLlmNarration}
            onChange={(v) => void saveSettings({ proactiveLlmNarration: v })}
            disabled={!settings.enableProactive}
          />
        </SettingRow>

        <SettingRow
          title="屏幕搭话占比"
          desc="主动搭话时「先看一眼屏幕再开口」的概率，需先在「视觉感知」中开启屏幕感知"
          disabled={!settings.enableProactive || !settings.enableScreenSense}
        >
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              disabled={!settings.enableProactive || !settings.enableScreenSense}
              value={settings.proactiveScreenWeight}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) void saveSettings({ proactiveScreenWeight: Math.min(100, Math.max(0, Math.round(v))) })
              }}
              className={numInput}
            />
            <span className="text-[11px] text-text-muted">%</span>
          </div>
        </SettingRow>
      </Section>

      {/* ===== 频率与免打扰 ===== */}
      <Section title="频率与免打扰">
        <SettingRow title="每日搭话上限" desc="你回复一条消息后计数会重置、兴趣值清零">
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={20}
              value={settings.maxProactivePerDay}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) void saveSettings({ maxProactivePerDay: Math.min(20, Math.max(0, Math.floor(v))) })
              }}
              className={numInput}
            />
            <span className="text-[11px] text-text-muted">次</span>
          </div>
        </SettingRow>

        <SettingRow title="兴趣值增长间隔" desc="每 X 秒累积一轮兴趣值（+5~10），越小搭话越频繁；改完下一轮自动生效">
          <div className="flex items-center gap-1">
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
              className={numInput}
            />
            <span className="text-[11px] text-text-muted">秒</span>
          </div>
        </SettingRow>

        <SettingRow title="免打扰时段" desc="两端都填才生效，支持跨零点如 23:00 - 08:00；留空 = 不启用" stacked>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={settings.quietHours.start}
              onChange={(e) => void saveSettings({ quietHours: { ...settings.quietHours, start: e.target.value } })}
              className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
            />
            <span className="text-[11px] text-text-muted">至</span>
            <input
              type="time"
              value={settings.quietHours.end}
              onChange={(e) => void saveSettings({ quietHours: { ...settings.quietHours, end: e.target.value } })}
              className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text"
            />
          </div>
        </SettingRow>
      </Section>

      {/* ===== 调度状态（实时） ===== */}
      <Section title="调度状态" hint="实时">
        {state ? (
          <div className="grid grid-cols-3 gap-3 px-4 py-3">
            <div>
              <div className="text-[11px] text-text-muted">兴趣值</div>
              <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">
                {state.interest}
                <span className="ml-1 text-[11px] font-normal text-text-muted">/ 100</span>
              </div>
              <div className="mt-0.5 text-[10.5px] text-text-muted">大于 50 后按概率触发</div>
            </div>
            <div>
              <div className="text-[11px] text-text-muted">今日已搭话</div>
              <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">
                {state.timesToday}
                <span className="ml-1 text-[11px] font-normal text-text-muted">
                  / {settings.maxProactivePerDay}
                </span>
              </div>
              <div className="mt-0.5 text-[10.5px] text-text-muted">上限取左侧设置</div>
            </div>
            <div>
              <div className="text-[11px] text-text-muted">最近搭话</div>
              <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">
                {state.lastSpokeAt ? new Date(state.lastSpokeAt).toLocaleTimeString('zh-CN') : '—'}
              </div>
              <div className="mt-0.5 text-[10.5px] text-text-muted">
                {state.lastSpokeAt ? '今日内有效' : '尚未搭话'}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-4 py-4 text-[11px] text-text-muted">
            <Sparkles size={12} strokeWidth={1.75} />
            状态加载中…
          </div>
        )}
      </Section>
    </div>
  )
}

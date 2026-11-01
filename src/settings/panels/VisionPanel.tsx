/**
 * 视觉感知面板：读图方式 / 聊天图片 / 屏幕感知 / 前台活动。
 *
 * - 读图方式二选一（主模型直读 / 视觉模型辅助）：不做能力探测，由用户自行声明主模型是否支持图片；
 *   失败时聊天里给一句"当前选择模型不支持图片输入"，由用户回来改这里。
 * - 视觉档案与屏幕感知共用同一个独立档案（不回落主模型）。
 * - 布局走 Section + SettingRow（见 docs/settings-redesign.md §3）。
 */
import { Eye, ImageIcon, KeyRound } from 'lucide-react'
import { Switch } from '../../components/ui'
import { SelectMenu } from '../../components/DropdownMenu'
import { useSettingsStore } from '../../store/settingsStore'
import { Section, SettingRow } from '../components/PanelShell'
import type { EyeReadMode, VisionReadMode, VisionSettings } from '../../types'

const numInput =
  'w-16 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-right text-xs tabular-nums text-text outline-none transition-colors focus:border-[var(--border-strong)] disabled:opacity-40'

export function VisionPanel() {
  const settings = useSettingsStore((s) => s.settings)
  const saveSettings = useSettingsStore((s) => s.save)
  const vision = settings.vision

  /** 合并写入子字段（vision 是嵌套对象，必须整体提交，白名单按整对象校验） */
  const patchVision = (patch: Partial<VisionSettings>) => {
    void saveSettings({ vision: { ...vision, ...patch } })
  }

  const visionProfiles = settings.profiles
  const activeVision = visionProfiles.find((p) => p.id === settings.activeVisionProfileId) ?? null

  const modeCard = (mode: VisionReadMode, title: string, desc: string) => {
    const active = vision.readMode === mode
    return (
      <button
        type="button"
        onClick={() => patchVision({ readMode: mode })}
        className={
          active
            ? 'flex-1 rounded-[var(--radius-md)] border border-[var(--primary-400)] bg-[var(--primary-400)]/10 px-3 py-2.5 text-left transition-colors'
            : 'flex-1 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)]'
        }
      >
        <div className="flex items-center gap-1.5 text-[13px] text-text">
          <span
            className={
              active
                ? 'h-2 w-2 rounded-full bg-[var(--primary-400)]'
                : 'h-2 w-2 rounded-full border border-[var(--border-strong)]'
            }
          />
          {title}
        </div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{desc}</div>
      </button>
    )
  }

  /** 点眼睛识图方式的三选一卡片（与读图方式同款外观） */
  const eyeModeCard = (mode: EyeReadMode, title: string, desc: string) => {
    const active = (vision.eyeReadMode ?? 'ambient') === mode
    return (
      <button
        type="button"
        onClick={() => patchVision({ eyeReadMode: mode })}
        className={
          active
            ? 'flex-1 rounded-[var(--radius-md)] border border-[var(--primary-400)] bg-[var(--primary-400)]/10 px-3 py-2.5 text-left transition-colors'
            : 'flex-1 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)]'
        }
      >
        <div className="flex items-center gap-1.5 text-[13px] text-text">
          <span
            className={
              active
                ? 'h-2 w-2 rounded-full bg-[var(--primary-400)]'
                : 'h-2 w-2 rounded-full border border-[var(--border-strong)]'
            }
          />
          {title}
        </div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{desc}</div>
      </button>
    )
  }

  return (
    <div>
      {/* ===== 读图方式 ===== */}
      <Section title="读图方式">
        <SettingRow
          title="聊天图片的识别路径"
          desc="主模型直读保真度最高，但要求该模型本身支持图片输入"
          stacked
        >
          <div className="flex gap-2">
            {modeCard('direct', '主模型直读', '图片原样发给主模型。主模型不支持图片时，每轮都会提示发送失败')}
            {modeCard('describe', '视觉模型辅助', '先由视觉模型转述成文字，再交给主模型。不依赖主模型能力，信息有所压缩')}
          </div>
        </SettingRow>

        {/* 视觉档案是全局单一配置，只在「AI 模型接入」里改；这里只做只读回显，避免两处可改同一字段 */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-2.5 text-[11px] text-text-muted">
          <KeyRound size={12} strokeWidth={1.75} />
          <span className="shrink-0">当前视觉模型：</span>
          <span className="font-medium text-text">
            {activeVision
              ? `${activeVision.name || activeVision.model || activeVision.id}（${activeVision.model}）${
                  activeVision.hasKey === false ? ' · 未配置 Key' : ''
                }`
              : '未启用'}
          </span>
          <span>· 在「AI 模型接入 → 视觉模型」中修改</span>
        </div>

        {vision.readMode === 'describe' && (!activeVision || activeVision.hasKey === false) && (
          <div className="px-4 py-2.5">
            <div className="rounded-[var(--radius-sm)] bg-[var(--warning)]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--warning)]">
              当前选择「视觉模型辅助」但没有可用的视觉档案，发图会失败。请到「AI 模型接入 → 视觉模型」启用一个支持图片输入的档案，或改用「主模型直读」。
            </div>
          </div>
        )}
      </Section>

      {/* ===== 聊天图片 ===== */}
      <Section title="聊天图片">
        <SettingRow
          title="允许发送图片"
          desc="聊天窗口支持粘贴（Ctrl+V）与拖入图片，单条最多 4 张；关闭后两种入口均不可用"
          onClick={() => patchVision({ chatImagesEnabled: !vision.chatImagesEnabled })}
        >
          <Switch checked={vision.chatImagesEnabled} onChange={(v) => patchVision({ chatImagesEnabled: v })} />
        </SettingRow>

        <SettingRow
          title="图片记忆轮数"
          desc="0 = 只有发送当轮带原图；调大会让每轮请求都重传原图，明显增加 token 消耗"
        >
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={6}
              value={vision.captionRounds}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) patchVision({ captionRounds: Math.min(6, Math.max(0, Math.floor(v))) })
              }}
              className={numInput}
            />
            <span className="text-[11px] text-text-muted">轮</span>
          </div>
        </SettingRow>

        <SettingRow
          title="原图保留天数"
          desc="0 = 永久保留；到期只删磁盘原图，消息与文字不受影响，历史气泡里的图变成占位"
        >
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={365}
              value={vision.imageRetentionDays}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) patchVision({ imageRetentionDays: Math.min(365, Math.max(0, Math.floor(v))) })
              }}
              className={numInput}
            />
            <span className="text-[11px] text-text-muted">天</span>
          </div>
        </SettingRow>
      </Section>

      {/* ===== 屏幕感知 ===== */}
      <Section title="屏幕感知">
        <SettingRow
          title="允许角色看你的屏幕"
          desc="截图仅内存流转、不落盘。主动搭话前先看一眼，或点桌宠上的眼睛按钮让它立刻看；关闭后两者都不可用"
          onClick={() => void saveSettings({ enableScreenSense: !settings.enableScreenSense })}
        >
          <Switch
            checked={settings.enableScreenSense}
            onChange={(v) => void saveSettings({ enableScreenSense: v })}
          />
        </SettingRow>

        <SettingRow
          title="感知范围"
          desc={
            vision.readForeground
              ? '窗口截图字更清楚，且不含桌宠与聊天窗'
              : '未开启「读取前台窗口」，只能整屏'
          }
        >
          <SelectMenu
            // 展示"实际生效"的范围：开关关闭时后端强制整屏，这里不能继续显示"当前活动窗口"，
            // 否则用户以为在截窗口。改的是展示值，不覆盖用户已保存的偏好——
            // 重新开启「读取前台窗口」后会恢复成之前选的窗口/整屏。
            value={vision.readForeground ? vision.screenRange : 'screen'}
            onChange={(v) => patchVision({ screenRange: v === 'screen' ? 'screen' : 'window' })}
            options={[
              { value: 'window', label: '当前活动窗口' },
              { value: 'screen', label: '整屏' },
            ]}
            disabled={!vision.readForeground}
            className="w-40 shrink-0"
          />
        </SettingRow>

        <SettingRow
          title="截图时隐藏桌宠"
          desc="桌宠不会出现在屏幕感知的截图里（否则整屏感知会把立绘描述进去）；你自己截图或录屏也拍不到它"
          onClick={() => patchVision({ hideFromCapture: !vision.hideFromCapture })}
        >
          <Switch checked={vision.hideFromCapture} onChange={(v) => patchVision({ hideFromCapture: v })} />
        </SettingRow>

        {/* 点眼睛时的识图方式：只影响眼睛按钮，主动搭话固定速览 */}
        <SettingRow
          title="点眼睛时的识图方式"
          desc="点击桌宠上的眼睛按钮后，用什么方式「看」你的屏幕；主动搭话始终使用视觉模型的粗略描述"
          stacked
        >
          <div className="flex gap-2">
            {eyeModeCard('ambient', '速览', '视觉模型转述氛围，不读画面里的文字')}
            {eyeModeCard('detail', '详述', '视觉模型如实转述文字、报错与结构')}
            {eyeModeCard('native', '直读', '截图直发主模型，要求主模型支持图片输入；此模式不显示观察状态立绘')}
          </div>
        </SettingRow>
      </Section>

      {/* ===== 前台活动 ===== */}
      <Section title="前台活动" hint="只读窗口标题，不截图、不联网">
        <SettingRow
          title="读取前台窗口"
          desc="让角色知道你正在用什么软件，屏幕感知也据此选择要截的窗口；关闭后只能截整屏"
          onClick={() => patchVision({ readForeground: !vision.readForeground })}
        >
          <Switch checked={vision.readForeground} onChange={(v) => patchVision({ readForeground: v })} />
        </SettingRow>

        <SettingRow
          title="活动写入情境"
          desc="把「用户正在使用 xxx」写进【当前情景】告诉模型"
          disabled={!vision.readForeground}
          onClick={() => patchVision({ injectActivity: !vision.injectActivity })}
        >
          <Switch
            checked={vision.injectActivity}
            onChange={(v) => patchVision({ injectActivity: v })}
            disabled={!vision.readForeground}
          />
        </SettingRow>
      </Section>
    </div>
  )
}

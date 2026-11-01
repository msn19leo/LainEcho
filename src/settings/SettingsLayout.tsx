/**
 * 设置窗口布局：左侧分组导航 + 右侧吸顶标题条 + 面板内容。
 *
 * 设计（见 docs/settings-redesign.md）：
 * - 只有一套导航：左侧。删掉了「主页卡片列表」与面板内「返回」按钮。
 * - 通用设置置顶（无组标题），它同时是默认落地页。
 * - 内容区不使用毛玻璃/渐变/光晕；装饰只留在左栏与标题条。
 * - 切换面板时滚动位置归零，且不加退场动画（避免 150-200ms 空白期）。
 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AudioLines,
  BookOpen,
  Bot,
  BrainCircuit,
  Database,
  Eye,
  Info,
  KeyRound,
  MessagesSquare,
  PersonStanding,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { api } from '../api'
import { cn } from '../lib/utils'
import { fadeSlideUp } from '../lib/motion'
import { useSettingsStore } from '../store/settingsStore'
import { PanelShell, type PanelWidth } from './components/PanelShell'
import { ApiAside } from './components/asides/ApiAside'
import { ApiConfigPanel } from './panels/ApiConfigPanel'
import { CharacterCardPanel } from './panels/CharacterCardPanel'
import { CharacterModelPanel } from './panels/CharacterModelPanel'
import { DataPanel } from './panels/DataPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { ProactivePanel } from './panels/ProactivePanel'
import { VisionPanel } from './panels/VisionPanel'
import { StoryPanel } from './panels/StoryPanel'
import { LogPanel } from './panels/LogPanel'
import { VoicePanel } from './panels/VoicePanel'
import { AboutPanel } from './panels/AboutPanel'
import { GeneralPanel } from './panels/GeneralPanel'

export type ModuleId =
  | 'general'
  | 'character-card'
  | 'model'
  | 'api'
  | 'vision'
  | 'memory'
  | 'proactive'
  | 'story'
  | 'data'
  | 'voice'
  | 'logs'
  | 'about'

interface ModuleDef {
  id: ModuleId
  title: string
  icon: LucideIcon
  /** 所属分组；置顶项不填（渲染在分隔线之上，且不带组标题） */
  group?: string
  /** 内容宽度档：narrow 720 / medium 600+右栏 / wide 864 */
  width: PanelWidth
}

const MODULES: ModuleDef[] = [
  { id: 'general', title: '通用设置', icon: SlidersHorizontal, width: 'narrow' },
  { id: 'character-card', title: '角色卡', icon: Bot, group: '人格', width: 'wide' },
  { id: 'model', title: '角色模型', icon: PersonStanding, group: '人格', width: 'wide' },
  { id: 'api', title: 'AI 模型接入', icon: KeyRound, group: '能力', width: 'medium' },
  { id: 'vision', title: '视觉感知', icon: Eye, group: '能力', width: 'narrow' },
  { id: 'voice', title: '语音合成', icon: AudioLines, group: '能力', width: 'narrow' },
  { id: 'memory', title: '记忆体', icon: BrainCircuit, group: '能力', width: 'wide' },
  { id: 'proactive', title: '主动搭话', icon: MessagesSquare, group: '能力', width: 'narrow' },
  { id: 'story', title: '剧情系统', icon: BookOpen, group: '能力', width: 'wide' },
  { id: 'data', title: '数据管理', icon: Database, group: '数据与诊断', width: 'wide' },
  { id: 'logs', title: '运行日志', icon: ScrollText, group: '数据与诊断', width: 'wide' },
  { id: 'about', title: '关于与更新', icon: Info, group: '数据与诊断', width: 'narrow' },
]

/** 置顶项（无分组） */
const PINNED = MODULES.filter((m) => !m.group)

/** 分组导航：按 group 在 MODULES 中首次出现的顺序聚合 */
const GROUPS: Array<{ label: string; items: ModuleDef[] }> = (() => {
  const out: Array<{ label: string; items: ModuleDef[] }> = []
  for (const m of MODULES) {
    if (!m.group) continue
    const last = out[out.length - 1]
    if (last && last.label === m.group) last.items.push(m)
    else out.push({ label: m.group, items: [m] })
  }
  return out
})()

export function SettingsLayout() {
  const [view, setView] = useState<ModuleId>('general')
  /** 待确认记忆数量：有自动沉淀候选时在左侧「记忆体」导航项显示角标 */
  const [pendingCount, setPendingCount] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const mod = MODULES.find((m) => m.id === view) ?? MODULES[0]!

  // 打开设置窗口即加载设置（主题切换器需要反映已保存的主题）
  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  // 切换面板：滚动位置归零。main 是滚动容器，不重置会停在上一个面板的半空。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [view])

  // 待确认记忆数量：初始化查询 + 订阅变更（自动沉淀/确认/删除后刷新）
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const items = await api.memory.listPending()
        if (alive) setPendingCount(items.length)
      } catch {
        // 查询失败忽略
      }
    }
    void refresh()
    const unsub = api.memory.onChanged(() => void refresh())
    return () => {
      alive = false
      unsub()
    }
  }, [])

  return (
    <div className="app-window flex h-screen flex-col">
      <WindowTitlebar title="LainEcho · 设置" />
      <div className="flex min-h-0 flex-1">
        {/* 左侧导航：唯一的一套导航 */}
        <nav className="flex w-[168px] shrink-0 flex-col border-r border-border bg-surface-2/40 p-3">
          <Logo />
          <div className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
            {PINNED.map((m) => (
              <NavButton
                key={m.id}
                active={view === m.id}
                onClick={() => setView(m.id)}
                icon={m.icon}
                label={m.title}
              />
            ))}
            <div className="my-2 border-t border-border" />
            {GROUPS.map((g) => (
              <div key={g.label}>
                <div className="px-2 pb-1 pt-2 text-[11px] text-text-muted">{g.label}</div>
                {g.items.map((m) => (
                  <NavButton
                    key={m.id}
                    active={view === m.id}
                    onClick={() => setView(m.id)}
                    icon={m.icon}
                    label={m.title}
                    badge={m.id === 'memory' ? pendingCount : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        </nav>

        {/* 主内容区：吸顶标题条 + 面板 */}
        <main ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
          <PanelTitlebar title={mod.title} icon={mod.icon} />
          {/* 不加 AnimatePresence：退场动画会带来空白期，切换应当即时 */}
          <motion.div key={view} {...fadeSlideUp}>
            <PanelShell width={mod.width} aside={view === 'api' ? <ApiAside /> : undefined}>
              {view === 'general' && <GeneralPanel />}
              {view === 'character-card' && <CharacterCardPanel />}
              {view === 'model' && <CharacterModelPanel />}
              {view === 'api' && <ApiConfigPanel />}
              {view === 'voice' && <VoicePanel />}
              {view === 'memory' && <MemoryPanel />}
              {view === 'proactive' && <ProactivePanel />}
              {view === 'vision' && <VisionPanel />}
              {view === 'story' && <StoryPanel />}
              {view === 'data' && <DataPanel />}
              {view === 'logs' && <LogPanel />}
              {view === 'about' && <AboutPanel />}
            </PanelShell>
          </motion.div>
        </main>
      </div>
    </div>
  )
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1 py-0.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{ background: 'var(--gradient-brand)' }}
      >
        <Sparkles size={16} strokeWidth={2} style={{ color: 'var(--on-brand)' }} />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[12.5px] font-semibold text-text">LainEcho</div>
        <div className="text-[11px] text-text-muted">AI 桌宠</div>
      </div>
    </div>
  )
}

/** 吸顶标题条：44px，滚到第几屏都知道自己在哪 */
function PanelTitlebar({ title, icon: Icon }: { title: string; icon: LucideIcon }) {
  return (
    <div className="sticky top-0 z-10 flex h-11 items-center justify-between border-b border-border bg-surface/80 px-5 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={15} strokeWidth={2} className="shrink-0 text-primary-400" />
        <span className="truncate text-[14px] font-medium text-text">{title}</span>
      </div>
      <span className="shrink-0 text-[11px] text-text-muted">改动即时生效</span>
    </div>
  )
}

function NavButton({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: LucideIcon
  label: string
  /** 右侧角标数字（>0 时显示） */
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative mb-0.5 flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 text-left text-[12.5px] transition-colors',
        active ? 'text-text' : 'text-text-2 hover:bg-card-hover hover:text-text',
      )}
    >
      {active && <div className="absolute inset-0 rounded-[var(--radius-md)] bg-primary-500/10" />}
      {active && (
        <motion.div
          layoutId="nav-active-indicator"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full"
          style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 8px var(--primary-glow)' }}
        />
      )}
      <Icon
        size={15}
        strokeWidth={active ? 2 : 1.75}
        color={active ? 'var(--primary-400)' : 'currentColor'}
        className="relative shrink-0"
      />
      <span className={cn('relative truncate', active && 'font-medium')}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent-500)] px-1 text-[9px] font-bold leading-none text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

/**
 * 设置窗口布局：左侧导航（Logo + 渐变选中指示条）+ 主内容区。
 * - 主页：顶部「设置」大标题 + 外观主题切换，下方一级设置卡片列表
 * - 点击卡片 / 左侧导航进入二级面板；面板进出使用淡入上移动效
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Database,
  Drama,
  House,
  KeyRound,
  PersonStanding,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { IconTile } from '../components/IconTile'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { cn } from '../lib/utils'
import { fadeSlideUp, springSoft } from '../lib/motion'
import { useSettingsStore } from '../store/settingsStore'
import { ApiConfigPanel } from './panels/ApiConfigPanel'
import { CharacterCardPanel } from './panels/CharacterCardPanel'
import { CharacterModelPanel } from './panels/CharacterModelPanel'
import { DataPanel } from './panels/DataPanel'
import { MemoryPanel } from './panels/MemoryPanel'

export type ModuleId = 'character-card' | 'model' | 'api' | 'memory' | 'data'

interface ModuleDef {
  id: ModuleId
  title: string
  desc: string
  icon: LucideIcon
}

const MODULES: ModuleDef[] = [
  { id: 'character-card', title: '角色卡', desc: '编写 / 管理 AI 桌宠的身份与意识（自定义人设），支持多角色卡切换。', icon: Drama },
  { id: 'model', title: '角色模型', desc: 'Live2D 模型导入与管理。', icon: PersonStanding },
  { id: 'api', title: 'AI API 配置', desc: '配置兼容 OpenAI 格式的大模型接口（baseURL、Key、model 等）。', icon: KeyRound },
  { id: 'memory', title: '记忆体', desc: '用户手动维护的全局固定记忆条目。', icon: BrainCircuit },
  { id: 'data', title: 'Data', desc: '会话数据管理（搜索、筛选、导出、删除）。', icon: Database },
]

export function SettingsLayout() {
  const [view, setView] = useState<ModuleId | 'home'>('home')

  // 打开设置窗口即加载设置（主题切换器需要反映已保存的主题）
  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  return (
    <div className="app-window flex h-screen flex-col">
      <WindowTitlebar title="AI 桌宠 · 设置" />
      <div className="flex min-h-0 flex-1">
        {/* 左侧导航 */}
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-2/40 p-4">
          <Logo />
          <div className="mt-4 space-y-1">
            <NavButton active={view === 'home'} onClick={() => setView('home')} icon={House} label="主页" />
            <div className="my-2 border-t border-border" />
            {MODULES.map((m) => (
              <NavButton key={m.id} active={view === m.id} onClick={() => setView(m.id)} icon={m.icon} label={m.title} />
            ))}
          </div>
        </nav>

        {/* 主内容区 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {view === 'home' ? (
              <motion.div key="home" {...fadeSlideUp}>
                <HomeView onSelect={(id) => setView(id)} />
              </motion.div>
            ) : (
              <motion.div key={view} {...fadeSlideUp}>
                <PanelView id={view} onBack={() => setView('home')} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

function Logo() {
  return (
    <div className="glass flex items-center gap-3 rounded-[var(--radius-md)]">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--gradient-brand)' }}>
        <Sparkles size={18} strokeWidth={2} style={{ color: 'var(--on-brand)' }} />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[13px] font-semibold text-text">AI 桌宠</div>
        <div className="text-[11px] text-text-muted">LainEcho</div>
      </div>
    </div>
  )
}

function NavButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: LucideIcon
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative mb-1 flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left text-[13px] transition-colors',
        active ? 'text-text' : 'text-text-2 hover:bg-card-hover hover:text-text',
      )}
    >
      {active && <div className="absolute inset-0 rounded-[var(--radius-md)] bg-primary-500/10" />}
      {active && (
        <motion.div
          layoutId="nav-active-indicator"
          transition={springSoft}
          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
          style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 8px var(--primary-glow)' }}
        />
      )}
      <Icon size={16} strokeWidth={active ? 2 : 1.75} color={active ? 'var(--primary-400)' : 'currentColor'} className="relative" />
      <span className={cn('relative truncate', active && 'font-medium')}>{label}</span>
    </button>
  )
}

function HomeView({ onSelect }: { onSelect: (id: ModuleId) => void }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-[28px] font-bold tracking-tight text-text">设置</h1>
      <p className="mt-1 text-[13px] text-text-2">管理角色、模型、API 与数据</p>

      <div className="glass mt-6 flex items-center justify-between gap-4 rounded-[var(--radius-lg)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">外观主题</div>
          <div className="mt-0.5 text-xs text-text-muted">跟随系统将根据当前系统偏好自动切换</div>
        </div>
        <ThemeSwitcher />
      </div>

      <div className="mt-4 space-y-3">
        {MODULES.map((m) => (
          <SettingsCard key={m.id} title={m.title} desc={m.desc} icon={m.icon} onClick={() => onSelect(m.id)} />
        ))}
      </div>
    </div>
  )
}

function SettingsCard({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: LucideIcon
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <motion.button
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.98 }}
      transition={springSoft}
      onClick={onClick}
      className="glass flex w-full items-center gap-4 rounded-[var(--radius-lg)] p-6 text-left transition-all duration-200 hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-glow-primary)]"
    >
      <IconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-text">{title}</h3>
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-text-muted">{desc}</p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-text-tertiary" />
    </motion.button>
  )
}

function PanelView({ id, onBack }: { id: ModuleId; onBack: () => void }) {
  const mod = MODULES.find((m) => m.id === id)
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
        >
          <ChevronLeft size={14} /> 返回
        </button>
        {mod && <IconTile icon={mod.icon} size="sm" />}
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-text">{mod?.title}</h2>
          {mod?.desc && <p className="mt-0.5 text-xs text-text-muted">{mod.desc}</p>}
        </div>
      </div>
      {id === 'character-card' && <CharacterCardPanel />}
      {id === 'model' && <CharacterModelPanel />}
      {id === 'api' && <ApiConfigPanel />}
      {id === 'memory' && <MemoryPanel />}
      {id === 'data' && <DataPanel />}
    </div>
  )
}

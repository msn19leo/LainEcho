/**
 * 设置窗口布局：左侧固定导航 + 主内容区。
 * - 主页：顶部固定标题「设置」，下方纵向排列一级卡片列表
 * - 点击卡片 / 左侧导航进入对应二级面板，二级面板复用卡片列表展示模式
 */
import { useState } from 'react'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { cn } from '../lib/utils'
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
  icon: string
}

const MODULES: ModuleDef[] = [
  { id: 'character-card', title: '角色卡', desc: '编写 / 管理 AI 桌宠的身份与意识（自定义人设），支持多角色卡切换。', icon: '🎭' },
  { id: 'model', title: '角色模型', desc: 'Live2D 模型导入与管理。', icon: '🧸' },
  { id: 'api', title: 'AI API 配置', desc: '配置兼容 OpenAI 格式的大模型接口（baseURL、Key、model 等）。', icon: '🔌' },
  { id: 'memory', title: '记忆体', desc: '用户手动维护的全局固定记忆条目。', icon: '🧠' },
  { id: 'data', title: 'Data', desc: '会话数据管理（搜索、筛选、导出、删除）。', icon: '🗂️' },
]

export function SettingsLayout() {
  const [view, setView] = useState<ModuleId | 'home'>('home')

  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <WindowTitlebar title="AI 桌宠 · 设置" />
      <div className="flex min-h-0 flex-1">
        {/* 左侧导航 */}
        <nav className="w-44 shrink-0 border-r border-border bg-surface-2/50 p-2">
          <NavButton active={view === 'home'} onClick={() => setView('home')} icon="🏠" label="主页" />
          <div className="my-2 border-t border-border" />
          {MODULES.map((m) => (
            <NavButton
              key={m.id}
              active={view === m.id}
              onClick={() => setView(m.id)}
              icon={m.icon}
              label={m.title}
            />
          ))}
        </nav>

        {/* 主内容区 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {view === 'home' ? (
            <HomeView onSelect={(id) => setView(id)} />
          ) : (
            <PanelView id={view} onBack={() => setView('home')} />
          )}
        </main>
      </div>
    </div>
  )
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
        active ? 'bg-accent/15 font-medium text-text ring-1 ring-accent/40' : 'text-text-2 hover:bg-card-hover hover:text-text',
      )}
    >
      <span>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function HomeView({ onSelect }: { onSelect: (id: ModuleId) => void }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-5 text-xl font-semibold text-text">设置</h1>
      <div className="space-y-3">
        {MODULES.map((m) => (
          <button
            key={m.id}
            onClick={() => onSelect(m.id)}
            className="group flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-border-strong hover:bg-card-hover"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-xl ring-1 ring-border">
              {m.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-text">{m.title}</div>
              <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-muted">{m.desc}</div>
            </div>
            <div className="text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text">›</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function PanelView({ id, onBack }: { id: ModuleId; onBack: () => void }) {
  const mod = MODULES.find((m) => m.id === id)
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
        >
          ← 返回
        </button>
        <div>
          <h2 className="text-lg font-semibold text-text">{mod?.title}</h2>
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

/**
 * 「AI 模型接入」右栏：当前生效档案摘要 + 连通性测试。
 *
 * 为什么放右栏：原来测试按钮散在四个折叠分区里，改完配置要滚到对应分区才知道有没有生效。
 * 集中到右栏后，三档模型（主 / 辅助 / 视觉）的连接状态一屏可见。
 * 测试结果状态由本组件独占，不再与面板内重复（面板里已移除测试按钮）。
 */
import { useState } from 'react'
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react'
import { api } from '../../../api'
import { useSettingsStore } from '../../../store/settingsStore'
import { Button } from '../../../components/ui'

type Slot = 'main' | 'aux' | 'vision'

const SLOTS: Array<{ id: Slot; label: string; required: boolean }> = [
  { id: 'main', label: '主模型', required: true },
  { id: 'aux', label: '辅助模型', required: false },
  { id: 'vision', label: '视觉模型', required: false },
]

interface TestResult {
  ok: boolean
  text: string
}

export function ApiAside() {
  const settings = useSettingsStore((s) => s.settings)
  const [testing, setTesting] = useState<Slot | 'all' | null>(null)
  const [results, setResults] = useState<Partial<Record<Slot, TestResult>>>({})

  const profiles = settings.profiles

  const activeIdOf = (slot: Slot): string | null | undefined => {
    if (slot === 'main') return settings.activeMainProfileId
    if (slot === 'aux') return settings.activeAuxProfileId
    return settings.activeVisionProfileId
  }

  const activeOf = (slot: Slot) => profiles.find((p) => p.id === activeIdOf(slot)) ?? null

  const runTest = async (slot: Slot) => {
    setTesting(slot)
    try {
      const res = await api.ai.testConnection(slot)
      setResults((r) => ({
        ...r,
        [slot]: res.ok
          ? { ok: true, text: res.model ? `连接成功 · ${res.model}` : '连接成功' }
          : { ok: false, text: res.error ?? '连接失败' },
      }))
    } catch (err) {
      setResults((r) => ({
        ...r,
        [slot]: { ok: false, text: err instanceof Error ? err.message : '连接失败' },
      }))
    } finally {
      setTesting(null)
    }
  }

  const runAll = async () => {
    setTesting('all')
    // 串行：并发会让多条请求互相抢超时，且逐个出结果更好读
    for (const s of SLOTS) {
      if (!activeOf(s.id)) continue
      // eslint-disable-next-line no-await-in-loop
      await runTest(s.id)
    }
    setTesting(null)
  }

  const testable = SLOTS.filter((s) => activeOf(s.id))

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-medium tracking-wide text-text-muted">连接状态</span>
        <Button
          variant="outline"
          size="sm"
          className="px-2 py-0.5 text-[11px]"
          onClick={() => void runAll()}
          disabled={testing !== null || testable.length === 0}
        >
          {testing === 'all' ? '测试中…' : '全部测试'}
        </Button>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card/70">
        {SLOTS.map((slot) => {
          const active = activeOf(slot.id)
          const result = results[slot.id]
          const busy = testing === slot.id || testing === 'all'

          return (
            <div key={slot.id} className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-text">{slot.label}</span>
                <button
                  type="button"
                  title={active ? '测试连接' : '未配置档案'}
                  disabled={!active || testing !== null}
                  onClick={() => void runTest(slot.id)}
                  className="rounded-[var(--radius-sm)] p-1 text-text-muted transition-colors hover:bg-card-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {busy ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <PlugZap size={13} strokeWidth={1.75} />
                  )}
                </button>
              </div>

              <div className="mt-0.5 truncate text-[11px] text-text-muted" title={active?.name ?? undefined}>
                {active ? `${active.name || active.model || active.id}${active.hasKey === false ? ' · 缺 Key' : ''}` : '未启用'}
              </div>

              {result && (
                <div
                  className={`mt-1 flex items-start gap-1 text-[10.5px] leading-snug ${
                    result.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                  }`}
                >
                  {result.ok ? (
                    <CheckCircle2 size={11} className="mt-[1px] shrink-0" />
                  ) : (
                    <XCircle size={11} className="mt-[1px] shrink-0" />
                  )}
                  <span className="min-w-0 break-all">{result.text}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="px-1 text-[10.5px] leading-relaxed text-text-muted">
        测试会真实调用一次模型接口，可能产生少量费用。
      </p>
    </div>
  )
}

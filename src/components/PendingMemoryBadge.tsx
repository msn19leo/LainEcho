/**
 * 待确认记忆角标：有自动沉淀候选（confirmed=false）时显示数量角标。
 * 自维护数量：初始化查询 + 订阅 memory:changed 刷新；count=0 时不渲染。
 * 用于桌宠窗/聊天窗的「设置」按钮、设置窗「记忆体」导航项等入口提示。
 * 定位：依赖父容器为 relative，角标挂在右上角。
 */
import { useEffect, useState } from 'react'
import { api } from '../api'

export function PendingMemoryBadge() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const items = await api.memory.listPending()
        if (alive) setCount(items.length)
      } catch (err) {
        // 查询失败：打印原因便于定位（如 handler 未注册 / preload 缺失）
        console.warn('[PendingMemoryBadge] 查询待确认记忆失败：', err)
      }
    }
    void refresh()
    // 自动沉淀 / 其它窗口确认删除后刷新
    const unsub = api.memory.onChanged(() => void refresh())
    return () => {
      alive = false
      unsub()
    }
  }, [])

  if (count === 0) return null
  return (
    <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-500)] px-1 text-[9px] font-bold leading-none text-white shadow">
      {count > 99 ? '99+' : count}
    </span>
  )
}

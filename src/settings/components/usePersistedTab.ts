/**
 * 记住上次停留的 tab。
 *
 * 为什么需要：设置面板由 `SettingsLayout` 用 `key={view}` 挂载，切换模块会整棵卸载重建，
 * 组件内的 useState 会归零 —— 用户在「剧本」tab 编辑到一半、去看一眼语音设置再回来，
 * 会跳回第一个 tab。存 localStorage 后，跨面板切换与重启应用都能保留。
 *
 * 读到非法值（旧版本残留 / 手改）时回落 fallback，避免面板停在一个不存在的 tab 上。
 */
import { useState } from 'react'

export function usePersistedTab<T extends string>(key: string, tabs: readonly T[], fallback: T) {
  const [tab, setTabState] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      if (saved && (tabs as readonly string[]).includes(saved)) return saved as T
    } catch {
      // localStorage 不可用（隐私模式 / 存储受限）时忽略，用 fallback
    }
    return fallback
  })

  const setTab = (next: T) => {
    setTabState(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // 写入失败不影响本次切换
    }
  }

  return [tab, setTab] as const
}

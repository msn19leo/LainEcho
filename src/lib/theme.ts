/**
 * 主题应用：把 ThemeMode 解析成 <html data-theme="dark|light"> 并挂到文档根。
 * - 'system' 时监听 prefers-color-scheme，系统偏好变化自动跟随
 * - 每次启动先同步写死深色（防空白闪烁），再异步按设置校正
 */
import type { ThemeMode } from '../types'
import { api } from '../api'

const THEME_KEY = 'lainecho:theme-mode'

function resolve(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    // 忽略持久化失败（file:// 等受限环境）
  }
  document.documentElement.dataset.theme = resolve(mode)

  // 订阅系统偏好（仅 system 模式需要；切回固定模式时解除订阅）
  applyTheme.mql?.removeEventListener('change', applyTheme.onPrefChange)
  if (mode === 'system') {
    applyTheme.mql ??= window.matchMedia('(prefers-color-scheme: dark)')
    applyTheme.onPrefChange = () => applyTheme('system')
    applyTheme.mql.addEventListener('change', applyTheme.onPrefChange)
  }
}
applyTheme.mql = null as MediaQueryList | null
applyTheme.onPrefChange = () => {}

/** 立即以深色打底（防白屏闪烁），随后按设置应用真实主题 */
export function initTheme(): void {
  document.documentElement.dataset.theme = 'dark'
  // 延迟到事件循环末尾，异步按设置校正真实主题
  void Promise.resolve().then(async () => {
    try {
      const settings = await api.settings.get()
      applyTheme(settings.theme ?? 'dark')
    } catch {
      applyTheme('dark')
    }
  })
  // 其他窗口（如设置）修改主题后，本窗口重新聚焦时同步
  window.addEventListener('focus', () => {
    void api.settings
      .get()
      .then((settings) => applyTheme(settings.theme ?? 'dark'))
      .catch(() => {})
  })
}

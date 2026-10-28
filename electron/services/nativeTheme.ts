/**
 * 应用主题 → Electron 原生主题的同步。
 *
 * 必须同步：应用自身的配色走 `<html data-theme>`（见 src/lib/theme.ts），
 * 但 Windows 的**文本输入光标（I-beam）颜色**是由 Chromium 依据原生主题决定的。
 * 两者不一致时会出现真实故障：
 *   系统深色 + 应用浅色 → I-beam 画成白色 → 落在浅色输入框上完全看不见
 *   （2026-10-28 实测：剧本编辑器与设置页的输入框都受影响，切成深色主题后光标可见）
 *
 * ThemeMode 的取值（dark / light / system）与 nativeTheme.themeSource 完全一致，直接赋值即可。
 * 同步后滚动条、输入法候选框、右键菜单等原生控件的配色也会跟随应用主题。
 */
import { nativeTheme } from 'electron'
import type { ThemeMode } from '../../src/types'

export function syncNativeTheme(mode: ThemeMode | null | undefined): void {
  nativeTheme.themeSource = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : 'system'
}

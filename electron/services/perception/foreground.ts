/**
 * L0 前台窗口信号：只读窗口标题，不截图、不联网。
 *
 * 为什么需要它：
 * - 视觉模型看不懂"用户在用什么软件"这件事的元信息，窗口标题是最便宜的来源；
 * - 搭话时机评分要靠它判断"在写代码/看视频/打游戏"；
 * - L2（活动窗口截图）也要靠它先选出目标窗口——Electron 没有"获取前台窗口"的原生 API。
 *
 * 局限（必须知道的）：
 * - `desktopCapturer` 只给窗口列表和标题，**不标注哪一个是前台、也不给窗口坐标**；
 * - 这里的选取是**启发式**：Windows 下窗口源的顺序大致按 Z 序，取第一个非自家窗口；
 *   若将来发现顺序不可靠，再引入原生模块（active-win）。
 */
import { desktopCapturer, powerMonitor, type DesktopCapturerSource } from 'electron'

/** 快照缓存时长：窗口标题变化频繁，但没必要每轮都枚举（枚举本身要几十到几百毫秒） */
const CACHE_TTL_MS = 15_000
/** 自身窗口识别：本应用所有窗口标题都带应用名（见各 html 的 <title>） */
const OWN_TITLE_RE = /AI\s*桌宠|LainEcho/i
/** 系统外壳窗口：没有信息量，且常常抢占列表首位 */
const SHELL_TITLES = new Set(['Program Manager', 'Windows 输入体验', 'Microsoft Text Input Application', ''])

/** 一次枚举的结果快照 */
export interface ForegroundSnapshot {
  /** 最可能的前台窗口标题（已排除自家窗口与系统外壳窗口）；null = 无可选窗口 */
  title: string | null
  /** 快照时刻（毫秒时间戳） */
  at: number
}

let cached: ForegroundSnapshot | null = null

/** 标题是否可用作"用户正在使用的应用" */
function isUsableTitle(title: string): boolean {
  const t = title.trim()
  if (!t || SHELL_TITLES.has(t)) return false
  return !OWN_TITLE_RE.test(t)
}

/**
 * 枚举可选窗口并按启发式选出目标。
 * @param thumbnailSize 传 {width:0,height:0} 可跳过缩略图生成（只取标题时用，明显更快）
 * @param opts.debug 打印候选窗口顺序（排障用：Electron 不保证窗口顺序，只能实测）
 * @returns 目标窗口源；无可用窗口返回 null
 */
export async function resolveTargetWindow(
  thumbnailSize: { width: number; height: number },
  opts: { debug?: boolean } = {},
): Promise<DesktopCapturerSource | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize,
      fetchWindowIcons: false,
    })
    const target = sources.find((s) => isUsableTitle(s.name)) ?? null
    if (opts.debug) {
      // 排障日志：Electron 的窗口顺序不是文档保证的行为，只能靠实测确认"第一个非自家窗口"
      // 到底是不是用户正在用的那个。选中项带 id（含 HWND），便于后续对比。
      const preview = sources
        .slice(0, 8)
        .map((s, i) => `${i + 1}.${s.name?.trim() || '(无标题)'}${isUsableTitle(s.name) ? '' : '[排除]'}`)
        .join(' | ')
      console.log('[perception] 窗口候选（共 %d 个，前 8）：%s', sources.length, preview || '(空)')
      console.log(
        '[perception] 选中窗口：%s（id=%s）',
        target?.name?.trim() || '(无可用窗口)',
        target?.id ?? '-',
      )
    }
    return target
  } catch (err) {
    console.warn('[perception] 枚举窗口失败：', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 读取当前前台窗口标题（带 15s 缓存）。
 * @param force 跳过缓存（用户点眼睛时需要最新值）
 */
export async function getForegroundTitle(force = false): Promise<ForegroundSnapshot | null> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached
  const target = await resolveTargetWindow({ width: 0, height: 0 })
  cached = { title: target?.name?.trim() || null, at: Date.now() }
  return cached
}

/** 同步读取上次快照（供同步组装 scene section 时使用；未初始化返回 null） */
export function getCachedForegroundTitle(): string | null {
  return cached?.title ?? null
}

/** 系统空闲时长（秒）：powerMonitor 不可用时返回 0（视为"正在使用"） */
export function getSystemIdleSec(): number {
  try {
    return powerMonitor.getSystemIdleTime()
  } catch {
    return 0
  }
}

/**
 * 把窗口标题压缩成一句人话（供情境注入 / 时机评分使用）。
 * 只做轻量归一：去空白、超长截断。标题本身通常已含应用名（如 "xxx - Visual Studio Code"）。
 */
export function summarizeWindowTitle(title: string | null): string | null {
  const t = title?.trim()
  if (!t) return null
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

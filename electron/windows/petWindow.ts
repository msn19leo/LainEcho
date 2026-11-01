/**
 * 桌宠窗口：无边框、透明背景、始终置顶、可拖动缩放、不穿透鼠标。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { loadWindowPage } from './base'

/** 默认整窗尺寸（DIP）。默认高度 = 模型区 440 + 底部输入条 40 */
export const PET_DEFAULT_WIDTH = 300
export const PET_DEFAULT_HEIGHT = 480
/**
 * 尺寸下限（有实际依据：再窄底部输入框与右侧按钮会挤在一起，再矮会裁到角色）。
 * 上限只做"明显不合理值"的兜底 —— 真正的上限是显示器工作区，见 clampToWorkArea。
 */
const PET_MIN_WIDTH = 240
const PET_MAX_WIDTH = 900
const PET_MIN_HEIGHT = 380
const PET_MAX_HEIGHT = 1000
/** 未记录位置时的默认落点 */
const PET_DEFAULT_X = 200
const PET_DEFAULT_Y = 160

/**
 * 当前目标尺寸（来自设置，见 applyPetWindowSettings）。
 *
 * 尺寸**只决定画布大小**：角色适配基准是常量（PetStage 的 FIT_REF_*），
 * 所以放大窗口得到的是更多留白，而不是一个更大的角色 —— 角色大小归「角色模型」的缩放管。
 */
let targetWidth = PET_DEFAULT_WIDTH
let targetHeight = PET_DEFAULT_HEIGHT
/** 期望位置（null = 尚未记录，用默认落点） */
let targetPos: { x: number; y: number } | null = null

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 当前宠物窗口引用（保留字段） */
let petWin: BrowserWindow | null = null
/** 位置落盘防抖计时器 */
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null

/** 历史 IPC：内容框已改为浮层，不再调整窗口高度；保留导出避免破坏调用方 */
export function setPetPanelHeight(_panelH: number): void {}

/** 应用是否正在退出：退出时允许真正关闭窗口，否则关闭=隐藏（常驻托盘） */
let quitting = false
export function markPetWindowQuitting(): void {
  quitting = true
}

/** 夹进窗口所在显示器的可用区域（多显示器取重叠最多的那块） */
function clampToWorkArea(bounds: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

/**
 * 应用桌宠窗口配置（启动时与设置保存后各调一次）。
 *
 * 调整现有窗口时以**底边中点**为锚：窗口长高时角色脚底不动、只是上方多出空间，
 * 比默认的"左上角不动"自然得多。
 */
export function applyPetWindowSettings(cfg: {
  width: number
  height: number
  /** 缺省 = 不改位置（改尺寸时不要动用户已经拖好的落点） */
  x?: number | null
  y?: number | null
}): void {
  targetWidth = clampInt(cfg.width, PET_MIN_WIDTH, PET_MAX_WIDTH, PET_DEFAULT_WIDTH)
  targetHeight = clampInt(cfg.height, PET_MIN_HEIGHT, PET_MAX_HEIGHT, PET_DEFAULT_HEIGHT)
  // 只改尺寸时不动 targetPos：渲染端手里的 x/y 可能是旧值，写进来会把刚拖好的落点顶掉。
  // 显式传 null（而非缺省）才视为"清空位置，回到默认落点"。
  if (cfg.x !== undefined || cfg.y !== undefined) {
    targetPos =
      typeof cfg.x === 'number' && typeof cfg.y === 'number' && Number.isFinite(cfg.x) && Number.isFinite(cfg.y)
        ? { x: Math.round(cfg.x), y: Math.round(cfg.y) }
        : null
  }

  const win = petWin
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  if (b.width === targetWidth && b.height === targetHeight) return
  win.setBounds(
    clampToWorkArea({
      x: Math.round(b.x + (b.width - targetWidth) / 2),
      y: Math.round(b.y + (b.height - targetHeight)),
      width: targetWidth,
      height: targetHeight,
    }),
  )
  reassertTopmost(win)
}

/**
 * 位置落盘：拖动结束后写一次 settings.petWindow.x/y。
 * 只写文件、**不广播** settings:changed —— 否则每拖动一次，设置窗就要重读一遍全部设置。
 */
function persistBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    if (win.isDestroyed()) return
    void import('../services/repository')
      .then(async ({ getSettings, saveSettings }) => {
        const cur = await getSettings()
        if (cur.petWindow.x === b.x && cur.petWindow.y === b.y) return
        await saveSettings({ petWindow: { ...cur.petWindow, x: b.x, y: b.y } })
      })
      .catch((err) => console.warn('[petwin] 保存窗口位置失败:', err instanceof Error ? err.message : err))
  }, 400)
}

/** 补置顶（幂等）：窗口存在且未销毁时重新写一次 HWND_TOPMOST，不抢焦点 */
export function reassertTopmost(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(true)
}

export function createPetWindow(): BrowserWindow {
  const bounds = clampToWorkArea({
    x: targetPos?.x ?? PET_DEFAULT_X,
    y: targetPos?.y ?? PET_DEFAULT_Y,
    width: targetWidth,
    height: targetHeight,
  })
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 不可缩放：拖动透明无边框窗口在 Windows 上若可缩放，会被误触边缘缩放手柄
    // 或出现窗口随拖动拉伸的渲染问题。缩放统一走 Live2D 模型 scale（滚轮），窗口尺寸固定。
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setMenuBarVisibility(false)

  // ---- 置顶守卫 ----
  // 实测（2026-10-27，四次全中）：桌宠被点击激活的瞬间系统会把置顶属性剥掉，且不会自愈
  // （之后就被浏览器等窗口盖住、点不到）。两层守卫：
  //  ① focus：激活时若已丢失立刻补回（实测 focus 事件到达时已为 false）；
  //  ② 1s 心跳：只在"确实丢了"时补一次，正常只读不写——盲轮询会跟用户其它置顶窗口抢层级。
  const logRestored = (source: string) => console.log('[petwin] 置顶丢失已恢复 source=%s', source)
  const sampleTopmost = () => {
    if (win.isDestroyed() || !win.isVisible() || win.isAlwaysOnTop()) return
    reassertTopmost(win)
    logRestored('watchdog')
  }
  const heartTimer = setInterval(sampleTopmost, 1000)

  win.on('focus', () => {
    if (!win.isDestroyed() && !win.isAlwaysOnTop()) {
      reassertTopmost(win)
      logRestored('focus')
    }
    // 兜"清除发生在 focus 事件之后"的时序（个别驱动/时序下可能如此）
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isAlwaysOnTop()) {
        reassertTopmost(win)
        logRestored('focus+150ms')
      }
    }, 150)
  })

  // 保险：Windows 上透明无边框窗口在拖动时尺寸可能被 DWM 漂移（即使 resizable:false），
  // 一旦检测到尺寸偏离**当前目标**立即钉回。目标来自设置，所以调整尺寸不会和守卫打架。
  win.on('resize', () => {
    if (win.isDestroyed()) return
    const [w, h] = win.getSize()
    if (w !== targetWidth || h !== targetHeight) {
      win.setSize(targetWidth, targetHeight)
      // 这次尺寸回正是拖动过程中唯一由我们发起的第二次窗口写入：它会把窗口插回普通层，
      // 置顶属性随之被清掉（表现为桌宠被其它窗口盖住、且点不到、无法自愈）。写完立刻补回置顶。
      reassertTopmost(win)
    }
  })

  // 兜底：原生拖动（app-region: drag）由系统移动窗口，松手时可能重排 z-order。
  // 拖动静止 200ms 后重新写一次置顶，保证松手后回到置顶带最前（不抢焦点）。
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      reassertTopmost(win)
      // 拖动/程序化调整结束后记录位置（防抖在 persistBounds 内部）
      persistBounds(win)
    }, 200)
  })

  // 透明窗口首次绘制完成后再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show()
  })

  // 关闭时隐藏而非销毁（常驻托盘），真正的退出走 tray -> quit
  win.on('close', (e) => {
    if (!quitting && !win.isDestroyed()) {
      e.preventDefault()
      win.hide()
    }
  })

  // ---- 全局鼠标跟踪 ----
  // 透明窗口 + -webkit-app-region: drag 导致 window.mousemove 无法正常触发，
  // 且桌宠窗口仅 300x440，需要跟踪屏幕任意位置的鼠标（参考 airi 桌面端用 OS API）。
  // 通过 screen.getCursorScreenPoint() 轮询全局鼠标坐标，转换为窗口相对坐标后发送给渲染进程。
  let cursorTimer: ReturnType<typeof setInterval> | null = null
  const startCursorTracking = () => {
    if (cursorTimer) return
    cursorTimer = setInterval(() => {
      if (win.isDestroyed() || !win.isVisible()) return
      const pos = screen.getCursorScreenPoint()
      const [winX, winY] = win.getPosition()
      win.webContents.send('cursor:move', {
        x: pos.x - (winX ?? 0),
        y: pos.y - (winY ?? 0),
      })
    }, 33) // ~30fps，足够流畅的眼球跟踪
  }
  const stopCursorTracking = () => {
    if (cursorTimer) {
      clearInterval(cursorTimer)
      cursorTimer = null
    }
  }
  win.on('show', startCursorTracking)
  win.on('hide', stopCursorTracking)
  win.on('closed', () => {
    stopCursorTracking()
    if (moveTimer) {
      clearTimeout(moveTimer)
      moveTimer = null
    }
    clearInterval(heartTimer)
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer)
      boundsSaveTimer = null
    }
    if (petWin === win) petWin = null
  })

  petWin = win
  void loadWindowPage(win, 'pet.html')
  return win
}

/** 窗口默认尺寸（历史导出：调用方若需要"当前尺寸"请读 settings.petWindow） */
export const PET_WINDOW_SIZE = { width: PET_DEFAULT_WIDTH, height: PET_DEFAULT_HEIGHT }

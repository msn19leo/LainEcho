/**
 * 渲染端日志转发：把各窗口的 console 输出与未捕获异常经 IPC 转发到主进程 logger。
 *
 * 设计：
 *  - setupLogForward(source) 在每个窗口入口（main.tsx）调用一次，重复调用幂等；
 *  - 劫持 console.log/info/warn/error/debug：保留原生控制台行为（DevTools 照常可见），
 *    同时以完整格式化文本转发主进程（logs:forward → logger 落盘 + 缓冲 + 实时 tail）；
 *  - window.onerror / unhandledrejection 一并捕获（渲染端崩溃在打包版的唯一现场）；
 *  - 转发失败静默（主进程未就绪/通道异常不影响页面运行）。
 *
 * 多参数格式化：字符串原样、Error 取 stack、其余 JSON 序列化（失败回退 String），
 * 不做 %s/%d 占位符展开（渲染端极少使用，遇到时占位符原样保留不影响可读性）。
 */

/** 是否已安装（每窗口只装一次） */
let installed = false

/** 多参数 → 单条文本：字符串原样、Error 取堆栈、其余 JSON 序列化 */
function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  try {
    const json = JSON.stringify(arg)
    return json ?? String(arg)
  } catch {
    return String(arg)
  }
}

/**
 * 安装日志转发。
 * @param source 窗口来源标签（chat / pet / settings / story / editor）
 */
export function setupLogForward(source: 'chat' | 'pet' | 'settings' | 'story' | 'editor'): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const send = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
    try {
      window.api.logs.forward(source, level, args.map(stringify).join(' '))
    } catch {
      // 主进程通道异常时静默，不影响页面
    }
  }

  // 劫持 console（保留原生输出：DevTools / dev 终端照常可见）
  const origLog = console.log.bind(console)
  const origInfo = console.info.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const origDebug = console.debug.bind(console)
  console.log = (...args: unknown[]) => {
    origLog(...args)
    send('info', args)
  }
  console.info = (...args: unknown[]) => {
    origInfo(...args)
    send('info', args)
  }
  console.debug = (...args: unknown[]) => {
    origDebug(...args)
    send('info', args)
  }
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    send('warn', args)
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    send('error', args)
  }

  // 未捕获异常 / Promise 拒绝
  window.addEventListener('error', (e) => {
    send('error', ['[window.onerror]', e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '', e.error instanceof Error ? e.error.stack ?? e.error.message : ''].filter(Boolean))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    send('error', ['[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : String(reason)])
  })
}

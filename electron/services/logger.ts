/**
 * 运行日志模块（主进程）：统一收集主进程与各渲染窗口的日志。
 *
 * 设计要点：
 *  - console 劫持：主进程 console.log/info/warn/error/debug 劫持后"原样输出到控制台 + 捕获落盘"，
 *    存量散落的 console.log 零改动即被覆盖，业务代码无需迁移；
 *  - 落盘：userData/logs/latest.log 固定名（打包版 %APPDATA%/LainEcho/logs/），明文文本行，
 *    每次启动把旧 latest.log 重命名为 app-<时间戳>.log 备份，latest 永远是当前会话日志；
 *  - 轮转：单文件超 MAX_BYTES 重命名滚出；启动时清理超 RETENTION_DAYS 的备份并限制备份份数；
 *  - 内存环形缓冲：最近 BUFFER_LIMIT 条，供设置页「运行日志」面板秒开（不必先读文件）；
 *  - 实时 tail：每条新日志经 WebContents.send 广播给全部窗口（日志频率低，开销可忽略），
 *    面板打开时订阅即实现实时滚动；
 *  - 崩溃钩子：uncaughtException / unhandledRejection 捕获后照常落盘（打包版唯一可查的崩溃现场）；
 *  - 防递归：本模块内部直接写盘，绝不经过被劫持的 console。
 *
 * 渲染端日志经 preload 暴露的 api.logs.forward（logs:forward 通道）进入本模块，带窗口来源标签。
 */
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { format } from 'node:util'
import { getRootDir } from './storage'
import type { LogEntry, LogEntrySource } from '../../src/types'

export type { LogEntry }

/** 日志目录：跟随数据根目录（自定义数据目录时日志一并落在该目录下，默认仍是 %APPDATA%/LainEcho/logs） */
export const LOG_DIR = () => path.join(getRootDir(), 'logs')
/** 当前会话日志文件（固定名，UI 与人工查看入口） */
const LATEST_NAME = 'latest.log'
/** 单文件上限：超过即滚出为备份 */
const MAX_BYTES = 5 * 1024 * 1024
/** 备份份数上限（超出删最旧，防高频重启堆积） */
const MAX_BACKUPS = 10
/** 备份保留天数（启动清理） */
const RETENTION_DAYS = 14
/** 内存环形缓冲上限 */
const BUFFER_LIMIT = 500

/** 环形缓冲（尾插，超限移除最旧） */
const buffer: LogEntry[] = []

/** 级别 → 文件行标签 */
const LEVEL_TAG: Record<LogEntry['level'], string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' }

/** 文件行格式化：[2026-10-05 14:23:45.678] [INFO] [chat] 消息 */
function formatLine(entry: LogEntry): string {
  return `[${fmtTime(entry.ts)}] [${LEVEL_TAG[entry.level]}] [${entry.source}] ${entry.msg}`
}

/** 本地时间戳格式化 */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** 备份文件名时间戳：app-20261005-142345.log */
function fmtBackupStamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 解析文件行为 LogEntry（解析失败返回 null，供面板读历史文件用） */
export function parseLogLine(line: string): LogEntry | null {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(INFO|WARN|ERROR)\] \[([^\]]+)\] ?(.*)$/)
  if (!m) return null
  const ts = new Date(m[1]!.replace(' ', 'T')).getTime()
  const level = m[2] === 'ERROR' ? 'error' : m[2] === 'WARN' ? 'warn' : 'info'
  return { ts: Number.isFinite(ts) ? ts : 0, level, source: m[3] as LogEntrySource, msg: m[4] ?? '' }
}

/**
 * 写入一条日志：落盘（含轮转）+ 内存缓冲 + 广播给全部窗口（实时 tail）。
 * 全程 try/catch 静默——日志系统自身故障绝不能影响应用运行。
 */
function writeEntry(entry: LogEntry): void {
  // 1) 内存缓冲（环形）
  buffer.push(entry)
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
  // 2) 落盘 + 轮转
  try {
    const dir = LOG_DIR()
    fs.mkdirSync(dir, { recursive: true })
    const latest = path.join(dir, LATEST_NAME)
    const line = formatLine(entry) + '\n'
    fs.appendFileSync(latest, line)
    // 轮转：超限把 latest 滚出为备份
    if (fs.statSync(latest).size > MAX_BYTES) {
      fs.renameSync(latest, path.join(dir, `app-${fmtBackupStamp(Date.now())}.log`))
    }
  } catch {
    // 磁盘满/文件被占用等：静默放弃本条落盘（缓冲与广播仍可用）
  }
  // 3) 广播实时 tail（面板未打开时各窗口不订阅，仅空投）
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('logs:appended', entry)
    }
  } catch {
    // 广播失败忽略
  }
}

/** 渲染端日志入口（logs:forward 通道调用） */
export function forwardLog(source: LogEntrySource, level: LogEntry['level'], msg: string): void {
  writeEntry({ ts: Date.now(), level, source, msg })
}

/** console 多参数格式化：与 util.format 等价（Error 打印堆栈） */
function fmtArgs(args: unknown[]): string {
  return args.length === 0 ? '' : format(...args)
}

/**
 * 初始化日志系统：main.ts 尽早调用（app ready 前）。
 *  - 启动清理 + 归档旧 latest.log
 *  - 劫持主进程 console（保留原控制台行为）
 *  - 安装崩溃钩子
 */
export function initLogger(): void {
  try {
    const dir = LOG_DIR()
    fs.mkdirSync(dir, { recursive: true })
    const latest = path.join(dir, LATEST_NAME)
    // 归档上次会话日志：latest → app-<mtime 时间戳>.log（重名冲突追加序号）
    if (fs.existsSync(latest)) {
      let stamp = fmtBackupStamp(fs.statSync(latest).mtimeMs)
      let dest = path.join(dir, `app-${stamp}.log`)
      for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `app-${stamp}-${i}.log`)
      fs.renameSync(latest, dest)
    }
    // 启动清理：删除超保留期备份；备份份数超上限时删最旧
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000
    const backups = fs
      .readdirSync(dir)
      .filter((f) => /^app-\d{8}-\d{6}.*\.log$/.test(f))
      .sort()
    for (const f of backups) {
      try {
        if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, f))
      } catch {
        // 单个文件清理失败忽略
      }
    }
    const kept = backups.filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).mtimeMs >= cutoff
      } catch {
        return true
      }
    })
    for (const f of kept.slice(0, Math.max(0, kept.length - MAX_BACKUPS))) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        // 忽略
      }
    }
  } catch {
    // 日志目录初始化失败（只读盘等）：放弃落盘，缓冲与广播仍工作
  }

  // 劫持主进程 console：原行为保留 + 捕获
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }
  const capture = (level: LogEntry['level'], args: unknown[]) => {
    writeEntry({ ts: Date.now(), level, source: 'main', msg: fmtArgs(args) })
  }
  console.log = (...args: unknown[]) => {
    orig.log(...args)
    capture('info', args)
  }
  console.info = (...args: unknown[]) => {
    orig.info(...args)
    capture('info', args)
  }
  console.debug = (...args: unknown[]) => {
    orig.debug(...args)
    capture('info', args)
  }
  console.warn = (...args: unknown[]) => {
    orig.warn(...args)
    capture('warn', args)
  }
  console.error = (...args: unknown[]) => {
    orig.error(...args)
    capture('error', args)
  }

  // 崩溃钩子：打包版唯一可查的未捕获异常现场
  process.on('uncaughtException', (err) => {
    capture('error', ['[uncaughtException]', err instanceof Error ? err.stack ?? err.message : String(err)])
  })
  process.on('unhandledRejection', (reason) => {
    capture('error', ['[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : String(reason)])
  })

  // 启动标记（便于按会话定位日志段落）
  capture('info', [`===== LainEcho ${app.getVersion()} 启动（日志会话开始）=====`])
}

/** 读取内存环形缓冲快照（旧→新），供设置页日志面板秒开 */
export function getBufferSnapshot(): LogEntry[] {
  return [...buffer]
}

/**
 * 清空当前会话日志：清内存缓冲 + 清空 latest.log（写入一条"日志已清空"标记行）。
 * 历史备份（app-*.log）不动——需要清理历史时经「打开日志文件夹」手动删除。
 */
export function clearCurrentLog(): void {
  buffer.length = 0
  try {
    const latest = path.join(LOG_DIR(), LATEST_NAME)
    fs.mkdirSync(LOG_DIR(), { recursive: true })
    const entry: LogEntry = { ts: Date.now(), level: 'info', source: 'main', msg: '===== 日志已清空（当前会话重新开始记录）=====' }
    fs.writeFileSync(latest, formatLine(entry) + '\n')
    buffer.push(entry)
  } catch {
    // 清盘失败（文件被占用等）静默：缓冲已清，下次写盘自然恢复
  }
}

/** 读取当前日志文件尾部（默认 512KB），逐行解析为结构化条目，用于查看重启前的历史 */
export function readLatestTail(maxBytes = 512 * 1024): { entries: LogEntry[]; truncated: boolean } {
  try {
    const latest = path.join(LOG_DIR(), LATEST_NAME)
    if (!fs.existsSync(latest)) return { entries: [], truncated: false }
    const stat = fs.statSync(latest)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(latest, 'r')
    try {
      const len = stat.size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      const text = buf.toString('utf8')
      const lines = text.split('\n').filter((l) => l.trim() !== '')
      // 从半行开始截的丢弃首行残片（start > 0 时首行大概率不完整）
      const cleaned = start > 0 && lines.length > 0 ? lines.slice(1) : lines
      const entries = cleaned.map(parseLogLine).filter((e): e is LogEntry => e !== null)
      return { entries, truncated: start > 0 }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { entries: [], truncated: false }
  }
}

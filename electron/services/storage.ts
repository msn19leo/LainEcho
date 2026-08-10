/**
 * JSON 文件读写封装。
 * 所有数据统一存放在 Electron userData 目录下（Windows: %APPDATA%/ai-desktop-pet/）。
 *
 * 原子写策略：先写同名 .tmp 临时文件，再 rename 覆盖目标文件，
 * 避免写一半崩溃导致 JSON 损坏。同一文件名的写入通过内部队列串行化。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'

let userData: string | null = null

/** 获取 userData 根目录（懒初始化，确保 app ready 后调用） */
export function getRootDir(): string {
  if (!userData) userData = app.getPath('userData')
  return userData
}

export const paths = {
  get dataDir() {
    return path.join(getRootDir(), 'data')
  },
  get secureDir() {
    return path.join(getRootDir(), 'data', 'secure')
  },
  get sessionsDir() {
    return path.join(getRootDir(), 'data', 'sessions')
  },
  get modelsDir() {
    return path.join(getRootDir(), 'models')
  },
  get coreDir() {
    return path.join(getRootDir(), 'live2d-core')
  },
  get characterCardsFile() {
    return path.join(this.dataDir, 'characterCards.json')
  },
  get memoryFile() {
    return path.join(this.dataDir, 'memory.json')
  },
  get settingsFile() {
    return path.join(this.dataDir, 'settings.json')
  },
  get apiKeyFile() {
    return path.join(this.secureDir, 'apiKey.enc')
  },
  get sessionsIndexFile() {
    return path.join(this.sessionsDir, 'index.json')
  },
  get modelsIndexFile() {
    return path.join(this.modelsDir, 'index.json')
  },
  get coreFile() {
    return path.join(this.coreDir, 'live2dcubismcore.min.js')
  },
  sessionFile(id: string) {
    return path.join(this.sessionsDir, `${id}.json`)
  },
  modelDir(id: string) {
    return path.join(this.modelsDir, id)
  },
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

/** 确保所有数据目录存在（app ready 时调用一次） */
export async function ensureDataDirs() {
  await Promise.all([
    ensureDir(paths.dataDir),
    ensureDir(paths.secureDir),
    ensureDir(paths.sessionsDir),
    ensureDir(paths.modelsDir),
    ensureDir(paths.coreDir),
  ])
}

// 每文件任务队列：串行化同一文件上的「读-改-写」操作，避免并发丢更新
const fileQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(filePath) ?? Promise.resolve()
  const next = prev.then(task, task)
  // 清理，避免队列无限增长
  fileQueues.set(filePath, next.then(() => undefined, () => undefined))
  return next
}

/** 原子写入 JSON 文件（对象数组等）。data 为 null 时写入空数组默认值。 */
export function writeJson<T>(filePath: string, data: T): Promise<void> {
  return enqueue(filePath, async () => {
    await ensureDir(path.dirname(filePath))
    const tmpPath = `${filePath}.tmp`
    const serialized = JSON.stringify(data, null, 2)
    await fs.writeFile(tmpPath, serialized, 'utf-8')
    await fs.rename(tmpPath, filePath)
  })
}

/**
 * 原子的「读-改-写」：在同一文件队列内完成读取、mutator 变更、写回。
 * 供所有 repository 变更方法使用，彻底避免并发 IPC 下的丢更新。
 */
export function mutateJson<T>(filePath: string, fallback: T, mutator: (current: T) => T | Promise<T>): Promise<T> {
  return enqueue(filePath, async () => {
    const current = await readJson<T>(filePath, fallback)
    const next = await mutator(current)
    await ensureDir(path.dirname(filePath))
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8')
    await fs.rename(tmpPath, filePath)
    return next
  })
}

/** 读取 JSON 文件；不存在或损坏时返回 fallback */
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** 读取二进制文件（用于 safeStorage 密文） */
export async function readBuffer(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

/** 原子写入二进制文件 */
export function writeBuffer(filePath: string, data: Buffer): Promise<void> {
  return enqueue(filePath, async () => {
    await ensureDir(path.dirname(filePath))
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, data)
    await fs.rename(tmpPath, filePath)
  })
}

/**
 * 删除文件或目录（递归）。
 * 递归删除用于 model 目录；对普通文件同样安全（recursive 仅对目录有意义）。
 * 不存在时静默成功。
 */
export async function deleteFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { recursive: true, force: true })
}

/**
 * JSON 文件读写封装。
 * 所有数据统一存放在数据根目录下（默认为 Electron userData：Windows: %APPDATA%/LainEcho/）。
 * 用户可在设置中修改数据目录位置，修改后数据会迁移到新位置。
 *
 * 自定义目录配置文件（data-dir-config.json）始终存放在默认 userData 目录下，
 * 不随数据迁移——否则迁移后无法找到配置。
 *
 * 原子写策略：先写同名 .tmp 临时文件，再 rename 覆盖目标文件，
 * 避免写一半崩溃导致 JSON 损坏。同一文件名的写入通过内部队列串行化。
 */
import { app } from 'electron'
import { promises as fs, readFileSync, existsSync } from 'fs'
import path from 'path'

/** 默认 userData 目录（Electron 标准路径，永不改变） */
let defaultUserData: string | null = null
/** 实际数据根目录（可能为自定义路径，懒初始化） */
let userData: string | null = null

/** 获取默认 userData 目录（Electron 标准路径） */
export function getDefaultUserDataDir(): string {
  if (!defaultUserData) defaultUserData = app.getPath('userData')
  return defaultUserData
}

/** 自定义数据目录配置文件路径（始终在默认 userData 下） */
export function getDataDirConfigFile(): string {
  return path.join(getDefaultUserDataDir(), 'data-dir-config.json')
}

/** 读取自定义数据目录配置（同步，因为 getRootDir 在热点路径调用） */
function readCustomDataDir(): string | null {
  try {
    const raw = readFileSync(getDataDirConfigFile(), 'utf-8')
    const config = JSON.parse(raw) as { customDataDir?: string | null }
    if (config.customDataDir && existsSync(config.customDataDir)) {
      return config.customDataDir
    }
    return null
  } catch {
    return null
  }
}

/** 获取数据根目录（优先使用自定义目录，否则回退到默认 userData） */
export function getRootDir(): string {
  if (!userData) {
    const custom = readCustomDataDir()
    userData = custom ?? getDefaultUserDataDir()
  }
  return userData
}

/**
 * 将所有数据迁移到新目录。
 * 复制 data/、models/、live2d-core/ 三个子目录到目标路径，
 * 成功后写入配置文件，调用方负责 relaunch 应用。
 *
 * 注：参考音频存放于 data/voices/ 下，会随 data 子目录一起迁移。
 */
export async function migrateDataDir(newDir: string): Promise<void> {
  const srcRoot = getRootDir()
  // 确保目标目录存在
  await fs.mkdir(newDir, { recursive: true })

  // 需要迁移的子目录
  const subDirs = ['data', 'models', 'live2d-core']
  for (const sub of subDirs) {
    const src = path.join(srcRoot, sub)
    const dest = path.join(newDir, sub)
    try {
      await fs.access(src)
      // 递归复制（覆盖已存在文件）
      await fs.cp(src, dest, { recursive: true, force: true })
    } catch {
      // 源目录不存在则跳过（如尚未导入 Core）
    }
  }

  // 写入配置文件（始终在默认 userData 下）
  const configPath = getDataDirConfigFile()
  const config = { customDataDir: newDir }
  const tmpPath = `${configPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8')
  await fs.rename(tmpPath, configPath)
}

/** 重置数据目录为默认位置（清除自定义配置，不删除数据） */
export async function resetDataDir(): Promise<void> {
  const configPath = getDataDirConfigFile()
  try {
    await fs.unlink(configPath)
  } catch {
    // 配置文件不存在，无需处理
  }
}

/** 获取当前数据目录信息 */
export function getDataDirInfo(): { current: string; default: string; isCustom: boolean } {
  const current = getRootDir()
  const defaultDir = getDefaultUserDataDir()
  return {
    current,
    default: defaultDir,
    isCustom: current !== defaultDir,
  }
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
  /** 参考音频目录（用于 TTS 声音克隆） */
  get voicesDir() {
    return path.join(this.dataDir, 'voices')
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
  /** TTS 非敏感配置（语言、自动播放） */
  get voiceSettingsFile() {
    return path.join(this.dataDir, 'voice-settings.json')
  },
  /** 参考音频索引文件 */
  get voicesIndexFile() {
    return path.join(this.voicesDir, 'index.json')
  },
  get apiKeyFile() {
    return path.join(this.secureDir, 'apiKey.enc')
  },
  /** MiMo TTS API Key 加密存储文件（与 LLM API Key 隔离） */
  get voiceApiKeyFile() {
    return path.join(this.secureDir, 'voiceApiKey.enc')
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
  get modelSettingsFile() {
    return path.join(this.dataDir, 'model-settings.json')
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
    ensureDir(paths.voicesDir),
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

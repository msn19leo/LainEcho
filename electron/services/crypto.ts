/**
 * safeStorage 加解密封装。
 * API Key 只在主进程内存中出现：渲染进程永远拿不到明文。
 * Windows 下 safeStorage 使用 DPAPI，无需额外依赖。
 */
import { safeStorage } from 'electron'
import { paths, readBuffer, writeBuffer, deleteFile, fileExists } from './storage'

/** safeStorage 是否可用（Windows/macOS 恒为 true；Linux 依赖桌面密钥环） */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** 加密字符串 -> 密文 Buffer */
export function encryptSecret(plain: string): Buffer {
  if (!isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全保存 API Key')
  }
  return safeStorage.encryptString(plain)
}

/** 解密 Buffer -> 明文字符串；失败时抛出明确错误 */
export function decryptSecret(encrypted: Buffer): string {
  if (!isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法解密 API Key')
  }
  return safeStorage.decryptString(encrypted)
}

/** 保存 API Key（密文落盘） */
export async function saveApiKey(key: string): Promise<void> {
  const encrypted = encryptSecret(key)
  await writeBuffer(paths.apiKeyFile, encrypted)
}

/** 读取 API Key 明文（仅主进程内存中使用，不经过 IPC 传给渲染进程） */
export async function readApiKey(): Promise<string | null> {
  if (!(await fileExists(paths.apiKeyFile))) return null
  const encrypted = await readBuffer(paths.apiKeyFile)
  if (!encrypted) return null
  try {
    return decryptSecret(encrypted)
  } catch {
    // 密文损坏 / 系统环境变化导致无法解密，视为未配置
    return null
  }
}

/** 是否已配置 Key（仅回显掩码用，不返回明文） */
export async function hasApiKey(): Promise<boolean> {
  if (!(await fileExists(paths.apiKeyFile))) return false
  return (await readApiKey()) !== null
}

/** 清除 API Key */
export async function clearApiKey(): Promise<void> {
  await deleteFile(paths.apiKeyFile)
}

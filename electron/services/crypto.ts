/**
 * safeStorage 加解密封装（通用通道，按文件路径隔离各密钥）。
 * API Key 只在主进程内存中出现：渲染进程永远拿不到明文。
 * Windows 下 safeStorage 使用 DPAPI，无需额外依赖。
 * 档案制密钥布局：每个服务商档案一个密文文件（secure/keys/<profileId>.enc）。
 */
import { safeStorage } from 'electron'
import { readBuffer, writeBuffer, fileExists } from './storage'

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

/** 保存密钥到指定文件（密文落盘） */
export async function saveSecret(filePath: string, key: string): Promise<void> {
  const encrypted = encryptSecret(key)
  await writeBuffer(filePath, encrypted)
}

/** 读取指定文件的密钥明文（仅主进程内存中使用） */
export async function readSecret(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) return null
  const encrypted = await readBuffer(filePath)
  if (!encrypted) return null
  try {
    return decryptSecret(encrypted)
  } catch {
    return null
  }
}

/** 判断指定文件是否已配置密钥 */
export async function hasSecret(filePath: string): Promise<boolean> {
  if (!(await fileExists(filePath))) return false
  return (await readSecret(filePath)) !== null
}

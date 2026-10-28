/**
 * 聊天图片附件：压缩落盘 / 删除 / 清理 / 读盘。
 *
 * 本模块刻意不依赖 apiProfiles（模型调用在 chatImageCaption）：repository 会级联调用
 * 本模块做删会话清理，若此处再引档案解析会形成 repository → chatImages → apiProfiles
 * → repository 的循环依赖。
 *
 * 设计约束（与产品约定一一对应）：
 * - 压缩在主进程做（渲染端只传 ArrayBuffer）：长边 ≤1568、JPEG q85，顺带剥掉 EXIF
 *   （手机照片的 GPS/设备信息不会随文件进磁盘）；
 * - 落盘位置 data/chat-images/{sessionId}/{fileName}，消息里只存相对路径，
 *   渲染经 pet-res://chat-images/ 读取——绝不把 base64 塞进 sessions/{id}.json；
 * - 任何失败都抛中文错误，由 IPC 层原样透传给渲染端展示。
 */
import { nativeImage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatImage } from '../../src/types'
import { paths } from './storage'

/** 压缩后长边上限（对齐主流多模态模型的最优输入尺寸，再大只是浪费 token） */
const MAX_EDGE = 1568
/** JPEG 质量 */
const JPEG_QUALITY = 85
/** 单张原图字节上限（防止误拖超大文件把主进程内存打满） */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
/** 允许的源格式（HEIC 等 nativeImage 解不了的格式明确拒绝，不静默失败） */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])

/** 会话 id 合法性（与 repository.assertValidResourceId 同量级，防路径穿越） */
function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error('会话标识非法')
}

/** 相对路径合法性：必须是 `{sessionId}/{file}` 两段，且不含上跳 */
function assertSafeRelPath(relPath: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,80}$/.test(relPath) || relPath.includes('..')) {
    throw new Error('图片路径非法')
  }
}

/**
 * 接收一张图片：解码 → 等比压到长边 ≤1568 → 转 JPEG → 落盘 → 返回附件描述。
 * @param buffer 原图字节（来自粘贴/拖拽，渲染端 ArrayBuffer 直传）
 * @param mime 源 MIME（只做入口校验，落盘统一为 image/jpeg）
 */
export async function saveChatImage(params: { sessionId: string; buffer: Buffer; mime: string }): Promise<ChatImage> {
  const { sessionId, buffer, mime } = params
  assertSafeSessionId(sessionId)
  if (!ALLOWED_MIME.has(mime)) throw new Error('不支持该图片格式')
  if (buffer.byteLength === 0) throw new Error('图片内容为空')
  if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error('图片超过 25MB，请压缩后再发送')

  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('图片无法解析，请换一张试试')

  const size = image.getSize()
  const maxEdge = Math.max(size.width, size.height)
  const compressed =
    maxEdge > MAX_EDGE
      ? image.resize(
          size.width >= size.height
            ? { width: MAX_EDGE, height: Math.max(1, Math.round((size.height * MAX_EDGE) / size.width)) }
            : { width: Math.max(1, Math.round((size.width * MAX_EDGE) / size.height)), height: MAX_EDGE },
        )
      : image
  const jpeg = compressed.toJPEG(JPEG_QUALITY)
  if (jpeg.byteLength === 0) throw new Error('图片压缩失败')

  const dir = paths.chatImageDir(sessionId)
  await fs.mkdir(dir, { recursive: true })
  const fileName = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.jpg`
  await fs.writeFile(path.join(dir, fileName), jpeg)

  const final = compressed.getSize()
  return {
    path: `${sessionId}/${fileName}`,
    width: final.width,
    height: final.height,
    bytes: jpeg.byteLength,
    caption: '',
  }
}

/** 删除单个附件文件（用户移除未发送的缩略图；失败静默，由保留期清理兜底） */
export async function discardChatImage(relPath: string): Promise<void> {
  try {
    assertSafeRelPath(relPath)
    await fs.unlink(path.join(paths.chatImagesDir, relPath))
  } catch {
    // 文件已不存在 / 路径非法：都不影响 UI，忽略
  }
}

/** 删除整个会话的图片目录（删会话/清空数据时级联） */
export async function removeSessionImages(sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return
  await fs.rm(paths.chatImageDir(sessionId), { recursive: true, force: true }).catch(() => {})
}

/**
 * 按保留期清理过期原图（retentionDays=0 表示永久保留，直接跳过）。
 * 只删文件不改消息：消息里的图片路径失效后由渲染端退化为占位，不影响对话可用性。
 */
export async function cleanupExpiredImages(retentionDays: number): Promise<number> {
  if (!(retentionDays > 0)) return 0
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  try {
    const sessions = await fs.readdir(paths.chatImagesDir, { withFileTypes: true }).catch(() => [])
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dir = path.join(paths.chatImagesDir, s.name)
      const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const f of files) {
        if (!f.isFile()) continue
        const full = path.join(dir, f.name)
        const stat = await fs.stat(full).catch(() => null)
        if (stat && stat.mtimeMs < cutoff) {
          await fs.unlink(full).catch(() => {})
          removed++
        }
      }
      // 目录空了顺手删掉，避免残留大量空目录
      const left = await fs.readdir(dir).catch(() => ['x'])
      if (left.length === 0) await fs.rmdir(dir).catch(() => {})
    }
  } catch {
    // 清理是尽力而为，失败不影响主流程
  }
  return removed
}

/** 读取文件并转 base64（主模型直读时按需读，不常驻内存） */
export async function readImageAsBase64(relPath: string): Promise<string | null> {
  try {
    assertSafeRelPath(relPath)
    const data = await fs.readFile(path.join(paths.chatImagesDir, relPath))
    return data.toString('base64')
  } catch {
    return null
  }
}

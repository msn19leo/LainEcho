/**
 * 剧情背景库（data/story-backgrounds/，设计文档 7.3）。
 * 用户上传的背景图片随数据目录迁移；剧本 background 事件与覆盖背景以 `user:文件名` 引用。
 * 文件名即引用名：保持上传原名，重名自动追加序号（photo.png → photo-2.png）。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { paths } from '../storage'

/** 背景库允许的图片扩展名（与背景事件素材口径一致） */
const BACKGROUND_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 文件名安全校验（拼路径防穿越；引用名 = 文件名） */
export function isSafeBackgroundName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('.') && !/[/\\]/.test(name) && name !== '..'
}

/** 枚举背景库文件名（隐藏文件过滤，按名称排序） */
export async function listBackgrounds(): Promise<string[]> {
  const names = await fs.readdir(paths.storyBackgroundsDir).catch(() => [] as string[])
  return names.filter((n) => isSafeBackgroundName(n) && BACKGROUND_IMAGE_EXTS.has(path.extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b))
}

/** 上传背景：仅接受图片扩展名，重名自动追加序号；返回实际落盘的文件名列表 */
export async function uploadBackgrounds(srcPaths: string[]): Promise<string[]> {
  await fs.mkdir(paths.storyBackgroundsDir, { recursive: true })
  const existing = new Set(await listBackgrounds())
  const added: string[] = []
  for (const src of srcPaths) {
    const ext = path.extname(src).toLowerCase()
    if (!BACKGROUND_IMAGE_EXTS.has(ext)) continue
    const base = path.basename(src)
    let name = base
    for (let i = 2; existing.has(name); i++) {
      name = `${path.basename(base, ext)}-${i}${ext}`
    }
    await fs.copyFile(src, path.join(paths.storyBackgroundsDir, name))
    existing.add(name)
    added.push(name)
  }
  if (added.length > 0) console.log('[story] 背景库新增 %d 张：%s', added.length, added.join('、'))
  return added
}

/** 删除背景库文件（不存在时静默成功） */
export async function removeBackground(name: string): Promise<void> {
  if (!isSafeBackgroundName(name)) throw new Error('非法背景文件名')
  await fs.rm(path.join(paths.storyBackgroundsDir, name), { force: true })
  console.log('[story] 背景库已删除：%s', name)
}

/**
 * 剧情音乐库（data/story-music/，与背景库同模式）。
 * 用户上传的音频随数据目录迁移；剧本 music 事件以 `user:文件名` 引用。
 * 文件名即引用名：保持上传原名，重名自动追加序号（bgm.mp3 → bgm-2.mp3）。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { paths } from '../storage'

/** 音乐库允许的音频扩展名（与 music 事件素材口径一致） */
const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.m4a'])

/** 文件名安全校验（拼路径防穿越；引用名 = 文件名） */
export function isSafeMusicName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('.') && !/[/\\]/.test(name) && name !== '..'
}

/** 枚举音乐库文件名（隐藏文件过滤，按名称排序） */
export async function listMusics(): Promise<string[]> {
  const names = await fs.readdir(paths.storyMusicsDir).catch(() => [] as string[])
  return names.filter((n) => isSafeMusicName(n) && MUSIC_AUDIO_EXTS.has(path.extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b))
}

/** 上传音乐：仅接受音频扩展名，重名自动追加序号；返回实际落盘的文件名列表 */
export async function uploadMusics(srcPaths: string[]): Promise<string[]> {
  await fs.mkdir(paths.storyMusicsDir, { recursive: true })
  const existing = new Set(await listMusics())
  const added: string[] = []
  for (const src of srcPaths) {
    const ext = path.extname(src).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) continue
    const base = path.basename(src)
    let name = base
    for (let i = 2; existing.has(name); i++) {
      name = `${path.basename(base, ext)}-${i}${ext}`
    }
    await fs.copyFile(src, path.join(paths.storyMusicsDir, name))
    existing.add(name)
    added.push(name)
  }
  if (added.length > 0) console.log('[story] 音乐库新增 %d 首：%s', added.length, added.join('、'))
  return added
}

/** 删除音乐库文件（不存在时静默成功） */
export async function removeMusic(name: string): Promise<void> {
  if (!isSafeMusicName(name)) throw new Error('非法音乐文件名')
  await fs.rm(path.join(paths.storyMusicsDir, name), { force: true })
  console.log('[story] 音乐库已删除：%s', name)
}

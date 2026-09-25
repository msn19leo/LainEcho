/**
 * 2D 立绘 IPC：立绘集导入 / 列表 / 删除。
 *
 * - 只支持文件夹导入（不做 zip 解压）：把所选文件夹整体复制到
 *   userData/sprites/{spriteId}/，并扫描图片文件记录索引。
 * - 一个立绘集 = 一个文件夹，内含多张情绪切图（png/jpg/webp/gif/bmp）。
 *   图片只收集顶层文件（不递归，避免误收录非立绘本体的资源）。
 * - 图片通过 pet-res://sprites/{spriteId}/{filePath} 供桌宠窗口加载。
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { CharacterSprite, CharacterSpriteImage } from '../../src/types'
import { addSprite, genId, listSprites, removeSprite, updateSprite } from '../services/repository'
import { paths } from '../services/storage'
import { windowManager } from '../windows/windowManager'

/** 支持的立绘图片扩展名（小写比对） */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

/** 收集目录顶层所有图片文件，归一化为相对路径的立绘图片列表 */
async function collectImages(dirPath: string): Promise<CharacterSpriteImage[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const images: CharacterSpriteImage[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!IMAGE_EXTS.includes(ext)) continue
    images.push({ filePath: entry.name.replace(/\\/g, '/') })
  }
  return images.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

export function registerSpritesIpc(): void {
  ipcMain.handle('sprite:list', (): Promise<CharacterSprite[]> => listSprites())

  ipcMain.handle('sprite:import-from-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择一个包含多张立绘图片的文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const srcDir = result.filePaths[0] as string

    // 先扫描图片，确认文件夹里确实有立绘本体（避免导入空文件夹）
    const images = await collectImages(srcDir)
    if (images.length === 0) {
      throw new Error('所选文件夹中未找到图片文件（png/jpg/webp/gif/bmp）')
    }

    const spriteId = genId('sprite')
    const destDir = paths.spriteDir(spriteId)
    try {
      await fs.cp(srcDir, destDir, { recursive: true })
    } catch (err) {
      // 复制失败时清理半成品目录 + 索引，避免孤儿资源
      await removeSprite(spriteId).catch(() => undefined)
      throw new Error(`复制立绘文件夹失败：${err instanceof Error ? err.message : String(err)}`)
    }
    // 复制到目标后再扫一次，保证索引与磁盘一致
    const copiedImages = await collectImages(destDir)
    if (copiedImages.length === 0) {
      await removeSprite(spriteId).catch(() => undefined)
      throw new Error('立绘复制后未检测到图片，导入失败')
    }

    const meta: CharacterSprite = {
      id: spriteId,
      name: path.basename(srcDir) || spriteId,
      images: copiedImages,
      emotionMap: null,
      speakingImage: null,
      thinkingImage: null,
      createdAt: Date.now(),
    }
    await addSprite(meta)
    windowManager.notifySpritesChanged()
    return meta
  })

  ipcMain.handle('sprite:remove', async (_e, spriteId: string) => {
    await removeSprite(spriteId)
    windowManager.notifySpritesChanged()
  })

  ipcMain.handle('sprite:update', async (
    _e,
    spriteId: string,
    patch: Partial<Pick<CharacterSprite, 'name' | 'emotionMap' | 'speakingImage' | 'thinkingImage'>>,
  ) => {
    await updateSprite(spriteId, patch)
    windowManager.notifySpritesChanged()
  })
}
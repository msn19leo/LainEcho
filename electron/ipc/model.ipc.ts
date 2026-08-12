/**
 * Live2D 模型 IPC：模型导入/列表/删除 + Cubism Core 运行库引导。
 *
 * - 只支持文件夹导入（不做 zip 解压），校验文件夹内存在 *.model3.json
 * - 校验通过后整体复制到 userData/models/{modelId}/，避免原文件夹被移动/删除导致模型丢失
 * - Cubism Core 是官方闭源 SDK，不能打包进仓库；由用户手动导入
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { Live2DModelMeta, ExpressionMeta, ExpressionParameter, ExpressionBlend } from '../../src/types'
import { addModel, genId, listModels, removeModel, isCorePresent } from '../services/repository'
import { paths, fileExists } from '../services/storage'
import { windowManager } from '../windows/windowManager'

/** 在目录内查找 *.model3.json（仅顶层，不递归，避免误匹配） */
async function findModel3(dirPath: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const file = entries.find((e) => e.isFile() && e.name.endsWith('.model3.json'))
    return file ? file.name : null
  } catch {
    return null
  }
}

export function registerModelIpc(): void {
  ipcMain.handle('model:list', (): Promise<Live2DModelMeta[]> => listModels())

  /** 读取指定模型的 model3.json，返回动作组名列表 */
  ipcMain.handle('model:motion-groups', async (_e, modelId: string): Promise<string[]> => {
    try {
      const models = await listModels()
      const meta = models.find((m) => m.id === modelId)
      if (!meta) return []
      const model3Path = path.join(paths.modelDir(modelId), meta.model3Path)
      const raw = await fs.readFile(model3Path, 'utf-8')
      const json = JSON.parse(raw) as {
        FileReferences?: { Motions?: Record<string, unknown[]> }
      }
      const motions = json.FileReferences?.Motions
      if (!motions || typeof motions !== 'object') return []
      return Object.keys(motions).sort()
    } catch {
      return []
    }
  })

  /**
   * 读取指定模型的表情列表：从 model3.json 的 FileReferences.Expressions 获取表情条目，
   * 再逐个读取 exp3.json 解析 Parameters（Id / Value / Blend）。
   * 参考 airi 的 expression-store.ts：自行解析而非依赖 SDK 的 ExpressionManager。
   */
  ipcMain.handle('model:expression-list', async (_e, modelId: string): Promise<ExpressionMeta[]> => {
    try {
      const models = await listModels()
      const meta = models.find((m) => m.id === modelId)
      if (!meta) return []
      const model3Path = path.join(paths.modelDir(modelId), meta.model3Path)
      const model3Dir = path.dirname(model3Path)
      const raw = await fs.readFile(model3Path, 'utf-8')
      const json = JSON.parse(raw) as {
        FileReferences?: { Expressions?: Array<{ Name: string; File: string }> }
      }
      const expressions = json.FileReferences?.Expressions
      if (!expressions || !Array.isArray(expressions)) return []

      const result: ExpressionMeta[] = []
      for (const expr of expressions) {
        if (!expr.Name || !expr.File) continue
        try {
          const exprPath = path.join(model3Dir, expr.File)
          const exprRaw = await fs.readFile(exprPath, 'utf-8')
          const exprJson = JSON.parse(exprRaw) as {
            Parameters?: Array<{ Id: string; Value: number; Blend: string }>
          }
          const parameters: ExpressionParameter[] = (exprJson.Parameters ?? [])
            .filter((p) => p.Id && typeof p.Value === 'number' && p.Blend)
            .map((p) => ({
              Id: p.Id,
              Value: p.Value,
              Blend: p.Blend as ExpressionBlend,
            }))
          result.push({ name: expr.Name, file: expr.File, parameters })
        } catch {
          // 跳过读取失败的 exp3.json
        }
      }
      return result
    } catch {
      return []
    }
  })

  ipcMain.handle('model:import-from-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Live2D 模型文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const srcDir = result.filePaths[0] as string
    const model3Name = await findModel3(srcDir)
    if (!model3Name) {
      throw new Error('所选文件夹中未找到 .model3.json 文件，请选择 Live2D 模型根目录')
    }

    const modelId = genId('model')
    const destDir = paths.modelDir(modelId)
    try {
      await fs.cp(srcDir, destDir, { recursive: true })
    } catch (err) {
      // 清理半成品副本，避免在 userData/models 留下孤儿目录
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`复制模型文件夹失败：${err instanceof Error ? err.message : String(err)}`)
    }

    // 复制后再次校验
    const copiedModel3 = await findModel3(destDir)
    if (!copiedModel3) {
      await fs.rm(destDir, { recursive: true, force: true })
      throw new Error('模型复制后未找到 .model3.json，导入失败')
    }

    const meta: Live2DModelMeta = {
      id: modelId,
      name: path.basename(srcDir) || modelId,
      model3Path: copiedModel3.replace(/\\/g, '/'),
      createdAt: Date.now(),
    }
    await addModel(meta)
    windowManager.notifyModelsChanged()
    return meta
  })

  ipcMain.handle('model:remove', async (_e, modelId: string) => {
    await removeModel(modelId)
    windowManager.notifyModelsChanged()
  })

  // ---------------- Cubism Core ----------------

  ipcMain.handle('model:core-status', async () => {
    const present = await isCorePresent()
    return { present, path: present ? paths.coreFile : null }
  })

  ipcMain.handle('model:import-core', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Live2D Cubism Core 运行库（live2dcubismcore.min.js）',
      properties: ['openFile'],
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { present: await isCorePresent(), path: await isCorePresent() ? paths.coreFile : null }
    }

    const src = result.filePaths[0] as string
    if (!src.toLowerCase().endsWith('.js')) {
      throw new Error('请选择 live2dcubismcore.min.js 文件')
    }
    try {
      await fs.mkdir(paths.coreDir, { recursive: true })
      await fs.copyFile(src, paths.coreFile)
    } catch (err) {
      throw new Error(`导入 Cubism Core 失败：${err instanceof Error ? err.message : String(err)}`)
    }
    const present = await fileExists(paths.coreFile)
    // 通知桌宠窗口重新初始化（此前可能因 core 缺失停在提示横幅上）
    if (present) windowManager.notifyCoreChanged()
    return { present, path: present ? paths.coreFile : null }
  })
}

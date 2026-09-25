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
import type { Live2DModelMeta, ExpressionMeta, ExpressionParameter, ExpressionBlend, ModelScanResult } from '../../src/types'
import { addModel, genId, listModels, removeModel, isCorePresent, updateModel } from '../services/repository'
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

/** 把文件路径归一化为 POSIX 风格相对键（去 ./ 前缀、统一分隔符、大小写不敏感） */
function normRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 递归扫描目录，收集表情（*.exp3.json）与动作（*.motion3.json）的相对路径（POSIX、相对 base） */
async function walkAssets(dir: string, base: string, out: { expressions: string[]; motions: string[] }): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // 无权限/目录消失：跳过该子树
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walkAssets(abs, base, out)
      continue
    }
    if (!e.isFile()) continue
    const lower = e.name.toLowerCase()
    if (!lower.endsWith('.exp3.json') && !lower.endsWith('.motion3.json')) continue
    const rel = path.relative(base, abs).replace(/\\/g, '/')
    if (lower.endsWith('.exp3.json')) out.expressions.push(rel)
    else out.motions.push(rel)
  }
}

/**
 * 扫描模型目录自动识别表情与动作文件，合并写回 model3.json（无需手动编辑）。
 *
 * - 表情 Name = 文件名去掉 .exp3.json 后缀；动作组名 = 文件名去掉 .motion3.json 后缀（与 airi 一致）
 * - 以归一化 File 相对路径为去重键做**合并**而非覆盖：用户手写条目（含改名）原样保留，仅追加新文件
 * - 只动 FileReferences.Expressions / FileReferences.Motions，不碰 Groups 等其余键
 * - 写前备份原文件为 <model3>.bak；临时文件 + rename 原子写；无新增则不写
 */
async function scanAndMergeAssets(modelId: string): Promise<ModelScanResult> {
  const models = await listModels()
  const meta = models.find((m) => m.id === modelId)
  if (!meta) throw new Error('模型不存在或已被删除')
  const modelDir = paths.modelDir(modelId)
  const model3Path = path.join(modelDir, meta.model3Path)

  const found = { expressions: [] as string[], motions: [] as string[] }
  await walkAssets(modelDir, modelDir, found)

  const raw = await fs.readFile(model3Path, 'utf-8')
  const json = JSON.parse(raw) as {
    FileReferences?: {
      Expressions?: Array<{ Name: string; File: string }>
      Motions?: Record<string, Array<{ File?: string } & Record<string, unknown>>>
    }
  }
  if (!json.FileReferences) json.FileReferences = {}
  const refs = json.FileReferences
  const existingExpr = Array.isArray(refs.Expressions) ? refs.Expressions : (refs.Expressions = [])
  const existingMotions = refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : (refs.Motions = {})

  // ---- 表情合并：追加 model3.json 中尚不存在的文件 ----
  const knownExpr = new Set(existingExpr.map((e) => normRel(e?.File ?? '')))
  let addedExpressions = 0
  for (const rel of found.expressions) {
    if (knownExpr.has(normRel(rel))) continue
    const name = path.basename(rel).replace(/\.exp3\.json$/i, '')
    existingExpr.push({ Name: name, File: rel })
    addedExpressions++
  }

  // ---- 动作全量重组：组名 = 文件名去掉 .motion3.json 后缀（与 airi 一致）----
  // 不沿用 model3.json 原有组结构（如 Idle/Tap/Flick）——组名一律来自动作文件名。
  // 按 File 索引原条目以保留 Sound/FadeInTime 等已声明字段；File 指向不存在文件的
  // 无效条目会被自然清除。Tap 点击交互在重建后无 Tap 组时自动回退为播放空闲动作。
  const originalMotionEntries = new Map<string, { File?: string } & Record<string, unknown>>()
  let originalValidCount = 0
  for (const items of Object.values(existingMotions)) {
    for (const it of items ?? []) {
      if (!it?.File) continue
      const key = normRel(it.File)
      if (!originalMotionEntries.has(key)) originalMotionEntries.set(key, it)
    }
  }
  const rebuiltMotions: Record<string, Array<{ File?: string } & Record<string, unknown>>> = {}
  for (const rel of found.motions) {
    const group = path.basename(rel).replace(/\.motion3\.json$/i, '')
    const entry = originalMotionEntries.get(normRel(rel))
    if (entry) originalValidCount++
    ;(rebuiltMotions[group] ??= []).push(entry ?? { File: rel })
  }
  // 组结构是否发生变化（首次重组/组名变化时为 true；二次扫描已重组则 false，保持幂等）
  const motionsChanged = JSON.stringify(existingMotions) !== JSON.stringify(rebuiltMotions)
  refs.Motions = rebuiltMotions
  const addedMotions = Math.max(0, found.motions.length - originalValidCount)

  const totalExpressions = existingExpr.length
  const totalMotions = Object.values(rebuiltMotions).reduce((n, arr) => n + (arr?.length ?? 0), 0)

  if (addedExpressions > 0 || addedMotions > 0 || motionsChanged) {
    // 写前备份原文件（保留最近一次原版），临时文件 + rename 原子写
    await fs.copyFile(model3Path, `${model3Path}.bak`).catch(() => undefined)
    const tmp = `${model3Path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(json, null, '\t'), 'utf-8')
    await fs.rename(tmp, model3Path)
    console.log('[model] 资产扫描合并: 新增表情 %d / 动作 %d → %s', addedExpressions, addedMotions, model3Path)
  }

  return {
    addedExpressions,
    addedMotions,
    reorganized: motionsChanged,
    totalExpressions,
    totalMotions,
    groups: Object.keys(rebuiltMotions).sort(),
  }
}

export function registerModelIpc(): void {
  ipcMain.handle('model:list', (): Promise<Live2DModelMeta[]> => listModels())

  /**
   * 扫描模型文件夹自动识别表情/动作文件并合并写回 model3.json（用户无需手动编辑）。
   * 写回后广播 models-changed，桌宠窗重载模型使新增的表情/动作即时可用。
   */
  ipcMain.handle('model:scan-assets', async (_e, modelId: string): Promise<ModelScanResult> => {
    const result = await scanAndMergeAssets(modelId)
    if (result.addedExpressions > 0 || result.addedMotions > 0 || result.reorganized) {
      windowManager.notifyModelsChanged()
    }
    return result
  })

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
    // 导入后自动扫描识别表情/动作文件并合并进 model3.json（失败不阻塞导入，可后续手动扫描）
    try {
      const scan = await scanAndMergeAssets(modelId)
      if (scan.addedExpressions > 0 || scan.addedMotions > 0) {
        console.log('[model] 导入自动识别: 表情 +%d / 动作 +%d（%s）', scan.addedExpressions, scan.addedMotions, meta.name)
      }
    } catch (err) {
      console.error('[model] 导入后自动扫描失败（不影响导入）:', err instanceof Error ? err.message : err)
    }
    windowManager.notifyModelsChanged()
    return meta
  })

  ipcMain.handle('model:remove', async (_e, modelId: string) => {
    await removeModel(modelId)
    windowManager.notifyModelsChanged()
  })

  /** 重命名模型（仅展示名，不动磁盘目录）；广播刷新各处模型列表显示 */
  ipcMain.handle('model:rename', async (_e, modelId: string, name: string) => {
    const trimmed = (name ?? '').trim()
    if (!trimmed) throw new Error('名称不能为空')
    await updateModel(modelId, { name: trimmed })
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

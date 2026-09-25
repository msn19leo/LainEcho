/**
 * 剧本加载器：扫描 data/stories/、解析 story.yaml + chapters/*.yaml、zip 导入导出。
 *
 * 分发口径：剧本以 zip 包为分发单位，导入即玩，无在线市场。
 * 导入流程：解压到临时目录 → 全量校验（schema.ts）→ 拷贝到 data/stories/<id>/（覆盖旧版）→ 报告。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import AdmZip from 'adm-zip'
import type { ScriptBundle, ScriptIndexItem, StoryImportReport } from '../../../src/types'
import { paths } from '../storage'
import { validateChapter, validateMeta, type SchemaIssue } from './schema'

/** 剧本目录内允许打包的扩展名（素材白名单，防止把奇怪的东西拷进数据目录） */
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.mp3', '.ogg', '.wav', '.flac', '.m4a',
])

function yamlIssue(file: string, err: unknown): SchemaIssue {
  const msg = err instanceof Error ? err.message : String(err)
  return { file, message: `YAML 解析失败：${msg}` }
}

/** 校验剧本 id 的目录安全（拼路径用） */
function isSafeScriptId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)
}

/**
 * 校验并载入一个剧本目录（story.yaml + chapters/*.yaml）。
 * 导出给可视化编辑器（7.6）复用：编辑器读取磁盘当前状态（允许带错读取，渲染端展示校验报告）。
 * @returns bundle 或 校验错误列表（两者必居其一）
 */
export async function loadBundleFromDir(dir: string): Promise<{ bundle?: ScriptBundle; errors: SchemaIssue[] }> {
  const errors: SchemaIssue[] = []
  const metaPath = path.join(dir, 'story.yaml')
  let metaRaw: unknown
  try {
    metaRaw = parseYaml(await fs.readFile(metaPath, 'utf-8'))
  } catch (err) {
    return { errors: [yamlIssue('story.yaml', err)] }
  }
  const metaResult = validateMeta(metaRaw, 'story.yaml')
  errors.push(...metaResult.errors)
  if (!metaResult.value) return { errors }
  const meta = metaResult.value

  const chaptersDir = path.join(dir, 'chapters')
  let chapterFiles: string[] = []
  try {
    chapterFiles = (await fs.readdir(chaptersDir)).filter((f) => f.endsWith('.yaml')).sort()
  } catch {
    errors.push({ file: 'chapters/', message: '缺少 chapters 目录（至少需要 1 个章节文件）' })
  }
  if (chapterFiles.length === 0) return { errors }

  if (!chapterFiles.some((f) => f.replace(/\.yaml$/, '') === meta.startChapter)) {
    errors.push({ file: 'story.yaml', message: `startChapter「${meta.startChapter}」在 chapters/ 中不存在` })
  }

  const chapters: ScriptBundle['chapters'] = []
  for (const f of chapterFiles) {
    const rel = `chapters/${f}`
    let raw: unknown
    try {
      raw = parseYaml(await fs.readFile(path.join(chaptersDir, f), 'utf-8'))
    } catch (err) {
      errors.push(yamlIssue(rel, err))
      continue
    }
    const result = validateChapter(raw, rel)
    errors.push(...result.errors)
    if (result.value) chapters.push({ file: f.replace(/\.yaml$/, ''), def: result.value })
  }

  if (errors.length > 0 || chapters.length === 0) {
    if (errors.length === 0) errors.push({ file: 'chapters/', message: '无有效章节' })
    return { errors }
  }

  // 章节引用完整性：chapter_end 的 nextChapter / branches / aiJudge 与章节级 fallbackChapter（7.5）
  // 必须指向已存在的章节（防止分支指向不存在的章节，运行期才"视为完结"的隐性失败）
  const fileSet = new Set(chapters.map((c) => c.file))
  for (const ch of chapters) {
    if (ch.def.fallbackChapter && !fileSet.has(ch.def.fallbackChapter)) {
      errors.push({ file: `chapters/${ch.file}`, message: `fallbackChapter 引用了不存在的章节「${ch.def.fallbackChapter}」` })
    }
    for (const ev of ch.def.events) {
      if (ev.type !== 'chapter_end') continue
      const targets = [
        ev.nextChapter,
        ...(ev.branches ?? []).map((b) => b.nextChapter),
        ...(ev.aiJudge?.options ?? []).map((o) => o.nextChapter),
      ].filter((t): t is string => typeof t === 'string' && t.length > 0)
      for (const t of targets) {
        if (!fileSet.has(t)) {
          errors.push({ file: `chapters/${ch.file}`, message: `chapter_end 引用了不存在的章节「${t}」` })
        }
      }
    }
  }
  if (errors.length > 0) return { errors }

  return {
    bundle: {
      meta,
      chapters: chapters.sort((a, b) => a.file.localeCompare(b.file)),
      dir,
    },
    errors,
  }
}

/** 枚举已导入剧本（元信息列表；损坏的剧本目录跳过并在控制台警告） */
export async function listScripts(): Promise<ScriptIndexItem[]> {
  const items: ScriptIndexItem[] = []
  let dirs: string[] = []
  try {
    dirs = await fs.readdir(paths.storiesDir)
  } catch {
    return items
  }
  for (const name of dirs) {
    if (!isSafeScriptId(name)) continue
    const dir = path.join(paths.storiesDir, name)
    try {
      const raw = parseYaml(await fs.readFile(path.join(dir, 'story.yaml'), 'utf-8'))
      const meta = validateMeta(raw, 'story.yaml')
      if (!meta.value) continue
      let chapterCount = 0
      try {
        chapterCount = (await fs.readdir(path.join(dir, 'chapters'))).filter((f) => f.endsWith('.yaml')).length
      } catch {
        // 无章节目录 → 显示 0
      }
      items.push({
        id: meta.value.id,
        title: meta.value.title,
        summary: meta.value.summary ?? '',
        cover: meta.value.cover ?? null,
        chapters: chapterCount,
        characterCardId: meta.value.characters?.[0]?.cardId ?? null,
      })
    } catch (err) {
      console.warn('[story] 读取剧本元信息失败（跳过）：%s', name, err instanceof Error ? err.message : err)
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id))
}

/** 加载剧本（引擎启动用）；剧本不存在或校验失败时 throw */
export async function loadScript(scriptId: string): Promise<ScriptBundle> {
  if (!isSafeScriptId(scriptId)) throw new Error('非法剧本 ID')
  const { bundle, errors } = await loadBundleFromDir(path.join(paths.storiesDir, scriptId))
  if (!bundle) {
    throw new Error(`剧本「${scriptId}」加载失败：${errors.map((e) => `${e.file}: ${e.message}`).join('；')}`)
  }
  return bundle
}

/** 递归收集目录下所有白名单文件（相对路径） */
async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await collectFiles(root, relPath)))
    else if (ASSET_EXTENSIONS.has(path.extname(e.name).toLowerCase()) || e.name.endsWith('.yaml')) out.push(relPath)
  }
  return out
}

/**
 * 从解压后的目录导入剧本：全量校验 → 拷贝到 data/stories/<id>/（覆盖旧版）。
 * @param stagedDir 已解压的剧本根目录（内含 story.yaml）
 */
async function importFromStagedDir(stagedDir: string): Promise<StoryImportReport> {
  const { bundle, errors } = await loadBundleFromDir(stagedDir)
  if (!bundle) return { ok: false, errors }
  const dest = path.join(paths.storiesDir, bundle.meta.id)
  // 覆盖导入：先删旧目录再拷贝，避免旧章节/素材残留
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  for (const rel of await collectFiles(stagedDir)) {
    const src = path.join(stagedDir, rel)
    const target = path.join(dest, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(src, target)
  }
  console.log('[story] 剧本导入成功：%s（%s）', bundle.meta.id, bundle.meta.title)
  return { ok: true, errors: [] }
}

/** 校验解压目录的顶层结构：必须直接包含 story.yaml（允许兼容一层同名子目录） */
async function findStoryRoot(dir: string): Promise<string | null> {
  if (await fs.access(path.join(dir, 'story.yaml')).then(() => true, () => false)) return dir
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const subdirs = entries.filter((e) => e.isDirectory())
  if (subdirs.length === 1) {
    const sub = path.join(dir, subdirs[0]!.name)
    if (await fs.access(path.join(sub, 'story.yaml')).then(() => true, () => false)) return sub
  }
  return null
}

/** 导入 zip 剧本包（story:import；zip 由打包者用任意工具压缩剧本目录内容） */
export async function importFromZip(zipPath: string): Promise<StoryImportReport> {
  try {
    const zip = new AdmZip(zipPath)
    const staged = path.join(paths.storiesDir, '.import-tmp')
    await fs.rm(staged, { recursive: true, force: true })
    await fs.mkdir(staged, { recursive: true })
    zip.extractAllTo(staged, true)
    const root = await findStoryRoot(staged)
    if (!root) {
      await fs.rm(staged, { recursive: true, force: true })
      return { ok: false, errors: [{ file: 'zip', message: '压缩包内未找到 story.yaml（请压缩剧本目录的内容而非外层文件夹的可选层级）' }] }
    }
    const report = await importFromStagedDir(root)
    await fs.rm(staged, { recursive: true, force: true })
    return report
  } catch (err) {
    console.warn('[story] zip 导入失败：', err instanceof Error ? err.message : err)
    return { ok: false, errors: [{ file: 'zip', message: `解压失败：${err instanceof Error ? err.message : String(err)}` }] }
  }
}

/** 导入本地剧本目录（调试/作者用；story:import 传入目录时走此路径） */
export async function importFromDir(dirPath: string): Promise<StoryImportReport> {
  const root = await findStoryRoot(dirPath)
  if (!root) return { ok: false, errors: [{ file: 'dir', message: '目录中未找到 story.yaml' }] }
  return importFromStagedDir(root)
}

/** 导出剧本为 zip 分发包（story:export；返回 null 表示用户取消保存对话框） */
export async function exportScriptToZip(scriptId: string, targetPath: string): Promise<void> {
  if (!isSafeScriptId(scriptId)) throw new Error('非法剧本 ID')
  const dir = path.join(paths.storiesDir, scriptId)
  await fs.access(dir)
  const zip = new AdmZip()
  for (const rel of await collectFiles(dir)) {
    zip.addLocalFile(path.join(dir, rel), rel.includes('/') ? path.dirname(rel).split(path.sep).join('/') : '')
  }
  zip.writeZip(targetPath)
  console.log('[story] 剧本已导出：%s → %s', scriptId, targetPath)
}

/** 删除剧本（连同资源目录） */
export async function removeScript(scriptId: string): Promise<void> {
  if (!isSafeScriptId(scriptId)) throw new Error('非法剧本 ID')
  await fs.rm(path.join(paths.storiesDir, scriptId), { recursive: true, force: true })
  console.log('[story] 剧本已删除：%s', scriptId)
}

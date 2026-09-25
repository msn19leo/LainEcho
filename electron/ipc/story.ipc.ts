/**
 * 剧情演出系统 IPC：剧本库（list/import/export/remove）、run 存档（list-runs/delete-run）、
 * 演出控制（start/respond/stop）、状态查询（get-state）、剧情 TTS 合成、背景库（7.3）、
 * AI 辅助写剧本（7.4）、可视化编辑器读写（7.6）、剧情窗就绪补发。
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { windowManager } from '../windows/windowManager'
import { createEditorWindow, getEditorScriptId } from '../windows/editorWindow'
import { exportScriptToZip, importFromDir, importFromZip, listScripts, loadBundleFromDir, removeScript } from '../services/storyEngine/loader'
import { validateChapter, validateMeta } from '../services/storyEngine/schema'
import { deleteRun, getRun, listRuns } from '../services/storyEngine/runs'
import { listBackgrounds, removeBackground, uploadBackgrounds } from '../services/storyEngine/backgrounds'
import { generateStoryDraft, importStoryDraft } from '../services/storyEngine/draft'
import { getStorySnapshot, resendStoryState, respondStory, setRunSpriteView, startStory, stopStory } from '../services/storyEngine/engine'
import { getGenieConfig, synthesizeGenie } from '../services/genieTts'
import { getTTSModel, genId } from '../services/repository'
import { paths } from '../services/storage'
import type { StoryResponse } from '../../src/types'

/** 校验 id 形态，防止路径穿越 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

const isObjPayload = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 原子写：临时文件 + rename（Windows 覆盖已存在文件由 libuv MoveFileEx REPLACE 语义保证） */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.editor-tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, target)
}

export function registerStoryIpc(): void {
  // ---------------- 剧本库 ----------------

  ipcMain.handle('story:list', () => listScripts())

  ipcMain.handle('story:import', async () => {
    const options = {
      title: '导入剧本包',
      filters: [
        { name: '剧本包', extensions: ['zip'] },
        { name: '剧本目录', extensions: ['*'] },
      ],
      properties: ['openFile'] as Array<'openFile'>,
    }
    const parent = windowManager.getStoryWindow()
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, errors: [{ file: '', message: '已取消' }] }
    }
    const p = picked.filePaths[0]!
    return p.toLowerCase().endsWith('.zip') ? importFromZip(p) : importFromDir(p)
  })

  ipcMain.handle('story:export', async (_e, scriptId: string) => {
    try {
      if (typeof scriptId !== 'string' || !SAFE_ID.test(scriptId)) {
        return { ok: false, error: '非法剧本 ID' }
      }
      const item = (await listScripts()).find((s) => s.id === scriptId)
      const options = {
        title: '导出剧本包',
        defaultPath: `${item?.title ?? scriptId}.zip`,
        filters: [{ name: '剧本包', extensions: ['zip'] }],
      }
      const parent = windowManager.getStoryWindow()
      const saved = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (saved.canceled || !saved.filePath) return { ok: true, canceled: true }
      await exportScriptToZip(scriptId, saved.filePath)
      return { ok: true, path: saved.filePath }
    } catch (err) {
      console.warn('[story] 导出失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('story:remove', async (_e, scriptId: string) => {
    try {
      if (typeof scriptId !== 'string' || !SAFE_ID.test(scriptId)) return { ok: false, error: '非法剧本 ID' }
      await removeScript(scriptId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------- run 存档 ----------------

  ipcMain.handle('story:list-runs', () => listRuns())

  ipcMain.handle('story:delete-run', async (_e, runId: string) => {
    try {
      if (typeof runId !== 'string' || !runId) return { ok: false }
      await deleteRun(runId)
      return { ok: true }
    } catch (err) {
      console.warn('[story] 删除存档失败：', err instanceof Error ? err.message : err)
      return { ok: false }
    }
  })

  // ---------------- 演出控制 ----------------

  ipcMain.handle('story:start', async (_e, params: { scriptId: string; cardId: string; spriteId: string; voice: import('../../src/types').StoryVoiceConfig | null; mode: 'start' | 'resume'; runId?: string; backgroundOverride?: string | null }) => {
    try {
      const p = params ?? ({} as typeof params)
      if (typeof p.scriptId !== 'string' || !SAFE_ID.test(p.scriptId)) throw new Error('非法剧本 ID')
      if (p.mode !== 'resume' && p.mode !== 'start') throw new Error('缺少启动模式')
      if (p.mode === 'resume' && (typeof p.runId !== 'string' || !p.runId)) throw new Error('继续演出缺少 runId')
      if (p.backgroundOverride != null && (typeof p.backgroundOverride !== 'string' || !p.backgroundOverride)) throw new Error('非法覆盖背景')
      const res = await startStory({
        scriptId: p.scriptId,
        cardId: String(p.cardId ?? ''),
        spriteId: String(p.spriteId ?? ''),
        voice: p.voice ?? null,
        mode: p.mode,
        runId: p.runId,
        backgroundOverride: p.backgroundOverride ?? null,
      })
      return { ok: true, runId: res.runId }
    } catch (err) {
      console.warn('[story] 启动失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('story:respond', async (_e, params: { runId: string; response: StoryResponse }) => {
    try {
      const { runId, response } = params ?? ({} as typeof params)
      if (typeof runId !== 'string' || !runId) throw new Error('缺少 runId')
      await respondStory(runId, response)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('story:stop', async (_e, runId: string) => {
    if (typeof runId === 'string' && runId) await stopStory(runId)
    return { ok: true }
  })

  // ---------------- 状态 ----------------

  ipcMain.handle('story:get-state', (_e, runId: string) => {
    return typeof runId === 'string' ? getStorySnapshot(runId) : null
  })

  ipcMain.handle('story:get-run', (_e, runId: string) => {
    return typeof runId === 'string' ? getRun(runId) : null
  })

  // 立绘视图调整（大小/位置；随 run 存档）
  ipcMain.handle('story:set-sprite-view', async (_e, params: { runId: string; view: { scale: number; x: number; y: number } }) => {
    try {
      const { runId, view } = params ?? ({} as typeof params)
      if (typeof runId !== 'string' || !runId) throw new Error('缺少 runId')
      const v = {
        scale: Math.min(3, Math.max(0.3, Number(view?.scale) || 1)),
        x: Math.min(100, Math.max(-100, Number(view?.x) || 0)),
        y: Math.min(100, Math.max(-100, Number(view?.y) || 0)),
      }
      await setRunSpriteView(runId, v)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------- 背景库（设计文档 7.3：上传/枚举/删除，user: 前缀引用） ----------------

  ipcMain.handle('story:list-backgrounds', () => listBackgrounds())

  ipcMain.handle('story:upload-backgrounds', async () => {
    try {
      const options = {
        title: '导入背景图',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      }
      const picked = await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, added: [] }
      const added = await uploadBackgrounds(picked.filePaths)
      return { ok: true, added }
    } catch (err) {
      console.warn('[story] 背景导入失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('story:remove-background', async (_e, name: string) => {
    try {
      if (typeof name !== 'string' || !name) return { ok: false, error: '非法背景文件名' }
      await removeBackground(name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------- AI 辅助写剧本（设计文档 7.4：生成草稿 → 校验 → 手动导入） ----------------

  ipcMain.handle('story:generate-draft', async (_e, params: { premise: string; cardId?: string | null }) => {
    return generateStoryDraft({ premise: String(params?.premise ?? ''), cardId: params?.cardId ?? null })
  })

  ipcMain.handle('story:import-draft', async (_e, draft: string) => {
    try {
      if (typeof draft !== 'string' || !draft.trim()) return { ok: false, errors: [{ file: '草稿', message: '草稿为空' }] }
      return await importStoryDraft(draft)
    } catch (err) {
      console.warn('[story] 草稿导入失败：', err instanceof Error ? err.message : err)
      return { ok: false, errors: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------- 可视化编辑器（7.6：结构化读 / 校验后原子写 / 只读保护） ----------------

  /** 编辑器当前编辑的剧本 id（窗口创建时由主进程记住，渲染端经 story:editor-current 读取） */
  ipcMain.handle('story:editor-current', () => getEditorScriptId())

  ipcMain.handle('story:open-editor', (_e, scriptId: string) => {
    if (typeof scriptId !== 'string' || !SAFE_ID.test(scriptId)) return { ok: false, error: '非法剧本 ID' }
    createEditorWindow(scriptId)
    return { ok: true }
  })

  /** 新增剧本（7.6）：生成骨架剧本（元信息 + 起始章节含两个引导事件）后直接进编辑器编辑 */
  ipcMain.handle('story:editor-create', async () => {
    try {
      const id = genId('story')
      const dir = path.join(paths.storiesDir, id)
      await fs.mkdir(path.join(dir, 'chapters'), { recursive: true })
      const storyYaml = [
        `id: ${id}`,
        'title: 新剧本',
        "summary: ''",
        'startChapter: ch01',
        'version: 1',
        '',
      ].join('\n')
      const ch01 = [
        'name: 第一章',
        'events:',
        '  - type: narration',
        '    text: 故事从这里开始……',
        '  - type: ai_dialogue',
        '    prompt: 请演绎故事开场——先描绘场景与氛围，再以角色身份说出第一句台词。',
        '',
      ].join('\n')
      await atomicWrite(path.join(dir, 'story.yaml'), storyYaml)
      await atomicWrite(path.join(dir, 'chapters', 'ch01.yaml'), ch01)
      console.log('[story] 新增骨架剧本：%s', id)
      createEditorWindow(id)
      return { ok: true, scriptId: id }
    } catch (err) {
      console.warn('[story] 新增剧本失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 读取剧本当前状态（结构化 + 原文双份：表单用结构化，文本微调用原文；允许带错读取，渲染端展示报告） */
  ipcMain.handle('story:editor-read', async (_e, scriptId: string) => {
    try {
      if (typeof scriptId !== 'string' || !SAFE_ID.test(scriptId)) return { ok: false, error: '非法剧本 ID' }
      const dir = path.join(paths.storiesDir, scriptId)
      const storyYaml = await fs.readFile(path.join(dir, 'story.yaml'), 'utf-8').catch(() => '')
      const { bundle, errors } = await loadBundleFromDir(dir)
      const chapterFiles = (await fs.readdir(path.join(dir, 'chapters')).catch(() => [] as string[])).filter((f) => f.endsWith('.yaml')).sort()
      const chapters = await Promise.all(chapterFiles.map(async (f) => {
        const yaml = await fs.readFile(path.join(dir, 'chapters', f), 'utf-8').catch(() => '')
        const file = f.replace(/\.yaml$/, '')
        const loaded = bundle?.chapters.find((c) => c.file === file) ?? null
        return {
          file,
          name: loaded?.def.name ?? file,
          enterWhen: loaded?.def.enterWhen ?? null,
          fallbackChapter: loaded?.def.fallbackChapter ?? null,
          events: loaded?.def.events ?? [],
          yaml,
        }
      }))
      const metaRaw = storyYaml ? (parseYaml(storyYaml) as Record<string, unknown> | null) : null
      return {
        ok: true,
        errors,
        scriptId,
        storyYaml,
        meta: metaRaw ? {
          id: String(metaRaw['id'] ?? scriptId),
          title: String(metaRaw['title'] ?? ''),
          summary: typeof metaRaw['summary'] === 'string' ? metaRaw['summary'] : '',
          startChapter: String(metaRaw['startChapter'] ?? chapterFiles[0]?.replace(/\.yaml$/, '') ?? ''),
          characterCardId: typeof (metaRaw['characters'] as Array<{ cardId?: string }> | undefined)?.[0]?.cardId === 'string' ? (metaRaw['characters'] as Array<{ cardId?: string }>)[0]!.cardId! : null,
          /** 手写剧本默认只读（7.6 定案）：仅当 story.yaml 带 editedVia: form 时允许表单写回 */
          editedVia: metaRaw['editedVia'] === 'form',
        } : null,
        chapters,
      }
    } catch (err) {
      console.warn('[story] 编辑器读取失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 编辑器保存。表单模式：结构化数据 → 全量 schema 校验 → 生成标准 YAML 原子写（并写 editedVia: form 标记，
   * 清理已删除章节的孤儿 yaml）；文本模式：解析校验通过后按用户原文写回（不加标记、注释保留）。
   */
  ipcMain.handle('story:editor-save', async (_e, payload: unknown) => {
    const bad = (message: string) => ({ ok: false, errors: [{ file: '', message }] })
    try {
      if (!isObjPayload(payload)) return bad('保存数据格式错误')
      const scriptId = String(payload['scriptId'] ?? '')
      if (!SAFE_ID.test(scriptId)) return bad('非法剧本 ID')
      const dir = path.join(paths.storiesDir, scriptId)
      await fs.access(dir)
      const mode = payload['mode'] === 'text' ? 'text' : 'form'
      const errors: Array<{ file: string; message: string }> = []

      let storyYamlOut: string
      const chapterOuts: Array<{ file: string; yaml: string }> = []
      let keepEditedVia: boolean | null = null

      if (mode === 'form') {
        const meta = isObjPayload(payload['meta']) ? payload['meta'] as Record<string, unknown> : null
        const chaptersIn = Array.isArray(payload['chapters']) ? payload['chapters'] as Array<Record<string, unknown>> : null
        if (!meta || !chaptersIn || chaptersIn.length === 0) return bad('缺少 meta 或 chapters')
        // 组装 story.yaml：id/version 保持原值，表单保存即标记 editedVia: form（允许后续表单写回）
        const prev = await fs.readFile(path.join(dir, 'story.yaml'), 'utf-8').then((t) => parseYaml(t) as Record<string, unknown> | null, () => null)
        const metaRaw: Record<string, unknown> = {
          id: scriptId,
          title: String(meta['title'] ?? ''),
          startChapter: String(meta['startChapter'] ?? ''),
          version: typeof prev?.['version'] === 'number' ? prev['version'] : 1,
          editedVia: 'form',
        }
        const summary = String(meta['summary'] ?? '').trim()
        if (summary) metaRaw['summary'] = summary
        if (typeof meta['characterCardId'] === 'string' && meta['characterCardId']) {
          metaRaw['characters'] = [{ cardId: meta['characterCardId'] }]
        }
        const metaCheck = validateMeta(metaRaw, 'story.yaml')
        errors.push(...metaCheck.errors)

        for (const [i, ch] of chaptersIn.entries()) {
          const file = String(ch['file'] ?? '')
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(file)) {
            errors.push({ file: `chapters/${file || i}`, message: '章节文件名只能包含字母/数字/下划线/连字符' })
            continue
          }
          const raw: Record<string, unknown> = {
            name: String(ch['name'] ?? file),
            events: Array.isArray(ch['events']) ? ch['events'] : [],
          }
          if (ch['enterWhen'] != null) raw['enterWhen'] = ch['enterWhen']
          if (typeof ch['fallbackChapter'] === 'string' && ch['fallbackChapter']) raw['fallbackChapter'] = ch['fallbackChapter']
          const check = validateChapter(raw, `chapters/${file}`)
          errors.push(...check.errors)
          if (check.value) chapterOuts.push({ file, yaml: stringifyYaml(raw) })
        }
        if (errors.length > 0) return { ok: false, errors }
        storyYamlOut = stringifyYaml(metaRaw)
        keepEditedVia = true
      } else {
        // 文本模式：用户原样文本（注释保留），仅做"能解析且通过 schema"的把关，不加任何标记
        const storyYaml = String(payload['storyYaml'] ?? '')
        const chaptersIn = Array.isArray(payload['chapters']) ? payload['chapters'] as Array<{ file?: unknown; yaml?: unknown }> : null
        if (!storyYaml.trim() || !chaptersIn) return bad('缺少 storyYaml 或 chapters')
        const metaRaw = parseYaml(storyYaml) as Record<string, unknown> | null
        if (!metaRaw || typeof metaRaw !== 'object') return bad('story.yaml 解析失败')
        const metaCheck = validateMeta(metaRaw, 'story.yaml')
        if (metaCheck.value && metaCheck.value.id !== scriptId) {
          errors.push({ file: 'story.yaml', message: `id 不允许修改（仍为 ${scriptId}）` })
        }
        errors.push(...metaCheck.errors)
        keepEditedVia = metaRaw['editedVia'] === 'form'
        for (const c of chaptersIn) {
          const file = String(c['file'] ?? '')
          const yaml = String(c['yaml'] ?? '')
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(file)) return bad(`非法章节文件名：${file}`)
          let raw: unknown = null
          try {
            raw = parseYaml(yaml)
          } catch (err) {
            errors.push({ file: `chapters/${file}`, message: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` })
            continue
          }
          errors.push(...validateChapter(raw, `chapters/${file}`).errors)
          chapterOuts.push({ file, yaml })
        }
        if (errors.length > 0) return { ok: false, errors }
        storyYamlOut = storyYaml
      }

      // 原子写：临时文件 + rename（防写坏剧本）；story.yaml 带 editedVia 或文本模式原标记
      await atomicWrite(path.join(dir, 'story.yaml'), storyYamlOut)
      for (const c of chapterOuts) await atomicWrite(path.join(dir, 'chapters', `${c.file}.yaml`), c.yaml)
      // 清理孤儿章节（编辑器里删除的章节文件不再残留，否则 loader 会按文件名重新捡起）
      const kept = new Set(chapterOuts.map((c) => `${c.file}.yaml`))
      for (const f of await fs.readdir(path.join(dir, 'chapters')).catch(() => [] as string[])) {
        if (f.endsWith('.yaml') && !kept.has(f)) {
          await fs.rm(path.join(dir, 'chapters', f))
          console.log('[story] 编辑器删除孤儿章节：%s（%s）', f, scriptId)
        }
      }
      console.log('[story] 编辑器保存成功：%s（%s 模式，%d 章）', scriptId, mode, chapterOuts.length)
      return { ok: true, editedVia: keepEditedVia === true }
    } catch (err) {
      console.warn('[story] 编辑器保存失败：', err instanceof Error ? err.message : err)
      return bad(err instanceof Error ? err.message : String(err))
    }
  })

  // ---------------- 剧情 TTS（本地 Genie 声库，与角色卡声音模块解耦） ----------------

  ipcMain.handle('story:tts-synthesize', async (_e, params: { ttsModelId: string; language: 'zh' | 'ja'; text: string }) => {
    try {
      const { ttsModelId, language, text } = params ?? ({} as typeof params)
      if (typeof ttsModelId !== 'string' || !ttsModelId) throw new Error('缺少声库模型')
      const model = await getTTSModel(ttsModelId)
      if (!model) throw new Error('声库模型卡不存在')
      const cleaned = typeof text === 'string' ? text.trim() : ''
      if (!cleaned) throw new Error('合成文本为空')
      const config = await getGenieConfig()
      const wav = await synthesizeGenie({
        config,
        characterName: model.characterName,
        onnxModelDir: model.onnxModelDir,
        refAudioPath: model.refAudioPath || undefined,
        refAudioText: model.refAudioText || undefined,
        text: cleaned,
        lang: language === 'ja' ? 'ja' : 'zh',
      })
      return { ok: true, audioBase64: Buffer.from(wav).toString('base64') }
    } catch (err) {
      console.warn('[story] TTS 合成失败：', err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 剧情窗 renderer 就绪：直接向该窗口补发最新活跃 run 快照（迟到接入的恢复入口）
  ipcMain.on('story:renderer-ready', (e) => {
    const snapshot = resendStoryState()
    if (snapshot && !e.sender.isDestroyed()) {
      e.sender.send('story:state', snapshot)
    }
  })
}

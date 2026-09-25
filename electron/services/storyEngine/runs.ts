/**
 * 剧情 run 存档 CRUD（data/story-runs/{runId}.json）。
 * 一次"开始演出"= 一条 run：剧本/角色卡/立绘集/语音配置 + storyState + 演出对话记录。
 * 与聊天会话完全分离——聊天窗/宠物窗/记忆抽取/主动搭话均不可见。
 * 写入经 storage.mutateJson 原子完成（每文件串行队列）。
 */
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { ChatMessage, StoryRun, StoryRunIndexItem, StoryState, StoryVoiceConfig } from '../../../src/types'
import { paths, readJson, mutateJson, deleteFile } from '../storage'
import { getCharacterCard } from '../repository'
import { loadScript } from './loader'

/** run 文件路径 */
function runFile(runId: string): string {
  return path.join(paths.storyRunsDir, `${runId}.json`)
}

/** 校验 runId 形态（拼路径防穿越） */
export function assertValidRunId(runId: string): void {
  if (typeof runId !== 'string' || !/^storyrun_[0-9a-f]{12}$/.test(runId)) {
    throw new Error('非法剧情存档 ID')
  }
}

/** 生成 runId（与 repository.genId 同款格式） */
function genRunId(): string {
  return `storyrun_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** 新建 run（mode=start 时由引擎调用） */
export async function createRun(params: {
  scriptId: string
  cardId: string
  spriteId: string
  voice: StoryVoiceConfig | null
  /** 覆盖背景（可选；本次演出强制使用，优先级高于剧本 background 事件） */
  backgroundOverride?: string | null
  startChapterIndex: number
}): Promise<StoryRun> {
  const now = Date.now()
  const run: StoryRun = {
    runId: genRunId(),
    scriptId: params.scriptId,
    cardId: params.cardId,
    spriteId: params.spriteId,
    voice: params.voice,
    backgroundOverride: params.backgroundOverride ?? null,
    spriteView: { scale: 1, x: 0, y: 0 },
    createdAt: now,
    updatedAt: now,
    storyState: {
      scriptId: params.scriptId,
      chapterIndex: params.startChapterIndex,
      eventIndex: 0,
      vars: {},
      status: 'running',
    },
    messages: [],
  }
  await mutateJson(runFile(run.runId), null as unknown as StoryRun, () => run)
  return run
}

/** 读取 run（不存在 → null） */
export async function getRun(runId: string): Promise<StoryRun | null> {
  assertValidRunId(runId)
  return readJson<StoryRun | null>(runFile(runId), null)
}

/** 写回 storyState + 触碰 updatedAt（引擎每次推进后调用） */
export async function updateRunState(runId: string, state: StoryState): Promise<void> {
  assertValidRunId(runId)
  await mutateJson<StoryRun | null>(runFile(runId), null, (cur) => {
    if (!cur) return cur
    return { ...cur, storyState: state, updatedAt: Date.now() }
  })
}

/** 更新立绘视图（大小/位置；随 run 存档） */
export async function updateRunSpriteView(runId: string, view: StoryRun['spriteView']): Promise<void> {
  assertValidRunId(runId)
  await mutateJson<StoryRun | null>(runFile(runId), null, (cur) => {
    if (!cur) return cur
    return { ...cur, spriteView: view }
  })
}

/** 追加演出消息（引擎入史用） */
export async function appendRunMessages(runId: string, extra: ChatMessage[]): Promise<void> {
  assertValidRunId(runId)
  await mutateJson<StoryRun | null>(runFile(runId), null, (cur) => {
    if (!cur) return cur
    return { ...cur, messages: [...cur.messages, ...extra], updatedAt: Date.now() }
  })
}

/** 删除 run 存档 */
export async function deleteRun(runId: string): Promise<void> {
  assertValidRunId(runId)
  await deleteFile(runFile(runId))
}

/** 存档列表（附剧本名/角色名/进度；损坏条目跳过） */
export async function listRuns(): Promise<StoryRunIndexItem[]> {
  const out: StoryRunIndexItem[] = []
  let files: string[] = []
  try {
    files = await fs.readdir(paths.storyRunsDir)
  } catch {
    return out
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const run = await readJson<StoryRun | null>(path.join(paths.storyRunsDir, f), null)
    if (!run?.runId) continue
    let scriptTitle = run.scriptId
    let chapterCount = 0
    try {
      const bundle = await loadScript(run.scriptId)
      scriptTitle = bundle.meta.title
      chapterCount = bundle.chapters.length
    } catch {
      // 剧本已被删除：仍显示存档（标题回退 id）
    }
    const card = await getCharacterCard(run.cardId).catch(() => null)
    out.push({
      runId: run.runId,
      scriptId: run.scriptId,
      scriptTitle,
      cardId: run.cardId,
      cardName: card?.name ?? '未知角色',
      spriteId: run.spriteId,
      voice: run.voice,
      chapterIndex: run.storyState.chapterIndex,
      chapterCount,
      status: run.storyState.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

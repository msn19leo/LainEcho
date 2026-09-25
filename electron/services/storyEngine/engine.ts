/**
 * 剧情引擎：线性游标执行器（参照 LingChat EventsHandler 顺序迭代模型）。
 * 关键差异：用 Promise 挂起替代 Rust 侧 oneshot channel 阻塞。
 *
 * v2.0：与聊天系统完全分离——引擎跑在 run 存档（data/story-runs/）上，
 * 不创建/读 写任何聊天会话；桌宠零参与（不发 thinking/emotion/voice 通知，语音由剧情窗独立 TTS 播放）。
 *
 * 执行模型：
 *  - 每个非交互事件执行后立即推进游标并把 storyState 落回 run 文件；
 *  - 遇交互事件（choices/input/free_dialogue）挂起等待渲染端 story:respond resolve；
 *  - AI 轮次（ai_dialogue/free_dialogue 每轮）复用 runChatTurn 完整管线（store 覆盖持久化到 run，
 *    导演指令经 StorySection 注入 system prompt），「回复完成 → 推进游标」串行保证；
 *  - AI 轮次开始置 thinking=true（剧情窗切思考立绘），结束后由渲染端按段播放（首个文本段退出思考）；
 *  - AI 轮次失败：游标停在当前事件，剧情窗可重试（respond {kind:'retry'} 游标不动重跑）。
 */
import type {
  ScriptBundle,
  StoryEvent,
  StoryResponse,
  StoryRun,
  StorySnapshot,
  StoryPendingInteraction,
  StoryVoiceConfig,
  ChatMessage,
} from '../../../src/types'
import { promises as fs } from 'fs'
import path from 'path'
import { getCharacterCard, listSprites } from '../repository'
import { paths } from '../storage'
import { runChatTurn } from '../chatTurn'
import { windowManager } from '../../windows/windowManager'
import { loadScript } from './loader'
import { appendRunMessages, createRun, getRun, updateRunSpriteView, updateRunState } from './runs'
import { judgeEnding } from './judge'
import { evalCondition } from './conditions'

/** 单个 run 的运行时（引擎在主进程常驻，窗口关闭不影响演出） */
export interface RunRuntime {
  run: StoryRun
  bundle: ScriptBundle
  /** 当前背景图（快照恢复演出终态用） */
  background: string | null
  /** 可供 AI 背景联动引用的背景清单：剧本内图片（相对路径）+ 背景库（user:文件名） */
  backgroundChoices: string[]
  /** 当前 BGM */
  music: string | null
  /** 挂起中的交互（null = 无；挂起时游标不推进） */
  pending: StoryPendingInteraction | null
  /** 挂起交互的 resolve（respond 时触发） */
  resolver: ((r: StoryResponse) => void) | null
  /** 主循环是否正在执行（防并发：retry respond 时避免双重推进） */
  loopRunning: boolean
  /** AI 轮次等待期（剧情窗思考立绘依据） */
  thinking: boolean
  /** 本次 run 的启动方式（快照 mode：首次接入完整播放 vs 中途接入只显最后一条） */
  startMode: 'start' | 'resume'
  /** 剧情窗是否已完成首次接入（此后重开一律按 resume 处理，不重播全文） */
  attached: boolean
  /** 已通过（或已判定不满足）enterWhen 的章节 file 集合（7.5 防环：每章每次演出至多求值一次；
   *  仅运行期内存态——存档保存的游标一定是"已通过检查"的章节，续玩恢复时预标记当前章不再重复检查） */
  enterWhenVisited: Set<string>
}

/** runId → 运行时。一个 run 同时至多一部剧在演 */
const runtimes = new Map<string, RunRuntime>()

/** 是否有剧情正在演出（主动搭话闸门用） */
export function isStoryActive(): boolean {
  for (const rt of runtimes.values()) {
    if (rt.run.storyState.status === 'running') return true
  }
  return false
}

// ---------------- 广播辅助 ----------------

function chapterNameOf(rt: RunRuntime): string {
  return rt.bundle.chapters[rt.run.storyState.chapterIndex]?.def.name ?? ''
}

function snapshotOf(rt: RunRuntime): StorySnapshot {
  return {
    runId: rt.run.runId,
    scriptId: rt.run.scriptId,
    title: rt.bundle.meta.title,
    status: rt.run.storyState.status,
    // 首次接入（attached=false）= start：剧情窗从第一条消息完整播放；此后一律 resume
    mode: rt.attached ? 'resume' : rt.startMode,
    cardId: rt.run.cardId,
    spriteId: rt.run.spriteId,
    voice: rt.run.voice,
    spriteView: rt.run.spriteView ?? { scale: 1, x: 0, y: 0 },
    chapterIndex: rt.run.storyState.chapterIndex,
    chapterName: chapterNameOf(rt),
    eventIndex: rt.run.storyState.eventIndex,
    vars: { ...rt.run.storyState.vars },
    background: rt.background,
    music: rt.music,
    pending: rt.pending,
    thinking: rt.thinking,
  }
}

/** 广播演出事件（剧情窗驱动演出；聊天/宠物窗按 runId 忽略） */
function broadcastEvent(rt: RunRuntime, event: StoryEvent): void {
  windowManager.broadcast('story:event', { runId: rt.run.runId, event, chapterName: chapterNameOf(rt) })
}

/** 广播状态快照（章节切换/挂起变化/thinking/结束；剧情窗据此刷新，设置页存档列表据此实时刷新） */
function broadcastState(rt: RunRuntime): void {
  windowManager.broadcast('story:state', snapshotOf(rt))
}

/**
 * 广播"run 消息已更新"——剧情窗演出显示的唯一驱动源：
 * 剧情窗按已演游标（processedCount）从 run.messages 增量补演，
 * 窗口打开晚于事件广播也不会丢段（修复"进入剧情后什么都没发生"）。
 */
function broadcastMessageSync(rt: RunRuntime): void {
  windowManager.broadcast('story:message', { runId: rt.run.runId })
}

// ---------------- 变量与条件 ----------------

/** 应用 set_var / 动作里的变量操作（op = = / += / -=） */
function applyVar(vars: Record<string, unknown>, name: string, op: string, value: number | string | boolean): void {
  if (op === '=' || op === undefined) {
    vars[name] = value
    return
  }
  const cur = typeof vars[name] === 'number' ? (vars[name] as number) : Number(vars[name] ?? 0)
  const delta = Number(value) || 0
  vars[name] = op === '+=' ? cur + delta : cur - delta
}

/** 应用 choices/input 事件携带的动作列表（add_line 由调用方处理，这里只处理 set_var） */
async function applyActions(rt: RunRuntime, actions: Array<{ type: string; name?: string; op?: string; value?: number | string | boolean }> | undefined): Promise<void> {
  for (const a of actions ?? []) {
    if (a.type === 'set_var' && a.name) applyVar(rt.run.storyState.vars, a.name, a.op ?? '=', a.value ?? '')
  }
}

// ---------------- 消息入史 ----------------

/** 追加演出消息到 run 文件并同步内存运行时，再广播同步（剧情窗增量补演）。
 *  内存 rt.run.messages 必须与磁盘保持一致：AI 轮次的模型上下文（store.history）取自它，
 *  不同步会导致模型每轮只看到当前一条消息、没有对话历史（选项与回复歧义的根因）。 */
async function appendStoryMessage(rt: RunRuntime, msg: Parameters<typeof appendRunMessages>[1][number]): Promise<void> {
  await appendRunMessages(rt.run.runId, [msg])
  rt.run.messages = [...rt.run.messages, msg]
  broadcastMessageSync(rt)
}

/** runChatTurn store.append 回调：chatTurn 落盘 user 消息与 AI 回复后同步内存运行时 */
async function appendTurnMessages(rt: RunRuntime, msgs: Parameters<typeof appendRunMessages>[1]): Promise<void> {
  if (msgs.length === 0) return
  await appendRunMessages(rt.run.runId, msgs)
  rt.run.messages = [...rt.run.messages, ...msgs]
}

// ---------------- 启动/恢复/停止 ----------------

/** 背景库/剧本内允许作为背景的图片扩展名 */
const BACKGROUND_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 收集可供 AI 背景联动引用的背景清单：剧本目录内图片（相对路径）+ 用户背景库（user:文件名） */
async function collectBackgroundChoices(scriptDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(scriptDir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(relPath)
      else if (BACKGROUND_IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(relPath)
    }
  }
  await walk('')
  const libNames = await fs.readdir(paths.storyBackgroundsDir).catch(() => [] as string[])
  for (const n of libNames) out.push(`user:${n}`)
  return out
}

/**
 * 开始/继续演出。
 * mode='start'：校验 card/sprite 后新建 run 从头演（backgroundOverride=本次演出强制背景）；
 * mode='resume'：按 runId 从游标续玩（覆盖背景随 run 存档沿用）。
 */
export async function startStory(params: {
  scriptId: string
  cardId: string
  spriteId: string
  voice: StoryVoiceConfig | null
  mode: 'start' | 'resume'
  runId?: string
  backgroundOverride?: string | null
}): Promise<{ runId: string }> {
  const { scriptId, cardId, spriteId, voice, mode } = params
  const bundle = await loadScript(scriptId)

  if (mode === 'resume') {
    if (!params.runId) throw new Error('继续演出缺少 runId')
    const existing = runtimes.get(params.runId)
    if (existing) {
      broadcastState(existing)
      return { runId: existing.run.runId }
    }
    const run = await getRun(params.runId)
    if (!run) throw new Error('存档不存在')
    if (run.scriptId !== scriptId) throw new Error('存档与剧本不匹配')
    const rtBundle = await loadScript(run.scriptId)
    const rt: RunRuntime = {
      run,
      bundle: rtBundle,
      background: run.backgroundOverride ?? null,
      backgroundChoices: await collectBackgroundChoices(path.join(paths.storiesDir, run.scriptId)),
      music: null,
      pending: null,
      resolver: null,
      loopRunning: false,
      thinking: false,
      startMode: 'resume',
      attached: false,
      // 续玩：存档游标一定是"已通过 enterWhen 检查"的章节，预标记避免变量随剧情变化后被中途踢出章节
      enterWhenVisited: new Set([rtBundle.chapters[run.storyState.chapterIndex]?.file].filter((f): f is string => !!f)),
    }
    runtimes.set(run.runId, rt)
    console.log('[story] 恢复存档：%s 游标 ch%d#%d', run.runId, run.storyState.chapterIndex, run.storyState.eventIndex)
    broadcastState(rt)
    void runLoop(rt)
    return { runId: run.runId }
  }

  // mode='start'：校验角色卡与立绘集存在（立绘必选）
  const card = await getCharacterCard(cardId)
  if (!card) throw new Error('角色卡不存在')
  const sprite = (await listSprites()).find((s) => s.id === spriteId)
  if (!sprite) throw new Error('立绘集不存在（剧情演出必须选择 2D 立绘集）')
  if (voice) {
    // 语音配置的声库模型卡存在性交由 TTS 合成时报错（避免启动流程依赖 ttsModel 读取失败）
  }

  const startIdx = Math.max(0, bundle.chapters.findIndex((c) => c.file === bundle.meta.startChapter))
  const run = await createRun({ scriptId, cardId, spriteId, voice, backgroundOverride: params.backgroundOverride ?? null, startChapterIndex: startIdx })
  const rt: RunRuntime = {
    run,
    bundle,
    background: run.backgroundOverride ?? null,
    backgroundChoices: await collectBackgroundChoices(bundle.dir),
    music: null,
    pending: null,
    resolver: null,
    loopRunning: false,
    thinking: false,
    startMode: 'start',
    attached: false,
    enterWhenVisited: new Set(),
  }
  runtimes.set(run.runId, rt)
  console.log('[story] 剧情启动：%s（%s）→ run %s', scriptId, bundle.meta.title, run.runId)
  broadcastState(rt)
  void runLoop(rt)
  return { runId: run.runId }
}

/** 暂停演出（保留 run 存档）：终止挂起与循环，下次 resume 从游标续玩 */
export async function stopStory(runId: string): Promise<void> {
  const rt = runtimes.get(runId)
  if (!rt) return
  rt.resolver = null
  rt.pending = null
  rt.thinking = false
  broadcastState(rt) // 设置页存档列表实时刷新依据
  runtimes.delete(runId)
  console.log('[story] 剧情暂停（保留存档）：%s', runId)
}

/** 读取 run 快照（无运行时 → null） */
export function getStorySnapshot(runId: string): StorySnapshot | null {
  const rt = runtimes.get(runId)
  return rt ? snapshotOf(rt) : null
}

/** 调整立绘视图（大小/位置；随 run 存档并广播快照） */
export async function setRunSpriteView(runId: string, view: { scale: number; x: number; y: number }): Promise<void> {
  const rt = runtimes.get(runId)
  await updateRunSpriteView(runId, view)
  if (rt) {
    rt.run.spriteView = view
    broadcastState(rt)
  }
}

/** 剧情窗 renderer 就绪：补发最新活跃 run 的快照（迟到接入恢复；无活跃 run → null）。
 *  补发后即标记 attached：此后重开一律按 resume（只显最后一条，不重播全文）。 */
export function resendStoryState(): StorySnapshot | null {
  let latest: RunRuntime | null = null
  for (const rt of runtimes.values()) {
    if (rt.run.storyState.status !== 'running') continue
    if (!latest || rt.run.updatedAt > latest.run.updatedAt) latest = rt
  }
  if (!latest) return null
  const snap = snapshotOf(latest)
  latest.attached = true
  return snap
}

/** 渲染端提交交互结果：resolve 挂起 Promise，或无挂起时作为「重试/继续」驱动循环 */
export async function respondStory(runId: string, response: StoryResponse): Promise<void> {
  const rt = runtimes.get(runId)
  if (!rt) throw new Error('该存档没有进行中的剧情')
  if (rt.run.storyState.status !== 'running') throw new Error('剧情已结束')
  const resolve = rt.resolver
  if (resolve) {
    rt.resolver = null
    rt.pending = null
    resolve(response)
    return
  }
  // 无挂起交互时的 respond = 重试/继续：游标停在当前事件（如 AI 轮次失败后），从游标处恢复执行
  if (response.kind === 'retry' && !rt.loopRunning) {
    console.log('[story] 手动重试/继续：run %s 从游标 %d 恢复', runId, rt.run.storyState.eventIndex)
    void runLoop(rt)
  }
}

/** 自然/显式完结：置 ended、广播、清理运行时（run 文件保留供回看） */
async function endStory(rt: RunRuntime): Promise<void> {
  rt.run.storyState.status = 'ended'
  rt.pending = null
  rt.thinking = false
  await updateRunState(rt.run.runId, rt.run.storyState)
  console.log('[story] 剧情完结：%s（run %s）', rt.run.scriptId, rt.run.runId)
  broadcastState(rt)
  runtimes.delete(rt.run.runId)
}

// ---------------- 主循环 ----------------

/** 主循环：顺序执行事件直到挂起/结束/出错暂停 */
async function runLoop(rt: RunRuntime): Promise<void> {
  if (rt.loopRunning) return
  rt.loopRunning = true
  try {
    while (rt.run.storyState.status === 'running') {
      const chapter = rt.bundle.chapters[rt.run.storyState.chapterIndex]
      if (!chapter) {
        await endStory(rt)
        return
      }

      // 章节级 enterWhen（7.5）：进入章节前求值一次。不满足 → 落 fallbackChapter（进入前同样过检查）
      // 或静默跳过整章。visited 集合保证每章至多求值一次，杜绝 fallback 环形引用死循环。
      if (!rt.enterWhenVisited.has(chapter.file)) {
        rt.enterWhenVisited.add(chapter.file)
        if (chapter.def.enterWhen && !evalCondition(chapter.def.enterWhen, rt.run.storyState.vars)) {
          const fallback = chapter.def.fallbackChapter ?? null
          const fbIdx = fallback ? rt.bundle.chapters.findIndex((c) => c.file === fallback) : -1
          const fbOk = fbIdx >= 0 && !rt.enterWhenVisited.has(rt.bundle.chapters[fbIdx]!.file)
          console.log('[story] enterWhen 不满足，章节「%s」→ %s', chapter.file, fbOk ? `fallback「${fallback}」` : '跳过整章')
          rt.run.storyState.chapterIndex = fbOk ? fbIdx : rt.run.storyState.chapterIndex + 1
          rt.run.storyState.eventIndex = 0
          await updateRunState(rt.run.runId, rt.run.storyState)
          continue
        }
      }

      const event = chapter.def.events[rt.run.storyState.eventIndex]
      if (!event) {
        await endStory(rt)
        return
      }

      // 条件不满足 → 跳过该事件（游标推进但不产生演出）
      if (event.condition && !evalCondition(event.condition, rt.run.storyState.vars)) {
        rt.run.storyState.eventIndex++
        await updateRunState(rt.run.runId, rt.run.storyState)
        continue
      }

      const suspended = await executeEvent(rt, event)
      if (suspended) return // 挂起：游标停在当前事件，respond 后重新进入循环
      if (rt.run.storyState.status !== 'running') return // 事件内显式结束（chapter_end 完结）

      rt.run.storyState.eventIndex++
      await updateRunState(rt.run.runId, rt.run.storyState)
    }
  } catch (err) {
    // AI 轮次失败等：游标停在当前事件（存档未推进），剧情窗可「重试」
    console.warn('[story] 事件执行失败（游标停在 ch%d#%d，可重试）：', rt.run.storyState.chapterIndex, rt.run.storyState.eventIndex, err instanceof Error ? err.message : err)
    rt.thinking = false
    rt.pending = null
    broadcastState(rt)
  } finally {
    rt.loopRunning = false
  }
}

/**
 * 执行单个事件。
 * @returns true = 挂起等待交互（游标不推进）；false = 已完成（调用方推进游标）
 */
async function executeEvent(rt: RunRuntime, event: StoryEvent): Promise<boolean> {
  const meta = { story: true as const }
  switch (event.type) {
    // ---- 演出类：只广播，不落消息（覆盖背景优先于剧本指令；素材缺失保持当前背景） ----
    case 'background': {
      if (rt.run.backgroundOverride) {
        console.log('[story] background 事件被覆盖背景拦截：%s → %s', event.image, rt.run.backgroundOverride)
        return false
      }
      // user: 引用来自背景库必然存在；剧本内素材缺失时保持当前背景（不打断演出）
      if (!event.image.startsWith('user:')) {
        const assetExists = await fs.access(path.join(rt.bundle.dir, event.image)).then(() => true, () => false)
        if (!assetExists) {
          console.warn('[story] 背景素材缺失（保持当前背景）：%s', event.image)
          return false
        }
      }
      rt.background = event.image
      broadcastEvent(rt, event)
      return false
    }
    case 'music':
      rt.music = event.stop ? null : (event.file ?? null)
      broadcastEvent(rt, event)
      return false
    case 'modify_character':
      broadcastEvent(rt, event)
      return false

    // ---- 叙事类：入史（run 文件）+ 广播（语音由剧情窗播放器按事件文本处理；旁白无语音） ----
    case 'narration':
      broadcastEvent(rt, event)
      await appendStoryMessage(rt, { role: 'user', content: event.text, timestamp: Date.now(), meta: { ...meta, storyKind: 'narration' } })
      return false
    case 'player':
      broadcastEvent(rt, event)
      await appendStoryMessage(rt, { role: 'user', content: event.text, timestamp: Date.now(), meta: { ...meta, storyKind: 'player' } })
      return false
    case 'dialogue':
      broadcastEvent(rt, event)
      await appendStoryMessage(rt, { role: 'assistant', content: event.text, emotion: event.emotion ?? 'neutral', timestamp: Date.now(), meta })
      return false

    // ---- AI 类：完整聊天管线（store 覆盖 → run 文件），回复完成才推进（串行保证） ----
    case 'ai_dialogue': {
      broadcastEvent(rt, event)
      rt.thinking = true
      broadcastState(rt)
      try {
        const asst = await runChatTurn({
          sessionId: rt.run.runId,
          content: `（剧情演出：${event.prompt}）`,
          meta: { ...meta, storyKind: 'narration' },
          storyDirective: buildStoryDirective(rt, event.prompt),
          store: { cardId: rt.run.cardId, history: [...rt.run.messages], append: (msgs) => appendTurnMessages(rt, msgs), storyRunId: rt.run.runId },
        })
        broadcastMessageSync(rt)
        applyStoryBackground(rt, asst)
      } catch (err) {
        broadcastMessageSync(rt) // 失败路径 chatTurn 也会落盘（失败 user + 部分回复）
        throw err
      } finally {
        rt.thinking = false
        broadcastState(rt)
      }
      return false
    }
    case 'free_dialogue': {
      broadcastEvent(rt, event)
      const maxRounds = Math.max(1, event.maxRounds ?? 3)
      let used = 0
      while (used < maxRounds) {
        rt.pending = { kind: 'free', roundsLeft: maxRounds - used, endHint: event.endHint }
        broadcastState(rt)
        const resp = await waitRespond(rt)
        if (resp.kind === 'retry') continue
        if (resp.kind === 'free' && resp.end) break
        const text = resp.kind === 'free' || resp.kind === 'input' ? (resp.text ?? '').trim() : ''
        if (!text) continue
        used++
        rt.pending = null
        // 玩家台词由 runChatTurn 作为 user 消息入史（避免重复落盘）
        rt.thinking = true
        broadcastState(rt)
        try {
          const asst = await runChatTurn({
            sessionId: rt.run.runId,
            content: text,
            meta: { ...meta, storyKind: 'free' },
            storyDirective: buildStoryDirective(rt),
            store: { cardId: rt.run.cardId, history: [...rt.run.messages], append: (msgs) => appendTurnMessages(rt, msgs), storyRunId: rt.run.runId },
          })
          broadcastMessageSync(rt)
          applyStoryBackground(rt, asst)
        } catch (err) {
          broadcastMessageSync(rt)
          throw err
        } finally {
          rt.thinking = false
          broadcastState(rt)
        }
      }
      rt.pending = null
      if (event.endHint) {
        broadcastEvent(rt, { type: 'narration', text: event.endHint })
        await appendStoryMessage(rt, { role: 'user', content: event.endHint, timestamp: Date.now(), meta: { ...meta, storyKind: 'narration' } })
      }
      return false
    }

    // ---- 交互类：挂起等待（retry 响应 = 重新挂起，绝不跳过交互） ----
    case 'choices': {
      broadcastEvent(rt, event)
      for (;;) {
        rt.pending = { kind: 'choices', choices: event.options.map((o) => ({ text: o.text })), allowFree: event.allowFree }
        broadcastState(rt)
        const resp = await waitRespond(rt)
        rt.pending = null
        if (resp.kind === 'retry') {
          broadcastState(rt)
          continue
        }
        if (resp.kind === 'choice') {
          const option = event.options[resp.index]
          if (option) {
            await applyActions(rt, option.actions)
            // 选项文本标记为 choice：入 backlog 供 AI 上下文感知，但不占对话框
            const hasAddLine = (option.actions ?? []).some((a) => a.type === 'add_line')
            if (!hasAddLine) {
              await appendStoryMessage(rt, { role: 'user', content: option.text, timestamp: Date.now(), meta: { ...meta, storyKind: 'choice' } })
            }
            for (const a of option.actions ?? []) {
              if (a.type === 'add_line' && a.content?.trim()) {
                await appendStoryMessage(rt, { role: 'user', content: a.content.trim(), timestamp: Date.now(), meta: { ...meta, storyKind: 'choice' } })
              }
            }
          }
        } else if (resp.kind === 'input' && resp.text.trim()) {
          // allowFree 的自由输入：入 backlog，不占对话框
          await appendStoryMessage(rt, { role: 'user', content: resp.text.trim(), timestamp: Date.now(), meta: { ...meta, storyKind: 'choice' } })
        }
        break
      }
      broadcastState(rt)
      return false
    }
    case 'input': {
      for (;;) {
        rt.pending = { kind: 'input' }
        broadcastState(rt)
        const resp = await waitRespond(rt)
        rt.pending = null
        if (resp.kind === 'retry') {
          broadcastState(rt)
          continue
        }
        const text = resp.kind === 'input' || resp.kind === 'free' ? (resp.text ?? '').trim() : ''
        if (text) {
          await appendStoryMessage(rt, { role: 'user', content: text, timestamp: Date.now(), meta: { ...meta, storyKind: 'free' } })
        }
        await applyActions(rt, event.actions)
        for (const a of event.actions ?? []) {
          if (a.type === 'add_line' && a.content?.trim()) {
            await appendStoryMessage(rt, { role: 'user', content: a.content.trim(), timestamp: Date.now(), meta: { ...meta, storyKind: 'choice' } })
          }
        }
        break
      }
      broadcastState(rt)
      return false
    }

    // ---- 流程类 ----
    case 'set_var':
      applyVar(rt.run.storyState.vars, event.name, event.op ?? '=', event.value)
      return false
    case 'chapter_end': {
      // 分支解析次序（设计文档 7.1）：静态分支表（按序首个满足者）→ AI 判定 → nextChapter 缺省 → 完结
      let next = event.branches?.find((b) => evalCondition(b.when, rt.run.storyState.vars))?.nextChapter ?? null
      if (!next && event.aiJudge) {
        const hit = await judgeEnding(rt, event.aiJudge)
        if (hit) {
          // 判定结果写入变量（缺省 ending），供后续章节 condition/branches 引用
          applyVar(rt.run.storyState.vars, event.aiJudge.varName ?? 'ending', '=', hit.id)
          await updateRunState(rt.run.runId, rt.run.storyState)
          next = hit.nextChapter
        }
      }
      if (!next) next = event.nextChapter ?? null
      if (next) {
        const idx = rt.bundle.chapters.findIndex((c) => c.file === next)
        if (idx >= 0) {
          rt.run.storyState.chapterIndex = idx
          rt.run.storyState.eventIndex = -1 // 交还主循环后统一推进为 0
          console.log('[story] 章节切换 → %s（run %s）', next, rt.run.runId)
          broadcastState(rt)
          return false
        }
        console.warn('[story] chapter_end 指向的章节不存在：%s（视为完结）', next)
      }
      await endStory(rt)
      return false
    }
    default:
      return false
  }
}

// ---------------- 挂起交互 ----------------

/** 挂起等待渲染端提交交互结果（Promise 挂起替代 LingChat 的 oneshot channel） */
function waitRespond(rt: RunRuntime): Promise<StoryResponse> {
  return new Promise<StoryResponse>((resolve) => {
    rt.resolver = resolve
  })
}

/** 组装剧情导演指令段（StorySection 注入 system prompt 末尾）。
 *  角色边界（修复"AI 代写玩家台词"）：你只扮演角色本人，导演指令中对场景或对方（玩家角色）
 *  言行的描述只是舞台说明，不得替对方说话/行动/写心理——对方的回应由玩家自己给出。
 *  含 AI 背景联动说明（设计文档 7.3）：可选 background 顶层键，值为背景清单之一；
 *  覆盖背景启用时不注入（本次演出背景已固定）。 */
function buildStoryDirective(rt: RunRuntime, prompt?: string): string {
  const chapterNo = rt.run.storyState.chapterIndex + 1
  const base =
    `当前处于剧情「${rt.bundle.meta.title}」第 ${chapterNo} 章「${chapterNameOf(rt)}」。` +
    '你只扮演剧情中的角色本人，全部台词与（括号）动作心理都只属于你这个角色，以第一人称呈现。' +
    '导演指令里对场景氛围或对方（玩家角色）言行的描述只是舞台说明，用于你做出反应，' +
    '绝不要替对方说话、行动或描写其心理——对方的回应由玩家自己给出。' +
    '请保持演出节奏，遵守剧本的叙事边界，不要跳出剧情。'
  const lines = [base]
  // 生成时长收敛（7.7 性能第一批）：硬性约束分段数量与每段长度，直接减少生成 token、缩短整轮等待
  lines.push('分段与长度硬性要求：dialogue 数组只输出 2~4 项，每项 1~2 句话（20~60 字），宁可少而精，不要长篇大论。')
  if (prompt) lines.push(`本段导演指令：${prompt}`)
  if (!rt.run.backgroundOverride && rt.backgroundChoices.length > 0) {
    lines.push(
      '演出中如需切换背景，你可以在输出 JSON 对象的顶层额外输出一个 "background" 键（可省略，仅在场景确实发生变化时使用），' +
        `值为下列背景引用之一：${rt.backgroundChoices.join('、')}。` +
        '除此之外仍严格只保留一个顶层键 "dialogue"，不允许输出其他任何内容。',
    )
  }
  return lines.join('\n')
}

/** 导演指令联动（7.3）：AI 回复携带的 background 字段 → 走现有 background 事件通道。
 *  仅接受背景清单内的引用（防止幻觉路径）；覆盖背景启用时联动关闭。 */
function applyStoryBackground(rt: RunRuntime, asst: ChatMessage): void {
  if (rt.run.backgroundOverride) return
  const ref = asst.meta?.storyBackground?.trim()
  if (!ref || ref === rt.background) return
  if (!rt.backgroundChoices.includes(ref)) {
    console.warn('[story] AI 背景联动引用未知背景（忽略）：%s', ref)
    return
  }
  rt.background = ref
  broadcastEvent(rt, { type: 'background', image: ref })
  console.log('[story] AI 背景联动：%s（run %s）', ref, rt.run.runId)
}

/**
 * 剧情引擎二期能力自检（零依赖，esbuild 打包后由 Node 执行）：
 *  1. schema 条件校验：字符串/子句/组合、不支持的写法必须报错（LingChat "hp >= 5 静默恒假"教训）；
 *  2. 求值器：真值 / == / != / >= / <= / > / < / && / ||；
 *  3. chapter_end 校验：branches / aiJudge 结构；
 *  4. 草稿校验：合法草稿通过、坏引用/坏事件报错。
 * 用法：npx tsx scripts/verify-story-engine.ts 或参照 run-prompt-golden.mjs 用 esbuild 打包执行
 */
import { validateEvent, validateChapter } from '../electron/services/storyEngine/schema'
import { validateDraft, normalizeDraftYaml } from '../electron/services/storyEngine/draft'
import { evalCondition } from '../electron/services/storyEngine/conditions'
import { parseDialogueJson } from '../electron/services/emotion'
import { ensureSampleStories } from '../electron/services/storyEngine/samples'
import { loadScript } from '../electron/services/storyEngine/loader'
import { promises as fs } from 'fs'
import path from 'path'

let failed = 0
function expect(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`[PASS] ${name}`)
  } else {
    console.error(`[FAIL] ${name}`, detail ?? '')
    failed++
  }
}

type Unknown = Record<string, unknown>

/** 从校验结果提取产出的 condition（未报错时） */
function condOf(raw: Unknown): unknown {
  // 借 validateChapter 走完整校验链拿结构化事件（validateEvent 的返回值不便于单独取 condition）
  const chapter = validateChapter({ name: 't', events: [raw] }, 'test.yaml')
  if (chapter.errors.length > 0) return { __errors: chapter.errors }
  return (chapter.value?.events[0] as unknown as { condition?: unknown })?.condition
}

// ---------- 1. 条件校验 ----------

expect('字符串：裸变量', JSON.stringify(condOf({ type: 'set_var', name: 'a', value: 1, condition: 'metBefore' })) === JSON.stringify({ var: 'metBefore' }), condOf({ type: 'set_var', name: 'a', value: 1, condition: 'metBefore' }))
expect('字符串：closeness >= 3', JSON.stringify(condOf({ type: 'set_var', name: 'a', value: 1, condition: 'closeness >= 3' })) === JSON.stringify({ var: 'closeness', op: '>=', value: 3 }), condOf({ type: 'set_var', name: 'a', value: 1, condition: 'closeness >= 3' }))
expect('字符串：a >= 1 && b', JSON.stringify(condOf({ type: 'set_var', name: 'a', value: 1, condition: 'a >= 1 && b' })) === JSON.stringify({ mode: 'all', clauses: [{ var: 'a', op: '>=', value: 1 }, { var: 'b' }] }), condOf({ type: 'set_var', name: 'a', value: 1, condition: 'a >= 1 && b' }))
expect('字符串：a == 1 || b != 2', JSON.stringify(condOf({ type: 'set_var', name: 'a', value: 1, condition: 'a == 1 || b != 2' })) === JSON.stringify({ mode: 'any', clauses: [{ var: 'a', op: '==', value: 1 }, { var: 'b', op: '!=', value: 2 }] }), condOf({ type: 'set_var', name: 'a', value: 1, condition: 'a == 1 || b != 2' }))
const mixed = condOf({ type: 'set_var', name: 'a', value: 1, condition: 'a >= 1 && b || c' }) as { __errors?: unknown[] }
expect('字符串：&& 与 || 混用必须报错', Array.isArray(mixed.__errors) && mixed.__errors.length > 0, mixed)
const badOp = condOf({ type: 'set_var', name: 'a', value: 1, condition: { var: 'hp', op: '~=', value: 5 } }) as { __errors?: unknown[] }
expect('对象：未知运算符必须报错', Array.isArray(badOp.__errors) && badOp.__errors.length > 0, badOp)
expect('对象：组合 {mode, clauses}', JSON.stringify(condOf({ type: 'set_var', name: 'a', value: 1, condition: { mode: 'any', clauses: [{ var: 'a', op: '>', value: 0 }, { var: 'b' }] } })) === JSON.stringify({ mode: 'any', clauses: [{ var: 'a', op: '>', value: 0 }, { var: 'b' }] }), condOf({ type: 'set_var', name: 'a', value: 1, condition: { mode: 'any', clauses: [{ var: 'a', op: '>', value: 0 }, { var: 'b' }] } }))

// ---------- 2. 求值器 ----------

const vars = { metBefore: true, flagOff: false, closeness: 3, label: 'warm', zero: 0, empty: '' }
expect('求值：裸变量真值（true）', evalCondition({ var: 'metBefore' }, vars) === true)
expect('求值：裸变量假值（false）', evalCondition({ var: 'flagOff' }, vars) === false)
expect('求值：裸变量 0 为假', evalCondition({ var: 'zero' }, vars) === false)
expect('求值：未定义变量为假', evalCondition({ var: 'nope' }, vars) === false)
expect('求值：== 数字', evalCondition({ var: 'closeness', op: '==', value: 3 }, vars) === true)
expect('求值：!= 数字', evalCondition({ var: 'closeness', op: '!=', value: 3 }, vars) === false)
expect('求值：>= 命中边界', evalCondition({ var: 'closeness', op: '>=', value: 3 }, vars) === true)
expect('求值：< 未命中', evalCondition({ var: 'closeness', op: '<', value: 3 }, vars) === false)
expect('求值：<= 边界', evalCondition({ var: 'closeness', op: '<=', value: 3 }, vars) === true)
expect('求值：> 边界', evalCondition({ var: 'closeness', op: '>', value: 3 }, vars) === false)
expect('求值：== 字符串', evalCondition({ var: 'label', op: '==', value: 'warm' }, vars) === true)
expect('求值：非数值比较恒为 false', evalCondition({ var: 'label', op: '>=', value: 1 }, vars) === false)
expect('求值：all 组合', evalCondition({ mode: 'all', clauses: [{ var: 'closeness', op: '>=', value: 2 }, { var: 'metBefore' }] }, vars) === true)
expect('求值：all 组合一假即假', evalCondition({ mode: 'all', clauses: [{ var: 'closeness', op: '>=', value: 2 }, { var: 'flagOff' }] }, vars) === false)
expect('求值：any 组合一真即真', evalCondition({ mode: 'any', clauses: [{ var: 'flagOff' }, { var: 'closeness', op: '>', value: 2 }] }, vars) === true)

// ---------- 3. chapter_end 校验 ----------

const ce = validateChapter({
  name: 't',
  events: [{
    type: 'chapter_end',
    nextChapter: 'ch03',
    branches: [{ when: 'closeness >= 2', nextChapter: 'ch02' }],
    aiJudge: { prompt: '判定', options: [{ id: 'warm', label: '温暖', nextChapter: 'ch02' }] },
  }],
}, 't.yaml')
expect('chapter_end：branches + aiJudge 校验通过且结构化', ce.errors.length === 0 && (() => {
  const ev = ce.value?.events[0] as unknown as { branches?: unknown[]; aiJudge?: { options?: unknown[] } }
  return Array.isArray(ev?.branches) && Array.isArray(ev?.aiJudge?.options)
})(), ce.errors)

const ceBad = validateChapter({ name: 't', events: [{ type: 'chapter_end', branches: [{ nextChapter: 'x' }] }] }, 't.yaml')
expect('chapter_end：分支缺 when 必须报错', ceBad.errors.length > 0, ceBad.errors)

// ---------- 3.5 章节级 enterWhen / fallbackChapter（7.5） ----------

const ewOk = validateChapter({
  name: 't',
  enterWhen: 'closeness >= 2',
  fallbackChapter: 'ch02',
  events: [{ type: 'narration', text: 'hi' }],
}, 't.yaml')
expect('enterWhen：解析为结构化条件 + fallbackChapter 保留', ewOk.errors.length === 0 && (() => {
  const def = ewOk.value as unknown as { enterWhen?: unknown; fallbackChapter?: string }
  return JSON.stringify(def.enterWhen) === JSON.stringify({ var: 'closeness', op: '>=', value: 2 }) && def.fallbackChapter === 'ch02'
})(), ewOk.errors)

const ewNone = validateChapter({ name: 't', events: [{ type: 'narration', text: 'hi' }] }, 't.yaml')
expect('enterWhen：缺省视为真（不产出字段）', ewNone.errors.length === 0 && ewNone.value?.enterWhen === undefined && ewNone.value?.fallbackChapter === undefined, ewNone.errors)

const ewBad = validateChapter({ name: 't', enterWhen: 'a >= 1 && b || c', events: [{ type: 'narration', text: 'hi' }] }, 't.yaml')
expect('enterWhen：非法条件必须报错且前缀区分于事件 condition', ewBad.errors.some((e) => e.message.includes('章节 enterWhen')), ewBad.errors)

// ---------- 3.6 dialogue 纯字符串数组变体解析（模型偶发简化输出，2026-09-20 线上案例） ----------

const strArr = parseDialogueJson('{"dialogue": ["（点头）走吧，趁雨还没停。", "今天的风，好像比平时还要甜一点。"]}')
expect(
  'parse：dialogue 纯字符串数组 → 按字符串分段、情绪归 neutral',
  strArr.chunks.length === 2
    && strArr.chunks[0]?.text === '（点头）走吧，趁雨还没停。'
    && strArr.chunks[1]?.text === '今天的风，好像比平时还要甜一点。'
    && strArr.chunks.every((c) => c.emotion === 'neutral')
    && !strArr.text.includes('"dialogue"'),
  strArr,
)

const mixedArr = parseDialogueJson('{"dialogue": ["好呀。", { "text": "（拉住你的手）别松开哦。", "emotion": "shy" }]}')
expect(
  'parse：dialogue 字符串与对象混排 → 各自正确解析',
  mixedArr.chunks.length === 2
    && mixedArr.chunks[0]?.text === '好呀。' && mixedArr.chunks[0]?.emotion === 'neutral'
    && mixedArr.chunks[1]?.text === '（拉住你的手）别松开哦。' && mixedArr.chunks[1]?.emotion === 'shy',
  mixedArr,
)

// ---------- 4. 草稿校验 ----------

const GOOD_DRAFT = `id: test-draft
title: 测试剧本
summary: 一个用于自检的草稿。
chapters:
  - file: ch01
    name: 起
    events:
      - type: set_var
        name: closeness
        op: "="
        value: 0
      - type: narration
        text: 开场。
      - type: chapter_end
        nextChapter: ch02
  - file: ch02
    name: 承
    events:
      - type: narration
        text: 分支前的旁白。
      - type: chapter_end
        branches:
          - when: closeness >= 1
            nextChapter: ch03
        aiJudge:
          prompt: 判定
          options:
            - id: a
              label: 甲
              nextChapter: ch03
  - file: ch03
    name: 合
    events:
      - type: chapter_end
`
const goodErrors = validateDraft(GOOD_DRAFT)
expect('草稿：合法草稿零错误', goodErrors.length === 0, goodErrors)

const badRef = validateDraft(GOOD_DRAFT.replace('nextChapter: ch02', 'nextChapter: ch99').replace('nextChapter: ch03\n            nextChapter', 'nextChapter'))
expect('草稿：chapter_end 引用不存在的章节必须报错', badRef.some((e) => e.message.includes('ch99')), badRef)

const badEvent = validateDraft(GOOD_DRAFT.replace('- type: narration\n        text: 开场。', '- type: unknown_event\n        text: 开场。'))
expect('草稿：未知事件类型必须报错', badEvent.some((e) => e.message.includes('未知事件类型')), badEvent)

// ---------- 4.5 草稿修复（LLM 常见笔误：行内紧凑映射 / 章节缺 name） ----------

// 复刻真实失败案例：紧凑映射 + `- file: ch03` 下漏写 name:
const BROKEN_DRAFT = `id: broken-draft
title: 沉默的默契
summary: 一对关系亲密却互相猜忌的朋友。
chapters:
  - file: ch01
    日常的默契
    events:
      - type: music, file: bgm_daily.mp3, loop: true
      - type: background, image: bg_school_courtyard.jpg
      - type: narration, text: 午后的阳光，洒在校园熟悉的角落。
      - type: dialogue, character: MAIN, text: 喂，今天的数学测验，你选了什么？
      - type: choices, options:
          - text: "（笑）跟你一样，也是C。"
            actions:
              - type: set_var, name: closeness, op: +=, value: 1
          - text: "（摇头）我选了B。"
      - type: input
      - type: chapter_end, nextChapter: ch02
  - file: ch02
    name: 失语的瞬间
    events:
      - type: music, stop: true
      - type: set_var, name: closeness, op: =, value: 2
      - type: narration, text: 聚会很热闹。
      - type: chapter_end
`
const repaired = normalizeDraftYaml(BROKEN_DRAFT)
const repairedErrors = validateDraft(repaired)
expect('草稿修复：紧凑映射 + 缺章节名自动修复后校验通过', repairedErrors.length === 0, repairedErrors)
expect('草稿修复：未修复的原始草稿确实报 YAML 解析错误', validateDraft(BROKEN_DRAFT).some((e) => e.message.includes('YAML 解析失败')), validateDraft(BROKEN_DRAFT))
// 修复不误伤：合法块状草稿经 normalize 后逐字符不变
expect('草稿修复：合法草稿不受影响', normalizeDraftYaml(GOOD_DRAFT) === GOOD_DRAFT)

// ---------- 4.6 emotion 归一化（LLM 常自创 crying_happy / smile 等非标准情绪） ----------

const EMOTION_DRAFT = `id: emotion-draft
title: 情绪修复
summary: 测试非标准情绪归一化。
chapters:
  - file: ch01
    name: 起
    events:
      - type: modify_character
        emotion: crying_happy
      - type: dialogue
        character: MAIN
        text: 台词
        emotion: smile
      - type: dialogue
        character: MAIN
        text: 台词二
        emotion: "shocked"
      - type: chapter_end
`
const emoBefore = validateDraft(EMOTION_DRAFT)
expect('emotion：未归一化时确实报 emotion 校验错误', emoBefore.some((e) => e.message.includes('emotion')), emoBefore)
const emoErrors = validateDraft(normalizeDraftYaml(EMOTION_DRAFT))
expect('emotion：crying_happy / smile / shocked 归一化后校验通过', emoErrors.length === 0, emoErrors)

// ---------- 5. 示例剧本端到端（写入临时数据目录后走真实加载器，含章节引用完整性校验） ----------

try {
  await ensureSampleStories()
  for (const id of ['starlight-night', 'rainy-cafe']) {
    const bundle = await loadScript(id)
    expect(`示例剧本端到端加载：${id}（${bundle.chapters.length} 章）`, bundle.chapters.length >= 1 && !!bundle.meta.title)
  }
} catch (err) {
  expect('示例剧本端到端加载', false, err instanceof Error ? err.message : err)
}

// ---------- 6. enterWhen 端到端（临时剧本目录走真实加载器，7.5） ----------

try {
  const { paths } = await import('../electron/services/storage')
  const dir = path.join(paths.storiesDir, 'ew-bad-fallback')
  await fs.mkdir(path.join(dir, 'chapters'), { recursive: true })
  await fs.writeFile(path.join(dir, 'story.yaml'), 'id: ew-bad-fallback\ntitle: EW 自检\nstartChapter: ch01\nversion: 1\n')
  await fs.writeFile(path.join(dir, 'chapters', 'ch01.yaml'), 'name: 一\nfallbackChapter: ghost\nevents:\n  - type: narration\n    text: hi\n')
  const bad = await loadScript('ew-bad-fallback').then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  )
  expect('loader：fallbackChapter 引用不存在章节必须报错', !!bad && bad.message.includes('fallbackChapter'), bad?.message)
  // 修复：ch01 的 fallback 改指向真实存在的 ch02 后应加载成功
  await fs.writeFile(path.join(dir, 'chapters', 'ch01.yaml'), 'name: 一\nfallbackChapter: ch02\nevents:\n  - type: narration\n    text: hi\n')
  await fs.writeFile(path.join(dir, 'chapters', 'ch02.yaml'), 'name: 二\nevents:\n  - type: narration\n    text: ok\n')
  const good = await loadScript('ew-bad-fallback')
  expect('loader：fallbackChapter 指向存在章节后加载成功', good.chapters.length === 2 && good.chapters[0]!.def.fallbackChapter === 'ch02', good.chapters.map((c) => c.file))
  await fs.rm(dir, { recursive: true, force: true })
} catch (err) {
  expect('loader：enterWhen 端到端', false, err instanceof Error ? err.message : err)
}

if (failed > 0) {
  console.error(`\n剧情引擎自检失败：${failed} 项`)
  process.exit(1)
}
console.log('\n剧情引擎自检全部通过')
process.exit(0)

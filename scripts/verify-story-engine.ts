/**
 * 剧情引擎二期能力自检（零依赖，esbuild 打包后由 Node 执行）：
 *  1. schema 条件校验：字符串/子句/组合、不支持的写法必须报错（"hp >= 5 静默恒假"教训）；
 *  2. 求值器：真值 / == / != / >= / <= / > / < / && / ||；
 *  3. chapter_end 校验：branches / aiJudge 结构；
 *  4. 草稿校验：合法草稿通过、坏引用/坏事件报错。
 * 用法：npx tsx scripts/verify-story-engine.ts 或参照 run-prompt-golden.mjs 用 esbuild 打包执行
 */
import { validateEvent, validateChapter, validateMeta } from '../electron/services/storyEngine/schema'
import { validateDraft, normalizeDraftYaml } from '../electron/services/storyEngine/draft'
import { evalCondition } from '../electron/services/storyEngine/conditions'
import { parseDialogueJson, extractDialogueChunkDelta, extractStreamingJsonText, stripParenGroups, emotionAdherence } from '../electron/services/emotion'
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

// ---------- 3.7 AI 背景联动开关（story.yaml aiBackground，默认关闭） ----------

const aiOn = validateMeta({ id: 'test-story', title: 't', startChapter: 'ch01', version: 1, aiBackground: true }, 't.yaml')
expect('validateMeta：aiBackground: true 正确解析', aiOn.errors.length === 0 && aiOn.value?.aiBackground === true, aiOn.errors)
const aiOff = validateMeta({ id: 'test-story', title: 't', startChapter: 'ch01', version: 1 }, 't.yaml')
expect('validateMeta：缺省 aiBackground 视为关闭', aiOff.errors.length === 0 && aiOff.value?.aiBackground === false, aiOff.errors)
const aiJunk = validateMeta({ id: 'test-story', title: 't', startChapter: 'ch01', version: 1, aiBackground: 'yes' }, 't.yaml')
expect('validateMeta：aiBackground 非布尔视为关闭（不报错）', aiJunk.errors.length === 0 && aiJunk.value?.aiBackground === false, aiJunk.errors)

// ---------- 3.6 dialogue 纯字符串数组变体解析（模型偶发简化输出，2026-09-20 线上案例） ----------

const strArr = parseDialogueJson('{"dialogue": ["（点头）走吧，趁雨还没停。", "今天的风，好像比平时还要甜一点。"]}')
expect(
  'parse：dialogue 纯字符串数组 → 按字符串分段、情绪归默认（平静）',
  strArr.chunks.length === 2
    && strArr.chunks[0]?.text === '（点头）走吧，趁雨还没停。'
    && strArr.chunks[1]?.text === '今天的风，好像比平时还要甜一点。'
    && strArr.chunks.every((c) => c.emotion === '平静')
    && !strArr.text.includes('"dialogue"'),
  strArr,
)

const mixedArr = parseDialogueJson('{"dialogue": ["好呀。", { "text": "（拉住你的手）别松开哦。", "emotion": "shy" }]}')
expect(
  'parse：dialogue 字符串与对象混排 → 各自正确解析',
  mixedArr.chunks.length === 2
    && mixedArr.chunks[0]?.text === '好呀。' && mixedArr.chunks[0]?.emotion === '平静'
    && mixedArr.chunks[1]?.text === '（拉住你的手）别松开哦。' && mixedArr.chunks[1]?.emotion === '平静',
  mixedArr,
)

// ---------- 3.9 全角标点 JSON 修复（模型偶发把结构字符写成全角/裸值，2026-09-26 线上案例） ----------

// 线上实拍形态：全角引号 + 全角冒号 + text/emotion 裸值 + 字段间缺逗号 + 缺最外层根花括号
const fwRaw = '“dialogue”：[\n{\n“text”：(听到这个提议，鲸鱼耳朵嗖地一下竖了起来)\n“emotion”：shy\n},\n{\n“text”：尾、尾巴…要搭在你身上吗？\n“emotion”：sad\n}\n]'
const fwParsed = parseDialogueJson(fwRaw)
expect(
  'parse：全角引号/冒号 + 裸值 + 缺逗号 + 缺根花括号 → 修复后正确解析',
  fwParsed.chunks.length === 2
    && fwParsed.chunks[0]?.text === '(听到这个提议，鲸鱼耳朵嗖地一下竖了起来)' && fwParsed.chunks[0]?.emotion === '平静'
    && fwParsed.chunks[1]?.text === '尾、尾巴…要搭在你身上吗？' && fwParsed.chunks[1]?.emotion === '平静'
    && !fwParsed.text.includes('dialogue'),
  fwParsed,
)

// 修复只动结构字符：裸值台词里的中文冒号不得被污染
const fwColon = parseDialogueJson('“dialogue”：[\n{\n“text”：提醒你哦：别熬夜。\n“emotion”：happy\n}\n]')
expect(
  'parse：全角修复不污染裸值台词内的中文冒号',
  fwColon.chunks.length === 1 && fwColon.chunks[0]?.text === '提醒你哦：别熬夜。' && fwColon.chunks[0]?.emotion === '平静',
  fwColon,
)

// 半角引号 + 全角冒号 + 裸值的混合形态（用户粘贴样例）
const mixedPunct = parseDialogueJson('"dialogue"：[\n{\n"text"：（轻轻点头）\n"emotion"：neutral\n}\n]')
expect(
  'parse：半角引号 + 全角冒号 + 裸值 → 修复后正确解析',
  mixedPunct.chunks.length === 1 && mixedPunct.chunks[0]?.text === '（轻轻点头）' && mixedPunct.chunks[0]?.emotion === '平静',
  mixedPunct,
)

// 流式：全角标点下的语音块增量提取（半角/全角键名引号都识别，单项经修复重试解析）
const fwStream = extractDialogueChunkDelta('“dialogue”：[\n{\n“text”：第一句\n“emotion”：shy\n}\n]', 0)
expect(
  'stream：全角标点的流式语音块提取',
  fwStream.items.length === 1 && fwStream.items[0]?.text === '第一句' && fwStream.items[0]?.emotion === '平静',
  fwStream,
)

// 新变体（2026-10-02 线上案例）：每个结构字符被全角引号逐个包裹（“{“text”:“X”}”）→
// 结构贴邻引号清除后可解析，JSON 碎片不再泄漏到气泡与 TTS
const wrappedRaw = '“{“dialogue”:”[\n“{“text”:“（听到这句话，鲸鱼耳朵倏地竖得笔直）”}”,\n“{“text”:“嗯…虽然只是‘平常’。”,”emotion”:“happy”}”\n]”'
const wrappedParsed = parseDialogueJson(wrappedRaw)
expect(
  'parse：结构字符被全角引号逐个包裹 → 贴邻引号清除后正确解析',
  wrappedParsed.chunks.length === 2
    && wrappedParsed.chunks[0]?.text === '（听到这句话，鲸鱼耳朵倏地竖得笔直）'
    && wrappedParsed.chunks[1]?.text === '嗯…虽然只是‘平常’。'
    && wrappedParsed.chunks[1]?.emotion === '平静'
    && !wrappedParsed.text.includes('dialogue'),
  wrappedParsed,
)
const wrappedStream = extractDialogueChunkDelta('“{“dialogue”:”[\n“{“text”:“第一句”}”\n]”', 0)
expect(
  'stream：结构贴邻引号包裹的流式语音块提取',
  wrappedStream.items.length === 1 && wrappedStream.items[0]?.text === '第一句',
  wrappedStream,
)

// 2026-10-02 线上案例：模型漏写右括号（“text”:“（听到这句话，……轻轻晃动”），
// 未闭合括号的纯旁白块曾绕过两道防线被 TTS 朗读。解析层补齐右括号 + 上游纯括号块过滤兜底
const unclosedRaw = '{"dialogue":[{"text":"（听到这句话，原本高高竖起的鲸鱼耳朵瞬间软了下来，尾巴在身后疯狂地拍打了两下","emotion":"shy"}]}'
const unclosedParsed = parseDialogueJson(unclosedRaw)
expect(
  'parse：text 值漏写右括号 → 解析时末尾补齐',
  unclosedParsed.chunks.length === 1
    && unclosedParsed.chunks[0]?.text?.endsWith('）') === true
    && unclosedParsed.chunks[0]?.emotion === '平静', // 内置最小词表下 shy 归一化到默认词
  unclosedParsed,
)
const unclosedStream = extractDialogueChunkDelta('{"dialogue":[{"text":"（悄悄把脸埋进围巾里"}]}', 0)
expect(
  'stream：漏写右括号的流式语音块提取同样补齐',
  unclosedStream.items.length === 1 && unclosedStream.items[0]?.text?.endsWith('）') === true,
  unclosedStream,
)
// 已闭合文本不受影响（不应被误补）
const closedParsed = parseDialogueJson('{"dialogue":[{"text":"（点头）我知道了（微笑）","emotion":"平静"}]}')
expect(
  'parse：括号已闭合的文本原样保留不误补',
  closedParsed.chunks.length === 1 && closedParsed.chunks[0]?.text === '（点头）我知道了（微笑）',
  closedParsed,
)

// ---------- 3.9b 纯字符串数组变体 + 截断 JSON（2026-10-02 线上案例：JSON 源码进 TTS） ----------

// A：纯字符串数组变体（元素无 {text, emotion} 包裹）的流式提取——此前零提取导致语音全押兜底
const bareStream = extractDialogueChunkDelta('{"dialogue": ["（旁白描写）", "真的吗？那太好啦！"]}', 0)
expect(
  'stream：纯字符串数组变体按裸字符串元素提取（键名不被误当台词）',
  bareStream.items.length === 2
    && bareStream.items[0]?.text === '（旁白描写）' && bareStream.items[0]?.emotion === '平静'
    && bareStream.items[1]?.text === '真的吗？那太好啦！',
  bareStream,
)
// A：漏根花括号的裸数组同样按元素位置提取
const bareNoRoot = extractDialogueChunkDelta('"dialogue": ["第一句", "第二句"]', 0)
expect(
  'stream：漏 root 花括号的裸数组元素提取（"dialogue" 键名不进气泡）',
  bareNoRoot.items.length === 2
    && bareNoRoot.items[0]?.text === '第一句' && bareNoRoot.items[1]?.text === '第二句',
  bareNoRoot,
)
// A：字符串仍在书写中 → 零提取等待更多 token
const bareWip = extractDialogueChunkDelta('{"dialogue": ["（', 0)
expect('stream：书写中的裸字符串零提取（等待闭合）', bareWip.items.length === 0, bareWip)
// A：裸字符串数组的流式上屏（含正在书写中的最后一个，保留打字感）
const bareDisplay = extractStreamingJsonText('{"dialogue": ["（旁白描写）", "真的吗？那太好啦！"]}')
expect('stream：纯字符串数组变体的流式上屏提取', bareDisplay === '（旁白描写）\n真的吗？那太好啦！', bareDisplay)
const bareDisplayWip = extractStreamingJsonText('{"dialogue": ["真的')
expect('stream：书写中的裸字符串实时上屏', bareDisplayWip === '真的', bareDisplayWip)

// B：截断 JSON（`{"dialogue": ["（`）→ 补全抢救不出实质台词 → JSON 形态拒收返回空 → 触发上层自动重试
const truncatedParse = parseDialogueJson('{"dialogue": ["（')
expect(
  'parse：截断 JSON 源码拒收（text 为空触发重试，绝不进气泡/TTS）',
  truncatedParse.text === '' && truncatedParse.chunks.length === 0,
  truncatedParse,
)
// B：截断在字符串值中间但前面已有完整台词 → prose 抢救出截断前内容
const truncatedRescue = parseDialogueJson('{"dialogue": [{"text": "第一句台词", "emotion": "happy"}, {"text": "第二')
expect(
  'parse：截断 JSON 抢救出截断前的完整台词',
  truncatedRescue.text.includes('第一句台词') && !truncatedRescue.text.includes('dialogue'),
  truncatedRescue,
)

// P2a 情绪依从观测（2026-10-03）：parse 返回归一化前的原始 emotion 值 + 三态判定
const adherenceParse = parseDialogueJson('{"dialogue":[{"text":"第一句","emotion":"happy"},{"text":"第二句"}]}')
expect(
  'parse：rawEmotions 收集归一化前的原始 emotion 值（缺省记空串）',
  adherenceParse.rawEmotions.length === 2 && adherenceParse.rawEmotions[0] === 'happy' && adherenceParse.rawEmotions[1] === '',
  adherenceParse,
)
const adherPalette = {
  entries: [
    { name: '开心', gloss: '明亮愉快', image: '' },
    { name: '平静', gloss: '从容放松', image: '' },
  ],
  defaultEmotion: '平静',
}
expect(
  'adherence：词表精确命中/别名接住/无效回落三态判定',
  emotionAdherence('开心', adherPalette) === 'hit'
    && emotionAdherence('HAPPY', adherPalette) === 'alias' // 大小写不敏感，happy→开心
    && emotionAdherence('不存在的词', adherPalette) === 'miss'
    && emotionAdherence('', adherPalette) === 'miss'
    && emotionAdherence('开心') === 'miss', // 内置最小词表（仅平静）下开心不在词表 → 回落默认
  null,
)

// 流式：全角 + 裸值的流式上屏提取（打字机显示不再外露 JSON 源码）
const fwDisplay = extractStreamingJsonText('“dialogue”：[\n{\n“text”：第一句\n“emotion”：shy\n},\n{\n“text”：第二句')
expect('stream：全角 + 裸值的流式上屏提取', fwDisplay === '第一句\n第二句', fwDisplay)

// ---------- 3.10 台词模式括号剥除（「回答仅含台词」的解析层兜底） ----------

expect(
  'strip：全局剥除括号组（前缀 + 中缀 + 半角）',
  stripParenGroups('（轻轻转头）你好呀。今天（心情）不错 (nice)') === '你好呀。今天不错',
  stripParenGroups('（轻轻转头）你好呀。今天（心情）不错 (nice)'),
)
expect(
  'strip：未闭合残组剥除（流式中段不会残留半个括号组）',
  stripParenGroups('你好呀。（心跳加速') === '你好呀。',
  stripParenGroups('你好呀。（心跳加速'),
)
const stripParsed = parseDialogueJson(stripParenGroups('{"dialogue":[{"text":"（转身）你来了。","emotion":"happy"},{"text":"（沉默）","emotion":"neutral"}]}'))
expect(
  'strip：纯括号项剥空后被解析过滤（不出空语音块）',
  stripParsed.chunks.length === 1
    && stripParsed.chunks[0]?.text === '你来了。' && stripParsed.chunks[0]?.emotion === '平静',
  stripParsed,
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
// 词表方案（P0）：emotion 校验放宽为"非空字符串"——未归一化词不再硬拦，
// 运行时归一化链（词表→软链→默认情绪）保证未知词有确定降级，比阻断导入更稳
expect('emotion：未归一化词不再硬拦（词表方案，运行时降级兜底）', emoBefore.length === 0, emoBefore)
const emoEmpty = validateDraft(EMOTION_DRAFT.replace('emotion: crying_happy', 'emotion: ""'))
expect('emotion：空值仍报错（modify_character 必填）', emoEmpty.some((e) => e.message.includes('emotion')), emoEmpty)
const emoErrors = validateDraft(normalizeDraftYaml(EMOTION_DRAFT))
expect('emotion：crying_happy / smile / shocked 归一化后校验通过', emoErrors.length === 0, emoErrors)

// ---------- 5. 示例剧本端到端（写入临时数据目录后走真实加载器，含章节引用完整性校验） ----------

try {
  // 测试的 electron 桩把 userData 指向临时目录（跑完即删），天然无安装标记 → 照常写入样本
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

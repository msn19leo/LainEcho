/**
 * 内置示例剧本（仅首次启动写入 data/stories/，之后与普通剧本完全同权：删除即永久删除）。
 * 通过标记文件记录"示例已安装过"——用户删掉示例目录后重启不会再复活；
 * 部分写入中途崩溃时标记未落，下次启动可补齐缺失的（目录级幂等，绝不覆盖已有剧本）。
 * 示例不依赖任何外部图片/音频素材（背景可在设置页「剧情系统 → 背景库」上传后，
 * 通过「覆盖背景」或剧本 background 事件的 user: 引用启用）；
 * 同时演示二期能力：数值条件（closeness >= / <=）与 chapter_end 分支结局（AI 判定结局以注释示例给出）。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { paths } from '../storage'

/** 示例剧本"已安装"标记文件名（位于 storiesDir 根下，用户不可见即可） */
export const SAMPLES_MARKER_FILE = '.samples-installed'

const STARLIGHT = `id: starlight-night
title: 深夜观星
summary: 一个安静的夜晚，你们聊起了星空。一部 5 分钟的短篇，展示旁白、预设台词与 AI 自由演绎的完整流程。
startChapter: 01-intro
version: 1
`

const STARLIGHT_INTRO = `name: 深夜…
events:
  - type: narration
    text: 夜色像浸了墨的绒布，只有天上还亮着几粒星。
  - type: dialogue
    text: 「……你也睡不着吗？」
    emotion: shy
  - type: narration
    text: 她抱着膝盖坐在天台上，没有回头，像是早就知道你会来。
  - type: ai_dialogue
    prompt: 她指着天顶最亮的那颗星，讲起自己研究星空的缘由，语气渐渐雀跃起来。
  - type: choices
    options:
      - text: 说起来，你是研究天文学的吧？
      - text: 安静地陪着她看星星
  - type: free_dialogue
    maxRounds: 2
    endHint: 夜风变凉了，话题慢慢停在了星光里。
  - type: narration
    text: 今晚的星星，好像比记忆里的任何一夜都要亮。
  - type: chapter_end
`

const RAINY = `id: rainy-cafe
title: 雨日咖啡馆
summary: 下雨天躲进一家旧咖啡馆，窗外的雨声和杯中的热气之间，有一场关于"仪式感"的小小对谈。演示数值变量与分支结局。
startChapter: 01-entry
version: 1
`

const RAINY_ENTRY = `name: 雨声…
events:
  - type: music
    stop: true
  - type: narration
    text: 雨下得毫无预兆。你推开咖啡馆的门时，风铃响了两声。
  - type: dialogue
    text: 「啊——你也进来躲雨？」
    emotion: surprised
  - type: dialogue
    text: （她把靠窗的位置往里让了让，「这个位置看雨最好看。」）
    emotion: happy
  - type: set_var
    name: closeness
    op: "="
    value: 0
  - type: input
  - type: ai_dialogue
    prompt: 顺着玩家刚说的内容聊下去；她谈到自己喜欢雨天是因为"被允许慢下来"，语气柔软。
  - type: choices
    options:
      - text: 「仪式感这种东西，果然很重要。」
        actions:
          - type: set_var
            name: closeness
            op: "+="
            value: 1
      - text: 「我倒是觉得随性一点也挺好。」
        actions:
          - type: set_var
            name: closeness
            op: "-="
            value: 1
  - type: ai_dialogue
    prompt: 她对刚才的回答做出真实反应——如果对方认同仪式感，她会开心地分享自己收集杯垫的习惯；如果对方随性，她会假装生气地鼓起脸。
  - type: free_dialogue
    maxRounds: 3
    endHint: 雨停了。玻璃窗上的水痕反着光，像谁把星星揉碎了贴在上面。
  - type: chapter_end
    nextChapter: 02-epilogue
`

const RAINY_EPILOGUE = `name: 尾声
events:
  # 数值条件：只有 closeness 达到 1 时才会演出这句旁白
  - type: narration
    text: 临走前，她把一枚杯垫塞进你的口袋，「下次下雨，就当是它先开口邀请你。」
    condition: closeness >= 1
  - type: narration
    text: 风铃又响了两声，这次是送别。
  # 分支结局：按序求值，首个满足条件的分支生效；都不满足走 nextChapter；两者都缺省 = 完结。
  # AI 判定结局（可选项）：都不满足时交给 LLM 依据整局对话表现选一个选项，判定失败回退缺省章节：
  #   aiJudge:
  #     prompt: 依据整场对话里两人的距离感，判断这次相遇更接近哪种余韵。
  #     options:
  #       - id: warm
  #         label: 温暖的余韵
  #         nextChapter: 03-warm
  #       - id: distant
  #         label: 淡淡的疏离
  #         nextChapter: 03-distant
  - type: chapter_end
    nextChapter: 03-normal
    branches:
      - when: closeness >= 1
        nextChapter: 03-warm
      - when: closeness <= -1
        nextChapter: 03-distant
`

const RAINY_WARM = `name: 温暖的余韵
events:
  - type: narration
    text: 你把那枚杯垫立在窗台上。雨声再响起的时候，你们果然都在。
  - type: chapter_end
`

const RAINY_DISTANT = `name: 淡淡的疏离
events:
  - type: narration
    text: 后来你又路过那家咖啡馆。她坐在老位置，身边坐着别人。
  - type: chapter_end
`

const RAINY_NORMAL = `name: 平淡的告别
events:
  - type: narration
    text: 雨天、咖啡馆、一段刚刚好的对话。有些相遇，本身就足够完整。
  - type: chapter_end
`

/**
 * 写入示例剧本（按剧本 id 目录是否已存在判断，绝不覆盖用户数据）。
 * 默认只生效一次：storiesDir 下存在安装标记即整体跳过——示例删除后与普通剧本一样不会复活。
 * 部分写入中途崩溃时标记未落，下次启动可补齐缺失的（目录级幂等）。
 */
export async function ensureSampleStories(): Promise<void> {
  const marker = path.join(paths.storiesDir, SAMPLES_MARKER_FILE)
  try {
    await fs.access(marker)
    return // 标记已存在：示例安装过（可能已被用户删除），不再写入
  } catch {
    // 无标记：首次安装，继续写入
  }
  const samples: Array<{ id: string; files: Record<string, string> }> = [
    {
      id: 'starlight-night',
      files: {
        'story.yaml': STARLIGHT,
        'chapters/01-intro.yaml': STARLIGHT_INTRO,
      },
    },
    {
      id: 'rainy-cafe',
      files: {
        'story.yaml': RAINY,
        'chapters/01-entry.yaml': RAINY_ENTRY,
        'chapters/02-epilogue.yaml': RAINY_EPILOGUE,
        'chapters/03-warm.yaml': RAINY_WARM,
        'chapters/03-distant.yaml': RAINY_DISTANT,
        'chapters/03-normal.yaml': RAINY_NORMAL,
      },
    },
  ]
  for (const sample of samples) {
    const dir = path.join(paths.storiesDir, sample.id)
    try {
      await fs.access(dir)
      continue // 已存在：不覆盖
    } catch {
      // 不存在：写入
    }
    for (const [rel, content] of Object.entries(sample.files)) {
      const target = path.join(dir, rel)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf-8')
    }
    console.log('[story] 已写入示例剧本：%s', sample.id)
  }
  // 全部写入完成后落安装标记（写一半崩溃则标记未落，下次启动可补齐缺失的）
  await fs.writeFile(marker, new Date().toISOString(), 'utf-8')
}

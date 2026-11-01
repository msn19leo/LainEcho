/**
 * 剧情系统设置面板：剧本库（导入/导出/删除）+ 背景库（上传/预览/删除）+ AI 辅助写剧本 + 开始演出
 * （剧本→角色卡→立绘集→语音→覆盖背景）+ 存档列表（多周目）。
 * 演出在独立剧情窗进行（galgame 式），与聊天系统完全分离。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronUp, Download, FilePlus2, FolderOpen, HardDrive, ImagePlus, Music, Pause, Pencil, Play, RotateCcw, Save, Sparkles, Trash2, Type, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../api'
import { useSettingsStore, typingSpeedToMs } from '../../store/settingsStore'
import { SelectMenu } from '../../components/DropdownMenu'
import { Button, Slider, Switch } from '../../components/ui'
import { cn } from '../../lib/utils'
import { TabBar, type TabItem } from '../components/TabBar'
import { usePersistedTab } from '../components/usePersistedTab'
import type { CharacterCard, CharacterSprite, ScriptIndexItem, StoryRunIndexItem, StoryVoiceConfig, TTSModelCard } from '../../types'

interface ScriptCardItem extends ScriptIndexItem {
  card: CharacterCard | null
}

/** 二级 tab：演出（高频）/ 剧本 / 素材 / 设置 */
const STORY_TAB_IDS = ['perform', 'script', 'asset', 'settings'] as const
type StoryTab = (typeof STORY_TAB_IDS)[number]
const STORY_TABS: readonly TabItem<StoryTab>[] = [
  { id: 'perform', label: '演出' },
  { id: 'script', label: '剧本' },
  { id: 'asset', label: '素材' },
  { id: 'settings', label: '设置' },
]

// 文字速度档位的默认值（与 settingsStore DEFAULT_SETTINGS.textSpeed 保持一致）
const DEFAULT_TEXT_SPEED = 80
/** 样本演示文案 */
const SAMPLE_TEXT = '（她把靠窗的位置往里让了让，「这个位置看雨最好看。」）'

/** 「开始演出」表单的本地持久化键：跨设置 tab / 重启保留上次选择 */
const START_FORM_KEY = 'story-start-form:v1'

/** 「开始演出」表单的可持久化字段（与 run 存档无关，仅界面预选值） */
interface PersistedStartForm {
  scriptId: string
  cardId: string
  spriteId: string
  voiceEnabled: boolean
  voiceEngine: 'genie' | 'sbv2'
  voiceModelId: string
  voiceLang: 'zh' | 'ja'
  backgroundOverride: string
}

/** 读取上次「开始演出」表单；损坏/旧数据回退默认值 */
function loadStartForm(): PersistedStartForm {
  const fallback: PersistedStartForm = {
    scriptId: '',
    cardId: '',
    spriteId: '',
    voiceEnabled: false,
    voiceEngine: 'genie',
    voiceModelId: '',
    voiceLang: 'zh',
    backgroundOverride: '',
  }
  try {
    const raw = localStorage.getItem(START_FORM_KEY)
    if (!raw) return fallback
    const data = JSON.parse(raw) as Partial<PersistedStartForm> | null
    return {
      scriptId: typeof data?.scriptId === 'string' ? data.scriptId : '',
      cardId: typeof data?.cardId === 'string' ? data.cardId : '',
      spriteId: typeof data?.spriteId === 'string' ? data.spriteId : '',
      voiceEnabled: data?.voiceEnabled === true,
      voiceEngine: data?.voiceEngine === 'sbv2' ? 'sbv2' : 'genie',
      voiceModelId: typeof data?.voiceModelId === 'string' ? data.voiceModelId : '',
      voiceLang: data?.voiceLang === 'ja' ? 'ja' : 'zh',
      backgroundOverride: typeof data?.backgroundOverride === 'string' ? data.backgroundOverride : '',
    }
  } catch {
    return fallback
  }
}

/** 文字样本预览：按当前速度档逐字打出，带闪烁光标，打完暂停 1 秒自动重播（与通用设置同款行为） */
function TextSpeedSample({ speed }: { speed: number }) {
  const delay = typingSpeedToMs(speed)
  const cur = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const [visible, setVisible] = useState(0)

  useEffect(() => {
    cur.current = 0
    setVisible(0)
    setEpoch((e) => e + 1)
  }, [speed])

  useEffect(() => {
    if (delay <= 0) {
      setVisible(SAMPLE_TEXT.length)
      return
    }
    let alive = true
    const iv = setInterval(() => {
      cur.current += 1
      if (cur.current >= SAMPLE_TEXT.length) {
        setVisible(SAMPLE_TEXT.length)
        clearInterval(iv)
        setTimeout(() => {
          if (!alive) return
          cur.current = 0
          setVisible(0)
          setEpoch((e) => e + 1)
        }, 1000)
      } else {
        setVisible(cur.current)
      }
    }, delay)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [delay, epoch])

  return (
    <span className="whitespace-pre-wrap break-words">
      {SAMPLE_TEXT.slice(0, visible)}
      {visible < SAMPLE_TEXT.length && <span className="streaming-cursor" />}
    </span>
  )
}

export function StoryPanel() {
  /** 二级 tab：记在 localStorage，切面板/重启后回到原处 */
  const [tab, setTab] = usePersistedTab<StoryTab>('story-tab', STORY_TAB_IDS, 'perform')
  // 剧情窗文字速度：独立设置（storyTextSpeed），不影响桌宠/聊天窗的通用 textSpeed
  const textSpeed = useSettingsStore((s) => s.settings.storyTextSpeed ?? DEFAULT_TEXT_SPEED)
  const saveSettings = useSettingsStore((s) => s.save)
  const [scripts, setScripts] = useState<ScriptCardItem[] | null>(null)
  const [runs, setRuns] = useState<StoryRunIndexItem[]>([])
  /** 语音缓存占用统计（进入设置 tab 时刷新） */
  const [voiceCache, setVoiceCache] = useState<{ count: number; bytes: number; maxBytes: number; dir: string } | null>(null)
  const [cleaningVoice, setCleaningVoice] = useState(false)
  /** 重看时是否允许补充合成（关闭 = 缺语音静默跳过，不产生费用） */
  const [allowRereadSynth, setAllowRereadSynthState] = useState(
    () => localStorage.getItem('story-allow-reread-synth') === '1',
  )
  const setAllowRereadSynth = (v: boolean) => {
    setAllowRereadSynthState(v)
    localStorage.setItem('story-allow-reread-synth', v ? '1' : '0')
  }

  /** 当前活跃演出（主进程内存态）。与存档的 status 不同：后者只表示「未完结」 */
  const [activeRunInfo, setActiveRunInfo] = useState<
    { runId: string; scriptId: string; chapterIndex: number; chapterCount: number } | null
  >(null)
  const [cards, setCards] = useState<CharacterCard[]>([])
  // null = 加载中（立绘列表异步加载完成前不显示"尚未导入"警告，避免进页面时警告闪烁）
  const [sprites, setSprites] = useState<CharacterSprite[] | null>(null)
  const [ttsModels, setTtsModels] = useState<TTSModelCard[]>([])
  const [backgrounds, setBackgrounds] = useState<string[]>([])
  const [musics, setMusics] = useState<string[]>([])
  /** 列表首次加载完成：校验/恢复持久化 id 前必须等列表到位，避免把有效选择清空 */
  const [listsLoaded, setListsLoaded] = useState(false)

  // ---- 开始演出表单（初始值来自 localStorage，跨设置 tab / 重启保留） ----
  const [initialStartForm] = useState<PersistedStartForm>(loadStartForm)
  const [scriptId, setScriptId] = useState(initialStartForm.scriptId)
  const [cardId, setCardId] = useState(initialStartForm.cardId)
  const [spriteId, setSpriteId] = useState(initialStartForm.spriteId)
  const [voiceEnabled, setVoiceEnabled] = useState(initialStartForm.voiceEnabled)
  const [voiceEngine, setVoiceEngine] = useState<'genie' | 'sbv2'>(initialStartForm.voiceEngine)
  const [voiceModelId, setVoiceModelId] = useState(initialStartForm.voiceModelId)
  const [voiceLang, setVoiceLang] = useState<'zh' | 'ja'>(initialStartForm.voiceLang)
  /** 覆盖背景（'' = 不覆盖；本次演出强制使用，优先级高于剧本指令，随 run 存档） */
  const [backgroundOverride, setBackgroundOverride] = useState(initialStartForm.backgroundOverride)
  const [starting, setStarting] = useState(false)

  // ---- AI 辅助写剧本（草稿可编辑，校验通过后手动导入） ----
  const [premise, setPremise] = useState('')
  const [draftCardId, setDraftCardId] = useState('')
  /** 状态词表来源（AI 写剧本的 emotion 值域；空 = 跟随参考角色卡绑定，再退内置最小词表） */
  const [draftSpriteSetId, setDraftSpriteSetId] = useState('')
  const [draft, setDraft] = useState('')
  const [draftErrors, setDraftErrors] = useState<Array<{ file: string; message: string }>>([])
  const [generating, setGenerating] = useState(false)
  const [importingDraft, setImportingDraft] = useState(false)

  const refresh = async () => {
    try {
      const [list, runList, cardList, spriteList, ttsList, bgList, musicList, activeRun] = await Promise.all([
        api.story.list(),
        api.story.listRuns(),
        api.characterCard.list(),
        api.sprite.list(),
        api.ttsModel.list(),
        api.story.listBackgrounds(),
        api.story.listMusics(),
        api.story.getActiveRun().catch(() => null),
      ])
      const enriched: ScriptCardItem[] = list.map((s) => ({
        ...s,
        card: s.characterCardId ? (cardList.find((c) => c.id === s.characterCardId) ?? null) : null,
      }))
      setScripts(enriched)
      setRuns(runList)
      setActiveRunInfo(activeRun)
      setCards(cardList)
      setSprites(spriteList)
      setTtsModels(ttsList)
      setBackgrounds(bgList)
      setMusics(musicList)
      setListsLoaded(true)
    } catch (err) {
      console.error('加载剧情数据失败', err)
    }
  }

  // 语音缓存统计：切到设置 tab 时刷新（清理后也会回写）
  useEffect(() => {
    if (tab !== 'settings') return
    void api.story.voiceCacheStats().then(setVoiceCache).catch(() => {})
  }, [tab])

  const openVoiceCacheDir = async () => {
    const err = await api.story.voiceCacheOpen()
    if (err) toast.error(err)
  }

  const cleanVoiceCacheAction = async (opts: { olderThanDays?: number; all?: boolean }) => {
    setCleaningVoice(true)
    try {
      const res = await api.story.voiceCacheClean(opts)
      setVoiceCache(res.stats)
      toast.success(res.removed > 0 ? `已清理 ${res.removed} 条语音` : '没有需要清理的语音')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清理失败')
    } finally {
      setCleaningVoice(false)
    }
  }

  useEffect(() => {
    void refresh()
    // 实时刷新：引擎在开始/暂停/完结/章节切换时广播 story:state，存档列表随之更新
    const unsub = api.story.onState(() => void refresh())
    return unsub
  }, [])

  // 剧本默认值：持久化/当前值有效则保留；失效或未选时落到第一个
  useEffect(() => {
    if (!listsLoaded || !scripts) return
    setScriptId((cur) => (cur && scripts.some((s) => s.id === cur) ? cur : (scripts[0]?.id ?? '')))
  }, [listsLoaded, scripts])

  // 角色卡默认值：当前值有效则保留（持久化恢复）；失效时优先剧本绑定，再落第一张
  useEffect(() => {
    if (!listsLoaded || !scripts) return
    const script = scripts.find((s) => s.id === scriptId)
    const suggested =
      script?.characterCardId && cards.some((c) => c.id === script.characterCardId) ? script.characterCardId : null
    setCardId((cur) => (cur && cards.some((c) => c.id === cur) ? cur : (suggested ?? cards[0]?.id ?? '')))
  }, [listsLoaded, scripts, cards, scriptId])

  // 立绘默认值：只在当前值失效（未选 / 已被删）时兜底到第一个。
  // 不再跟随角色卡联动 —— 换角色卡会悄悄改掉已选好的立绘集，多角色共用一套立绘时很反直觉。
  useEffect(() => {
    if (!listsLoaded || !sprites) return
    setSpriteId((cur) => (cur && sprites.some((s) => s.id === cur) ? cur : (sprites[0]?.id ?? '')))
  }, [listsLoaded, sprites])

  // 候选声库按引擎分组：Genie 卡与 SBV2 卡共用同一份卡池，选错会走错合成通道
  const voiceCards = useMemo(
    () => ttsModels.filter((m) => (m.engine ?? 'genie') === voiceEngine),
    [ttsModels, voiceEngine],
  )

  // 声库默认值：当前选中项不属于当前引擎时，自动落到该引擎的第一张卡
  useEffect(() => {
    if (!listsLoaded) return
    if (!voiceCards.some((m) => m.id === voiceModelId)) {
      setVoiceModelId(voiceCards[0]?.id ?? '')
    }
  }, [listsLoaded, voiceCards, voiceModelId])

  // 覆盖背景：持久化值指向的背景已被删除时清空，避免下拉停在失效项
  useEffect(() => {
    if (!listsLoaded) return
    setBackgroundOverride((cur) => {
      if (!cur) return ''
      const name = cur.startsWith('user:') ? cur.slice('user:'.length) : ''
      return name && backgrounds.includes(name) ? cur : ''
    })
  }, [listsLoaded, backgrounds])

  // 开始演出表单变化即落盘：切到其它设置面板再回来 / 重启应用时恢复上次选择
  useEffect(() => {
    const form: PersistedStartForm = {
      scriptId,
      cardId,
      spriteId,
      voiceEnabled,
      voiceEngine,
      voiceModelId,
      voiceLang,
      backgroundOverride,
    }
    try {
      localStorage.setItem(START_FORM_KEY, JSON.stringify(form))
    } catch {
      // localStorage 不可用（隐私模式/配额满）时静默，不影响本次表单使用
    }
  }, [scriptId, cardId, spriteId, voiceEnabled, voiceEngine, voiceModelId, voiceLang, backgroundOverride])

  /** 切引擎：重置声线为该引擎的第一张卡；SBV2 只读日文，语言一并拨到日文 */
  const applyVoiceEngine = (next: 'genie' | 'sbv2') => {
    setVoiceEngine(next)
    const pool = ttsModels.filter((m) => (m.engine ?? 'genie') === next)
    setVoiceModelId(pool[0]?.id ?? '')
    if (next === 'sbv2') setVoiceLang('ja')
  }

  /** 切剧本：剧本绑定了有效角色卡则同步过去；没有绑定则保留当前有效选择 */
  const handleScriptChange = (next: string) => {
    setScriptId(next)
    const script = scripts?.find((s) => s.id === next)
    const suggested =
      script?.characterCardId && cards.some((c) => c.id === script.characterCardId) ? script.characterCardId : null
    if (suggested) setCardId(suggested)
  }

  const voice: StoryVoiceConfig | null =
    voiceEnabled && voiceModelId
      ? {
          ttsModelId: voiceModelId,
          // SBV2 恒定日文，忽略界面上的中文选择
          language: voiceEngine === 'sbv2' ? 'ja' : voiceLang,
          engine: voiceEngine,
        }
      : null

  const handleImport = async () => {
    const report = await api.story.import()
    if (report.ok) {
      toast.success('剧本导入成功')
      await refresh()
    } else if (report.errors.length && report.errors[0]?.message !== '已取消') {
      toast.error(report.errors.map((e) => `${e.file}: ${e.message}`).join('\n'), { duration: 8000 })
    }
  }

  const handleRemove = async (id: string, title: string) => {
    if (!window.confirm(`删除剧本「${title}」？其资源目录将被移除（run 存档保留但无法继续演出）。`)) return
    const res = await api.story.remove(id)
    if (res.ok) {
      toast.success('剧本已删除')
      await refresh()
    } else {
      toast.error(res.error ?? '删除失败')
    }
  }

  /** 开始演出：新建 run 从头演（覆盖背景随 run 存档，resume 沿用） */
  const handleStart = async () => {
    // 列表/持久化值校验完成前不允许启动，避免用已失效的旧 id 起一场空演出
    if (!listsLoaded || !scriptId || !cardId || !spriteId || starting) return
    setStarting(true)
    try {
      const res = await api.story.start({
        scriptId,
        cardId,
        spriteId,
        voice,
        mode: 'start',
        backgroundOverride: backgroundOverride || null,
      })
      if (!res.ok) {
        toast.error(res.error ?? '剧情启动失败')
        return
      }
      api.story.openWindow()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '剧情启动失败')
    } finally {
      setStarting(false)
    }
  }

  /** 背景库：上传（多选） */
  const handleUploadBackgrounds = async () => {
    const res = await api.story.uploadBackgrounds()
    if (!res.ok) {
      toast.error(res.error ?? '背景导入失败')
      return
    }
    if (res.added && res.added.length > 0) {
      toast.success(`已导入 ${res.added.length} 张背景`)
      await refresh()
    }
  }

  const handleRemoveBackground = async (name: string) => {
    if (!window.confirm(`删除背景「${name}」？引用它的剧本与存档将回退为无背景。`)) return
    const res = await api.story.removeBackground(name)
    if (res.ok) {
      setBackgroundOverride((cur) => (cur === `user:${name}` ? '' : cur))
      await refresh()
    } else {
      toast.error(res.error ?? '删除失败')
    }
  }

  /** 音乐库：上传（多选） */
  const handleUploadMusics = async () => {
    const res = await api.story.uploadMusics()
    if (!res.ok) {
      toast.error(res.error ?? '音乐导入失败')
      return
    }
    if (res.added && res.added.length > 0) {
      toast.success(`已导入 ${res.added.length} 首音乐`)
      await refresh()
    }
  }

  const handleRemoveMusic = async (name: string) => {
    if (!window.confirm(`删除音乐「${name}」？引用它的剧本将无法播放该 BGM（播放时静默跳过）。`)) return
    if (playingMusic === name) stopMusicPreview()
    const res = await api.story.removeMusic(name)
    if (res.ok) {
      await refresh()
    } else {
      toast.error(res.error ?? '删除失败')
    }
  }

  // ---- 音乐库预览播放（单实例；与剧情窗 BGM 完全独立，互不影响音量/播放） ----
  const musicAudio = useMemo(() => new Audio(), [])
  const [playingMusic, setPlayingMusic] = useState<string | null>(null)
  const [musicPaused, setMusicPaused] = useState(false)
  const [musicProgress, setMusicProgress] = useState({ cur: 0, dur: 0 })

  // audio 事件绑定（一次）：进度 / 时长 / 播放态 / 播完复位；卸载时暂停。
  // 拖动进度条期间屏蔽 timeupdate（seek 是异步的，旧播放位置会把受控滑块弹回去）
  const seekingRef = useRef(false)
  useEffect(() => {
    const a = musicAudio
    const onTime = () => {
      if (seekingRef.current) return
      setMusicProgress({ cur: a.currentTime, dur: Number.isFinite(a.duration) ? a.duration : 0 })
    }
    const onMeta = () => setMusicProgress((p) => ({ ...p, dur: Number.isFinite(a.duration) ? a.duration : 0 }))
    const onEnd = () => {
      setPlayingMusic(null)
      setMusicProgress({ cur: 0, dur: 0 })
    }
    const onPlay = () => setMusicPaused(false)
    const onPause = () => setMusicPaused(true)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('ended', onEnd)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    return () => {
      a.pause()
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('ended', onEnd)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
    }
  }, [musicAudio])

  const toggleMusicPlay = (name: string) => {
    const a = musicAudio
    if (playingMusic === name) {
      // 同一首：播放/暂停切换（暂停保留进度）
      if (a.paused) void a.play().catch(() => toast.error('播放失败'))
      else a.pause()
      return
    }
    // 换曲：重设 src 从头播放
    a.src = api.story.musicUrl(name)
    void a.play().catch(() => toast.error('播放失败'))
    setPlayingMusic(name)
    setMusicProgress({ cur: 0, dur: 0 })
  }

  const stopMusicPreview = () => {
    musicAudio.pause()
    musicAudio.removeAttribute('src')
    setPlayingMusic(null)
    setMusicProgress({ cur: 0, dur: 0 })
  }

  const seekMusic = (v: number) => {
    if (!Number.isFinite(v)) return
    const a = musicAudio
    // readyState < 1（还没拿到元数据）时设置 currentTime 会抛错或被忽略
    if (a.readyState < 1) return
    try {
      a.currentTime = v
      setMusicProgress((p) => ({ ...p, cur: v }))
    } catch {
      // 极端情况（音频已被移除）忽略，下个 timeupdate 会纠正显示
    }
  }

  /** AI 生成剧本草稿（产物仅回显编辑，不直接入库）；状态词表按所选立绘集（缺省跟随参考角色卡绑定） */
  const handleGenerateDraft = async () => {
    if (!premise.trim() || generating) return
    setGenerating(true)
    try {
      // 词表来源：显式选择 > 参考角色卡绑定的立绘集 > 内置最小词表（主进程侧兜底）
      const card = cards.find((c) => c.id === draftCardId)
      const effSpriteSetId = draftSpriteSetId || card?.spriteId || null
      const res = await api.story.generateDraft({ premise: premise.trim(), cardId: draftCardId || null, spriteSetId: effSpriteSetId })
      if (!res.ok) {
        toast.error(res.error ?? '生成失败')
        return
      }
      setDraft(res.draft ?? '')
      setDraftErrors(res.errors)
      if (res.errors.length === 0) toast.success('草稿已生成，校验通过，可直接导入')
      else toast.error(`草稿已生成，但有 ${res.errors.length} 处校验问题，请修正后再导入`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  /** 导入草稿：schema 全量校验通过后拆分写入剧本库 */
  const handleImportDraft = async () => {
    if (!draft.trim() || importingDraft) return
    setImportingDraft(true)
    try {
      const res = await api.story.importDraft(draft)
      if (!res.ok) {
        setDraftErrors(res.errors)
        toast.error(res.error ?? (res.errors.length > 0 ? `校验未通过（${res.errors.length} 处问题）` : '导入失败'))
        return
      }
      toast.success(`剧本已导入：${res.scriptId}`)
      setDraft('')
      setDraftErrors([])
      setPremise('')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImportingDraft(false)
    }
  }

  /** 继续演出：按 runId 从游标续玩 */
  /** 打开只读重看（不启动引擎，按事件日志重演当时顺序） */
  const openReplay = async (runId: string) => {
    const res = await api.story.openReplay(runId)
    if (!res.ok) toast.error(res.error ?? '无法打开重看')
  }

  const handleResume = async (run: StoryRunIndexItem) => {
    const res = await api.story.start({
      scriptId: run.scriptId,
      cardId: run.cardId,
      spriteId: run.spriteId,
      voice: run.voice,
      mode: 'resume',
      runId: run.runId,
    })
    if (!res.ok) {
      toast.error(res.error ?? '继续失败')
      return
    }
    api.story.openWindow()
  }

  /** 重新开始：用 run 的配置新建一个 run 从头演（多周目） */
  const handleRestart = async (run: StoryRunIndexItem) => {
    const res = await api.story.start({
      scriptId: run.scriptId,
      cardId: run.cardId,
      spriteId: run.spriteId,
      voice: run.voice,
      mode: 'start',
    })
    if (!res.ok) {
      toast.error(res.error ?? '重新开始失败')
      return
    }
    api.story.openWindow()
  }

  const handleDeleteRun = async (run: StoryRunIndexItem) => {
    if (!window.confirm(`删除「${run.scriptTitle}」的这条存档？不可恢复。`)) return
    const res = await api.story.deleteRun(run.runId)
    if (res.ok) {
      toast.success('存档已删除')
      await refresh()
    }
  }

  /**
   * tab 栏「演出中」状态点。
   * 以主进程内存态为准（activeRunInfo）：存档的 status==='running' 只表示「这场演出未完结」，
   * 应用重启或闲置的旧存档都会一直为 true，用它判断会误报。
   * 章节进度取内存态（实时），其余字段（剧本名/角色卡/语音）从存档条目补全，供 resume 使用。
   */
  const runningMeta = activeRunInfo ? (runs.find((r) => r.runId === activeRunInfo.runId) ?? null) : null
  const running =
    runningMeta && activeRunInfo
      ? { ...runningMeta, chapterIndex: activeRunInfo.chapterIndex, chapterCount: activeRunInfo.chapterCount }
      : null
  const canStart = listsLoaded && !!scriptId && !!cardId && !!spriteId && !starting

  return (
    <div className="space-y-5">
      {/* 二级 tab：把 7 个分区里的主操作提到第一屏 */}
      <TabBar
        tabs={STORY_TABS}
        value={tab}
        onChange={setTab}
        right={
          running ? (
            <button
              type="button"
              onClick={() => void handleResume(running)}
              title="回到剧情窗继续这场演出"
              className="inline-flex max-w-[280px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--success)]/30 bg-[var(--success)]/10 px-2.5 py-1.5 text-[11px] text-[var(--success)] transition-colors hover:bg-[var(--success)]/15"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
              <span className="truncate">
                演出中（{running.scriptTitle}）· 第 {running.chapterIndex + 1}/{running.chapterCount} 章
              </span>
            </button>
          ) : undefined
        }
      />

      {/* 剧本库 */}
      {tab === 'script' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
              <BookOpen size={15} className="text-primary-400" />
              剧本库
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void api.story.editorCreate().then(async (r) => {
                  if (r.ok) {
                    await refresh()
                  } else if (r.error) {
                    toast.error(r.error)
                  }
                })}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border px-3 py-1.5 text-xs font-medium text-text transition-all hover:bg-card-hover"
              >
                <FilePlus2 size={12} strokeWidth={2} />
                新增剧本
              </button>
              <button
                onClick={() => void handleImport()}
                className="bg-brand-gradient inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110"
              >
                <Upload size={12} strokeWidth={2} />
                导入剧本（zip）
              </button>
            </div>
          </div>
          {scripts === null ? (
            <p className="py-6 text-center text-xs text-text-muted">加载中…</p>
          ) : scripts.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-muted">还没有剧本，点右上角「导入剧本」选择 zip 包</p>
          ) : (
            <div className="max-h-[17.5rem] overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {scripts.map((s) => (
                <div key={s.id} className="rounded-[var(--radius-lg)] border border-border p-2.5">
                  <p className="truncate text-xs font-medium text-text">{s.title}</p>
                  <p className="mt-0.5 line-clamp-2 min-h-[2rem] text-[11px] leading-relaxed text-text-muted">{s.summary || '暂无简介'}</p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-text-muted">{s.chapters} 章{s.card ? ` · ${s.card.name}` : ''}</span>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => void api.story.openEditor(s.id)}
                        title="可视化编辑（7.6）"
                        className="rounded p-1 text-text-muted hover:bg-card-hover hover:text-text"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => void api.story.export(s.id).then((r) => {
                          if (r.ok && r.path) toast.success(`已导出：${r.path}`)
                          if (!r.ok && r.error) toast.error(r.error)
                        })}
                        title="导出 zip"
                        className="rounded p-1 text-text-muted hover:bg-card-hover hover:text-text"
                      >
                        <Download size={12} />
                      </button>
                      <button
                        onClick={() => void handleRemove(s.id, s.title)}
                        title="删除剧本"
                        className="rounded p-1 text-text-muted hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 背景库（设计文档 7.3：剧本 background 事件 / 覆盖背景以 user:文件名 引用） */}
      {tab === 'asset' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
              <ImagePlus size={15} className="text-primary-400" />
              背景库
            </h3>
            <button
              onClick={() => void handleUploadBackgrounds()}
              className="bg-brand-gradient inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110"
            >
              <Upload size={12} strokeWidth={2} />
              上传背景图
            </button>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-text-muted">
            上传的背景可在「开始演出 → 覆盖背景」中选用；剧本里用 <code className="rounded bg-[var(--bg-surface)] px-1">image: user:文件名</code> 引用。
          </p>
          {backgrounds.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">还没有背景图，点右上角「上传背景图」选择本地图片（可多选）</p>
          ) : (
            <div className="max-h-[14.5rem] overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {backgrounds.map((name) => (
                <div key={name} className="group relative overflow-hidden rounded-[var(--radius-lg)] border border-border">
                  <img src={api.story.assetUrl('', `user:${name}`)} alt={name} loading="lazy" className="h-20 w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/50 px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="truncate text-[10px] text-white">{name}</span>
                    <button onClick={() => void handleRemoveBackground(name)} title="删除背景" className="rounded p-0.5 text-white/80 hover:text-danger">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 音乐库（与背景库同模式：music 事件以 user:文件名 引用） */}
      {tab === 'asset' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
              <Music size={15} className="text-primary-400" />
              音乐库
            </h3>
            <button
              onClick={() => void handleUploadMusics()}
              className="bg-brand-gradient inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110"
            >
              <Upload size={12} strokeWidth={2} />
              上传音乐
            </button>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-text-muted">
            上传的音乐可在编辑器「音乐」事件中选用；剧本里用 <code className="rounded bg-[var(--bg-surface)] px-1">file: user:文件名</code> 引用。
          </p>
          {musics.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">还没有音乐，点右上角「上传音乐」选择本地音频（可多选）</p>
          ) : (
            <div className="max-h-[13rem] overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
              {musics.map((name) => {
                const active = playingMusic === name
                const fmt = (s: number) => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00')
                return (
                  <div key={name} className={cn('group overflow-hidden rounded-[var(--radius-md)] border px-2.5 py-1.5 transition-colors', active ? 'border-primary-400/40 bg-primary-500/5' : 'border-border')}>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => toggleMusicPlay(name)}
                        title={active && !musicPaused ? '暂停' : '播放'}
                        className="shrink-0 rounded-full p-1 text-primary-400 transition-colors hover:bg-primary-500/10"
                      >
                        {active && !musicPaused ? <Pause size={12} /> : <Play size={12} />}
                      </button>
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-text">
                        <Music size={12} className="shrink-0 text-primary-400" />
                        <span className="min-w-0 truncate">{name}</span>
                      </span>
                      <button
                        onClick={() => void handleRemoveMusic(name)}
                        title="删除音乐"
                        className="shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {active && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={musicProgress.dur || 0}
                          step={0.1}
                          value={musicProgress.cur}
                          onPointerDown={() => (seekingRef.current = true)}
                          onPointerUp={() => (seekingRef.current = false)}
                          onPointerCancel={() => (seekingRef.current = false)}
                          onBlur={() => (seekingRef.current = false)}
                          onChange={(e) => seekMusic(Number(e.target.value))}
                          className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--primary-400)]"
                        />
                        <span className="shrink-0 text-[10px] tabular-nums text-text-2">
                          {fmt(musicProgress.cur)} / {fmt(musicProgress.dur)}
                        </span>
                        <button
                          onClick={stopMusicPreview}
                          title="收起播放条（停止预览）"
                          className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-card-hover hover:text-text"
                        >
                          <ChevronUp size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* AI 辅助写剧本（设计文档 7.4：梗概 → 草稿回显编辑 → 校验通过后手动导入） */}
      {tab === 'script' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-text">
            <Sparkles size={15} className="text-primary-400" />
            AI 辅助写剧本
          </h3>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">剧本梗概（故事背景、场景、期望的情绪走向）</span>
              <textarea
                value={premise}
                onChange={(e) => setPremise(e.target.value)}
                rows={3}
                placeholder="例：梅雨季的旧书店，她整理一批旧信件时读到一段几十年前的暗恋告白，两人聊起「没有寄出的信」…"
                className="w-full resize-none rounded-[var(--radius-md)] border border-border bg-transparent px-3 py-2 text-sm leading-relaxed text-text outline-none placeholder:text-text-2 focus:border-[var(--primary-400)]"
              />
            </label>
            <label className="flex items-center gap-3">
              <span className="shrink-0 text-xs text-text-muted">参考角色卡（可选，台词风格贴合人设）</span>
              <SelectMenu
                value={draftCardId}
                onChange={setDraftCardId}
                options={[
                  { value: '', label: '不参考' },
                  ...cards.map((c) => ({ value: c.id, label: c.name })),
                ]}
                className="min-w-0 flex-1"
              />
            </label>
            <label className="flex items-center gap-3">
              <span className="shrink-0 text-xs text-text-muted">状态词表来源（emotion 值域）</span>
              <SelectMenu
                value={draftSpriteSetId}
                onChange={setDraftSpriteSetId}
                options={[
                  { value: '', label: '跟随参考角色卡绑定' },
                  ...(sprites ?? []).map((s) => ({ value: s.id, label: s.name })),
                ]}
                className="min-w-0 flex-1"
              />
            </label>
            <button
              onClick={() => void handleGenerateDraft()}
              disabled={!premise.trim() || generating}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--primary-400)]/50 bg-primary-500/10 py-2 text-sm font-medium text-primary-400 transition-all hover:bg-primary-500/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles size={13} />
              {generating ? '生成中…（整部剧本约需十几秒）' : '生成剧本草稿（YAML）'}
            </button>
            {draft && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-2">草稿（可手动编辑；第一列为 story.yaml 元信息，chapters 按顺序拆分入库）</span>
                  <button
                    onClick={() => void handleImportDraft()}
                    disabled={importingDraft}
                    className="bg-brand-gradient inline-flex items-center gap-1 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110 disabled:opacity-40"
                  >
                    <Download size={11} className="rotate-180" />
                    {importingDraft ? '导入中…' : '校验并导入剧本库'}
                  </button>
                </div>
                {draftErrors.length > 0 && (
                  <div className="max-h-24 space-y-1 overflow-y-auto rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2">
                    {draftErrors.map((e, i) => (
                      <p key={i} className="text-[11px] leading-relaxed text-danger">
                        {e.file ? `${e.file}：` : ''}{e.message}
                      </p>
                    ))}
                  </div>
                )}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full resize-y rounded-[var(--radius-md)] border border-border bg-[var(--bg-surface)]/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-text outline-none focus:border-[var(--primary-400)]"
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* 开始演出 */}
      {tab === 'perform' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-text">
            <Play size={15} className="text-primary-400" />
            开始演出
          </h3>
          {sprites !== null && sprites.length === 0 && (
            <p className="mb-3 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              尚未导入任何 2D 立绘集（剧情演出必选）。请先在「角色模型」或立绘管理中导入立绘集。
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">剧本</span>
              <SelectMenu
                value={scriptId}
                onChange={handleScriptChange}
                options={(scripts ?? []).map((s) => ({ value: s.id, label: s.title }))}
                className="w-full"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">角色卡</span>
              <SelectMenu
                value={cardId}
                onChange={setCardId}
                options={cards.map((c) => ({ value: c.id, label: c.name }))}
                className="w-full"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">2D 立绘集（必选）</span>
              <SelectMenu
                value={spriteId}
                onChange={setSpriteId}
                options={(sprites ?? []).map((s) => ({ value: s.id, label: s.name }))}
                className="w-full"
              />
              {/* 开演前一致性提示（P1，不阻塞）：剧本创作词表与本次演出词表不同 → 事件状态词可能降级 */}
              {(() => {
                const script = scripts?.find((s) => s.id === scriptId)
                if (!script?.spriteSetId || !spriteId || script.spriteSetId === spriteId) return null
                const boundName = sprites?.find((s) => s.id === script.spriteSetId)?.name ?? script.spriteSetId
                const perfName = sprites?.find((s) => s.id === spriteId)?.name ?? spriteId
                return (
                  <span className="mt-1.5 block rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-500">
                    剧本按「{boundName}」的词表创作，本次演出用「{perfName}」——事件中不在演出词表内的状态词将降级为默认图。仍可演出（换皮重演属合法玩法）。
                  </span>
                )
              })()}
            </label>
            <div>
              <span className="mb-1 block text-xs text-text-muted">语音（与角色卡声音模块无关）</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setVoiceEnabled((v) => !v)}
                  className={cnToggle(voiceEnabled)}
                >
                  {voiceEnabled ? '已启用' : '不启用'}
                </button>
                {voiceEnabled && (
                  <>
                    <SelectMenu
                      value={voiceEngine}
                      onChange={(v) => applyVoiceEngine(v as 'genie' | 'sbv2')}
                      options={[
                        { value: 'genie', label: 'Genie-TTS' },
                        { value: 'sbv2', label: '本地 SBV2' },
                      ]}
                    />
                    <SelectMenu
                      value={voiceModelId}
                      onChange={setVoiceModelId}
                      options={voiceCards.map((m) => ({ value: m.id, label: m.name || m.characterName }))}
                      className="min-w-0 flex-1"
                    />
                    <SelectMenu
                      value={voiceEngine === 'sbv2' ? 'ja' : voiceLang}
                      onChange={(v) => setVoiceLang(v as 'zh' | 'ja')}
                      disabled={voiceEngine === 'sbv2'}
                      options={[
                        { value: 'zh', label: '中文' },
                        { value: 'ja', label: '日文' },
                      ]}
                    />
                  </>
                )}
              </div>
              {voiceEnabled && voiceCards.length === 0 && (
                <p className="mt-1 text-[11px] text-warning">
                  当前引擎还没有模型卡，请先到「设置 → 语音合成」里添加。
                </p>
              )}
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">覆盖背景（可选，本次演出强制使用）</span>
              <SelectMenu
                value={backgroundOverride}
                onChange={setBackgroundOverride}
                options={[
                  { value: '', label: '不覆盖（跟随剧本指令）' },
                  ...backgrounds.map((name) => ({ value: `user:${name}`, label: name })),
                ]}
                className="w-full"
              />
            </label>
          </div>
          <button
            onClick={() => void handleStart()}
            disabled={!canStart}
            className="bg-brand-gradient glow-primary mt-4 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] py-2.5 text-sm font-medium text-[var(--on-brand)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={14} strokeWidth={2} />
            {starting ? '启动中…' : '开始演出（新建存档）'}
          </button>
          <p className="mt-2 text-center text-[11px] text-text-muted">
            演出在独立剧情窗进行（galgame 式），对话记录只在剧情窗内可见，与聊天会话完全分离
          </p>
        </section>
      )}

      {/* 存档列表（多周目） */}
      {tab === 'perform' && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-text">
            <Save size={15} className="text-primary-400" />
            存档列表
          </h3>
          {runs.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">还没有存档</p>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <div key={r.runId} className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">
                      {r.scriptTitle}
                      <span className="ml-2 text-[11px] font-normal text-text-muted">
                        {r.cardName} · 第 {r.chapterIndex + 1}/{Math.max(r.chapterCount, 1)} 章
                        {r.status === 'ended' ? ' · 已完结' : ''}
                        {r.voice ? ` · 语音${r.voice.language === 'ja' ? '(日)' : '(中)'}` : ' · 无语音'}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-text-muted">更新于 {new Date(r.updatedAt).toLocaleString()}</p>
                  </div>
                  {r.status === 'running' && (
                    <button onClick={() => void handleResume(r)} title="继续演出" className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 text-xs text-text-2 hover:bg-card-hover hover:text-text">
                      <Play size={12} />
                      继续
                    </button>
                  )}
                  {/* 只给已完结的存档提供重看：未完结时语义模糊（用户真正想要的是"继续"），
                      且事件日志可能因中途退出而不完整，容易播到一半就结束 */}
                  {r.status === 'ended' && (
                    <button onClick={() => void openReplay(r.runId)} title="按当时的顺序重看这场剧情（不重新生成，语音优先用缓存）" className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 text-xs text-text-2 hover:bg-card-hover hover:text-text">
                      <BookOpen size={12} />
                      重看
                    </button>
                  )}
                  <button onClick={() => void handleRestart(r)} title="用相同配置重新开始（多周目）" className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 text-xs text-text-2 hover:bg-card-hover hover:text-text">
                    <RotateCcw size={12} />
                    重开
                  </button>
                  <button onClick={() => void handleDeleteRun(r)} title="删除存档" className="rounded-[var(--radius-md)] p-1.5 text-text-muted hover:bg-danger/10 hover:text-danger">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {/* 剧情系统自身的设置（后续新增也放这里） */}
      {tab === 'settings' && (
        <>
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-text">
            <Type size={15} className="text-primary-400" />
            文字显示速度
          </div>
          <div>
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-text-2">
                控制剧情窗对话框里文字的逐字显示快慢（剧情系统独立设置，与「通用设置」中桌宠/聊天窗的文字速度互不影响；数值越大越快）。
              </p>
              <Slider
                label="速度"
                value={textSpeed}
                min={1}
                max={100}
                step={1}
                defaultValue={DEFAULT_TEXT_SPEED}
                onChange={(v) => void saveSettings({ storyTextSpeed: Math.round(v) })}
                format={(v) => `${v}`}
              />
              <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-4 py-3">
                <div className="mb-1 text-xs text-text-2">显示文字样本</div>
                <div className="min-h-[2.5em] text-sm leading-relaxed text-text">
                  <TextSpeedSample speed={textSpeed} />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 语音缓存：合成结果落盘复用，这里只管占用与清理 */}
        <section className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-text">
            <HardDrive size={15} className="text-primary-400" />
            语音缓存
          </div>
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-text-2">
              合成过的台词会落盘复用（按内容去重）：同一句只合成一次，重看不必重算，云端声库也不再重复计费。
              超出上限时自动淘汰最久未使用的。
            </p>

            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-surface-2 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-text">
                  已占用 {fmtBytes(voiceCache?.bytes ?? 0)} · {voiceCache?.count ?? 0} 条
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  上限 {fmtBytes(voiceCache?.maxBytes ?? 0)}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => void openVoiceCacheDir()}>
                <FolderOpen size={12} strokeWidth={1.75} /> 打开文件夹
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cleaningVoice}
                onClick={() => void cleanVoiceCacheAction({ olderThanDays: 30 })}
              >
                清理 30 天未使用
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={cleaningVoice}
                onClick={() => void cleanVoiceCacheAction({ all: true })}
              >
                全部清空
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                <div className="text-xs text-text">重看时允许补充合成</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                  关闭时重看只播已有语音，缺的那句安静跳过（不产生费用）；开启则缺什么补什么
                </div>
              </div>
              <Switch checked={allowRereadSynth} onChange={setAllowRereadSynth} />
            </div>
          </div>
        </section>
        </>
      )}
    </div>
  )
}

/** 字节数格式化（语音缓存占用展示） */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 MB'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** 开关按钮样式 */
function cnToggle(on: boolean): string {
  return [
    'shrink-0 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors',
    on
      ? 'border-[var(--primary-400)] bg-primary-500/15 text-primary-400'
      : 'border-border text-text-muted hover:bg-card-hover hover:text-text',
  ].join(' ')
}

/**
 * Genie-TTS(https://github.com/High-Logic/Genie-TTS) Genie-TTS客户端。
 *
 * GENIE 是 GPT-SoVITS 的轻量 CPU 推理引擎（~200MB 运行时 / 模型），声库自带性格。
 * 官方提供 Python 库 `genie_tts` 与 FastAPI 服务，本模块据此对接官方 HTTP API。
 *
 * 官方接口（见 Tutorial/English/API Server Tutorial.py）：
 * - 加载角色  POST /load_character      { character_name(明文), onnx_model_dir, language }
 * - 参考音频  POST /set_reference_audio { character_name, audio_path, audio_text, language }
 * - 合成      POST /tts                 { character_name, text, split_sentence?, save_path? }
 *             返回 audio/wav 流（32kHz、1ch、int16，也可能是 RIFF/WAV）
 * - 停止任务  POST /stop
 * 语言码：en / zh / jp / ko（日语是 jp；Genie 官方语言码，见其官方 README/API，
 * 传 'ja' 反而会走错 G2P）。
 * 服务默认端口 8000（start_server(host, port=8000)）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { net } from 'electron'
import path from 'path'
import { existsSync, mkdirSync, promises as fs } from 'fs'
import { paths, readJson, writeJson } from './storage'
import { getSettings } from './repository'
import type { TTSGenieConfig } from '../../src/types'
import { translateWithCache } from './ttsTranslate'

/** 默认配置 */
const DEFAULT_CONFIG: TTSGenieConfig = {
  baseUrl: 'http://127.0.0.1:8000',
  workPath: '',
  dataDir: '',
}

/** 读取 GenieTTS 配置（合并默认值） */
export async function getGenieConfig(): Promise<TTSGenieConfig> {
  const current = await readJson<Partial<TTSGenieConfig>>(paths.ttsGenieConfigFile, DEFAULT_CONFIG)
  return { ...DEFAULT_CONFIG, ...current }
}

/** 保存 GenieTTS 配置（部分合并） */
export async function saveGenieConfig(patch: Partial<TTSGenieConfig>): Promise<TTSGenieConfig> {
  const current = await getGenieConfig()
  const next: TTSGenieConfig = { ...current, ...patch }
  await writeJson(paths.ttsGenieConfigFile, next)
  return next
}

/** 拼接可用的 baseUrl（去尾斜杠） */
function normUrl(baseUrl: string): string {
  return (baseUrl ?? DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '')
}

/** 从 baseUrl 解析端口（默认 8000） */
function parsePort(baseUrl: string): number {
  try {
    const p = Number(new URL(normUrl(baseUrl)).port)
    return p > 0 ? p : 8000
  } catch {
    return 8000
  }
}

/** 我们的语言码(zh/ja)映射为 genie 语言码(zh/jp)：Genie 官方日语是 'jp'（非 'ja'），见其官方 README/API。 */
function toGenieLang(lang: string): string {
  return lang === 'ja' ? 'jp' : lang
}

/**
 * 检测参考音频文本自身的语言：含日文假名 → 'ja'，否则 → 'zh'。
 * set_reference_audio 的 language 决定 prompt 文本用哪种 G2P 编码成条件音素，
 * 应标记参考音频的真实语言（与合成语言无关）——错标会导致条件音素与实际音频错乱，
 * 显著提高模型复诵参考音频（复读）的概率，也是跨语言克隆的正确性前提。
 */
function detectRefAudioLang(text: string): 'ja' | 'zh' {
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(text) ? 'ja' : 'zh'
}

/** 当前已加载的角色（避免重复加载） */
let loadedCharacter = ''

/** 合成串行化：并发合成（剧情窗 + 设置页试听）会让 load_character / /tts 交错，
 *  服务端推理状态被污染后会连锁失败（semantic_tokens None → 空音频）。 */
let synthChain: Promise<unknown> = Promise.resolve()

/** 兼容旧导入结构：onnxModelDir 误选角色根目录时，若其下存在 tts_models 子目录则自动下钻。
 *  （旧版导入曾把角色根目录存为模型目录，服务端会在根目录找 .onnx 报"文件不存在"） */
function normalizeOnnxModelDir(dir: string): string {
  try {
    if (dir && path.basename(dir) !== 'tts_models') {
      const sub = path.join(dir, 'tts_models')
      if (existsSync(sub)) return sub
    }
  } catch {
    /* ignore */
  }
  return dir
}

/** 探测 GenieTTS 服务是否在线 */
async function probe(url: string): Promise<boolean> {
  try {
    const resp = await net.fetch(`${normUrl(url)}/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    return resp.status < 500
  } catch {
    return false
  }
}

/** 健康检测。 */
export async function checkGenie(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  if (await probe(baseUrl).catch(() => false)) return { ok: true }
  return { ok: false, error: '无法连接 GenieTTS 服务。请先启动服务（或点【启动服务】），再重试检测。' }
}

/** 正在运行的服务进程句柄 */
let serverProcess: ChildProcess | null = null
/** 自动拉起互斥：多段合成并发触发时只启动一次（避免双实例 bind 10048 端口冲突） */
let startPromise: Promise<void> | null = null
/**
 * 用户手动点了【结束服务】：抑制合成路径的自动拉起，直到再次点【启动服务】
 * 或重启应用。不持久化 —— 否则下次启动会莫名其妙没声音。
 */
let manualStopped = false

/** 清理已拉起进程（用户主动停止，后续合成不再自动拉起） */
export function stopGenieServer(): void {
  manualStopped = true
  if (serverProcess) {
    try {
      serverProcess.kill()
    } catch {
      /* ignore */
    }
    serverProcess = null
  }
}

/** 是否处于「用户手动停止」状态（设置页据此显示已停止） */
export function isGenieManuallyStopped(): boolean {
  return manualStopped
}

/** Python 可执行名：优先项目目录下的 python，否则系统 python */
function resolvePython(workPath: string): string {
  const root = (workPath ?? '').trim()
  if (root) {
    const candidates = [
      path.join(root, 'python.exe'),
      path.join(root, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'python'),
    ]
    const hit = candidates.find((p) => existsSync(p))
    if (hit) return hit
    return ''
  }
  return 'python'
}

/** 用哪个 python 跑下载/服务（系统 python 需已装 genie-tts） */
function spawnEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, GENIE_DATA_DIR: (dataDir ?? '').trim() }
}

/**
 * 启动 GenieTTS 服务（幂等）：
 *  - 服务已在线（probe 通过）→ 直接返回成功，不重复拉起（杜绝双实例 bind 10048 端口冲突）；
 *  - 并发调用（连点【启动服务】按钮 / 多段合成同时拉起）经 startPromise 互斥合并为同一次启动；
 *  - spawn 后轮询等待服务真正可访问（uvicorn/模型初始化需数秒），超时返回失败但进程保留后台继续初始化。
 * @param workPath Genie 环境目录（含 python.exe；可空则用系统 python）
 * @param baseUrl 服务地址（取端口）
 * @param dataDir GenieData 资源目录（不存在则报错，不启动）
 */
export async function startGenieServer(workPath: string, baseUrl = DEFAULT_CONFIG.baseUrl, dataDir = ''): Promise<{ ok: boolean; error?: string }> {
  // 用户显式启动：解除手动停止抑制
  manualStopped = false
  // 幂等前置：服务已在线直接返回
  if (await probe(baseUrl).catch(() => false)) return { ok: true }
  // 互斥：已有启动进行中（含合成路径的自动拉起）→ 等它完成后确认在线状态
  if (startPromise) {
    await startPromise
    return (await probe(baseUrl).catch(() => false)) ? { ok: true } : { ok: false, error: '服务启动未就绪，请稍后重试。' }
  }
  const run = doStartServer(workPath, baseUrl, dataDir)
  startPromise = run.then(() => undefined)
  try {
    return await run
  } finally {
    startPromise = null
  }
}

/** 启动内核：资源校验 → spawn → 轮询等待就绪（最多 20s） */
async function doStartServer(workPath: string, baseUrl: string, dataDir: string): Promise<{ ok: boolean; error?: string }> {
  const python = resolvePython(workPath)
  if (!python) return { ok: false, error: `未在项目路径找到 python：${workPath || '(空)'}` }

  const genieDir = (dataDir ?? '').trim() || (workPath ? path.join(workPath, 'GenieData') : '')
  // 关键资源校验：speaker_encoder.onnx 必须存在，否则 genie import 会挂起等待下载
  const required = genieDir ? path.join(genieDir, 'speaker_encoder.onnx') : ''
  if (!required || !existsSync(required)) {
    return {
      ok: false,
      error:
        '未找到 GenieData 资源（缺 speaker_encoder.onnx）。请先填写 GenieData 目录，否则服务无法启动。',
    }
  }

  const port = parsePort(baseUrl)
  const script = `import genie_tts as g; g.start_server(host='127.0.0.1', port=${port}, workers=1)`
  serverProcess = spawn(python, ['-c', script], {
    cwd: workPath ? (workPath.trim() || undefined) : undefined,
    env: spawnEnv(genieDir),
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  serverProcess.on('error', (err) => {
    console.error('[genie] 启动失败', err)
  })
  // stderr 转发（内容分级）：uvicorn 的 INFO/启动横幅也写 stderr，一律标 ERR 会污染运行日志——
  // 行内含 ERROR/Traceback 才记 error，含 WARNING 记 warn，其余按 info。
  serverProcess.stderr?.on('data', (d) => forwardGenieOutput(String(d)))

  // 轮询等待就绪：模型导入可能比固定 sleep 慢，最多等 20s；超时进程保留后台继续初始化
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await probe(baseUrl).catch(() => false)) return { ok: true }
  }
  return { ok: false, error: '服务启动超时（20s），进程仍在后台初始化——请稍后在语音设置里点【检测连通】确认。' }
}

/** Genie 子进程 stderr 行内容分级转发：ERROR/Traceback → error，WARNING → warn，其余 → info */
function forwardGenieOutput(text: string): void {
  if (/ERROR|Traceback/i.test(text)) console.error('[genie]', text)
  else if (/WARNING/i.test(text)) console.warn('[genie]', text)
  else console.log('[genie]', text)
}

/**
 * genie_tts 的 download_genie_data 使用 snapshot_download(local_dir='.')，故 cwd=目标目录。
 */
export async function downloadGenieData(dataDir: string): Promise<{ ok: boolean; error?: string }> {
  const dir = (dataDir ?? '').trim()
  if (!dir) return { ok: false, error: '请先填写 GenieData 目录' }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  const script = `import genie_tts as g; g.download_genie_data()`
  const proc = spawn('python', ['-c', script], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  let err = ''
  proc.stderr?.on('data', (d) => {
    err += String(d)
    console.error('[genie-dl]', String(d))
  })
  const code = await new Promise<number | null>((resolve) => proc.on('close', (c) => resolve(c)))
  if (code === 0) {
    return { ok: true }
  }
  return { ok: false, error: `下载失败(exit=${code})。请检查网络/代理。${err.slice(-300)}` }
}

/**
 * 从角色模型目录自动解析默认参考音频。
 * Genie 官方角色在角色目录内置 prompt_wav.json（含 Normal/Sad/Fear 等情绪）与 prompt_wav/*.wav；
 * 取 Normal 项的音频与配套文本作为合成参考音频，避免 Genie /tts 因未设置参考音频返回 404。
 * @param onnxModelDir 角色 onnx 模型目录（形如 .../角色名/tts_models）
 * @returns {path,text} 参考音频绝对路径与文本；解析失败返回 null
 */
async function resolveDefaultReferenceAudio(onnxModelDir: string): Promise<{ path: string; text: string } | null> {
  // 兜底查找兼容两种目录布局：官方角色 onnx 目录=角色名/tts_models（prompt_wav.json 在父目录）；
  // GUI 导入模型常直接选角色根目录为 onnx 目录（prompt_wav.json 就在该目录本身）。
  // 早先只查父目录——onnx 目录=角色根目录时 dirname 跳到 Output，prompt_wav.json 查找落空
  // （2026-10-17 实锤：Nanami_Chiaki 卡 onnx 目录=角色根目录，卡内参考又非 WAV → 双层落空报错）。
  const dirs = [path.dirname(onnxModelDir || ''), onnxModelDir || '']
  for (const dir of dirs) {
    if (!dir) continue
    const promptJson = path.join(dir, 'prompt_wav.json')
    if (!existsSync(promptJson)) continue
    try {
      const meta = await readJson<{ Normal?: { wav?: string; text?: string } }>(promptJson, {})
      const wav = meta?.Normal?.wav
      const text = meta?.Normal?.text
      if (!wav || !text) continue
      const wavPath = path.join(dir, 'prompt_wav', wav)
      if (!existsSync(wavPath)) continue
      return { path: wavPath, text }
    } catch {
      /* 该目录的 json 损坏则试下一个候选目录 */
    }
  }
  return null
}

/** 加载角色（POST /load_character），角色名/语言变化时才重新加载；可选设置参考音频。
 *  关键：服务端 load_character 对已在内存的同名角色会直接跳过（语言只在首次加载时生效，
 *  见 Genie ModelManager.load_character 的 character_to_model 早退分支），
 *  因此每次重载前必须先 /unload_character 复位，否则切换语言后服务端仍按旧语言合成。 */
async function ensureCharacterLoaded(params: { characterName: string; onnxModelDir: string; refAudioPath?: string; refAudioText?: string }, base: string, lang: string): Promise<void> {
  const name = params.characterName.trim()
  if (!name) throw new Error('未配置角色名（characterName）')
  if (!params.onnxModelDir) throw new Error('未配置角色 onnx 模型目录（onnxModelDir）')
  const gLang = toGenieLang(lang)
  if (loadedCharacter === `${name}|${gLang}`) return

  // 先卸载同名角色再加载：让切换语言真正生效。
  // unload 对未加载的角色是安全空操作；端点不存在/网络异常时吞掉，退化为旧行为。
  try {
    await net.fetch(`${base}/unload_character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_name: name }),
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    /* ignore */
  }

  // load_character：角色名用明文
  const loadResp = await net.fetch(`${base}/load_character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_name: name, onnx_model_dir: params.onnxModelDir, language: gLang }),
    signal: AbortSignal.timeout(60000),
  })
  if (!loadResp.ok) {
    throw new Error(`加载角色失败 (HTTP ${loadResp.status})`)
  }

  // 可选参考音频（用于情绪/语气素材；未配置则跳过，用声库默认）。
  // language 传参考音频文本自身的语言（自动检测），而非当前合成语言：
  // prompt 文本必须按与音频一致的语言编码条件音素，错标会诱发复读参考音频。
  if (params.refAudioPath && params.refAudioText) {
    const refResp = await net.fetch(`${base}/set_reference_audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character_name: name,
        audio_path: params.refAudioPath,
        audio_text: params.refAudioText,
        language: toGenieLang(detectRefAudioLang(params.refAudioText)),
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!refResp.ok) {
      throw new Error(`设置参考音频失败 (HTTP ${refResp.status})`)
    }
  }

  loadedCharacter = `${name}|${gLang}`
}

/** 把合成流封装为 16-bit PCM WAV 的 ArrayBuffer（单声道，可换采样率）。
 * Genie /tts 返回的是 32kHz 单声道 int16 裸流（官方教程直接当 int16 播放）；也可能已是 RIFF。 */
function wrapToWav(chunks: Uint8Array[], sampleRate = 32000): ArrayBuffer | null {
  const raw = Buffer.concat(chunks as Buffer[])
  if (raw.length === 0) return null

  // 已是 RIFF/WAV → 原样返回
  if (raw.subarray(0, 4).toString('ascii') === 'RIFF') {
    const ab = new ArrayBuffer(raw.byteLength)
    new Uint8Array(ab).set(raw)
    return ab
  }

  // 裸 int16 PCM（Genie 官方 /tts 即此格式）。注意：不能按 float32 猜，否则会把 int16 当 float 读成杂音。
  const evenLen = raw.length - (raw.length % 2)
  const pcm = evenLen > 0 ? raw.subarray(0, evenLen) : raw

  const numSamples = pcm.byteLength / 2
  const wav = Buffer.alloc(44 + numSamples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + numSamples * 2, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(numSamples * 2, 40)
  pcm.copy(wav, 44)

  const ab = new ArrayBuffer(wav.byteLength)
  new Uint8Array(ab).set(wav)
  return ab
}

/** 大写字母的中文谐音读法表（字母名近似音）：
 *  Genie 中文 G2P 会删除所有英文字母（ChineseG2P 的 pattern_eng 把 [a-zA-Z]+ 整段移除），
 *  AI/GPU 等缩写会被静默跳过；合成前把缩写转成谐音汉字即可让 Genie 按普通话读出。 */
const LETTER_ZH: Record<string, string> = {
  A: '欸', B: '必', C: '西', D: '地', E: '伊', F: '艾付', G: '吉',
  H: '诶曲', I: '艾', J: '杰', K: '开', L: '艾勒', M: '艾姆', N: '恩',
  O: '欧', P: '批', Q: '扣', R: '啊儿', S: '艾丝', T: '提', U: '优',
  V: '维', W: '达不溜', X: '艾克斯', Y: '歪', Z: '贼',
}

/** 缩写匹配规则（仅大写）：纯大写缩写 2-5 连（AI/GPU/USB）、字母数字混排（3D/2K、A4/X1/1080P）。
 *  单字母与超过 5 连的大写串、普通英文单词不处理（维持 Genie 默认跳过；逐字母拼读单词反而怪异） */
const ABBR_PATTERN = /\b(?:[A-Z]{2,5}|\d{1,4}[A-Z]|[A-Z]\d)\b/g

/**
 * 把缩写展开为逐字母中文谐音（数字保留原样，交给 Genie 的数字归一化转汉字）。
 * @param abbr 匹配到的缩写串（如 "GPU"、"3D"）
 * @returns 谐音汉字串；含未收录字符时返回原串（交给 Genie 按现状处理）
 */
function expandAbbrToZh(abbr: string): string {
  let out = ''
  for (const ch of abbr) {
    if (LETTER_ZH[ch]) {
      out += LETTER_ZH[ch]
    } else if (/[0-9]/.test(ch)) {
      out += ch
    } else {
      return abbr
    }
  }
  return out
}

/**
 * 中文文本预处理：规避 Genie 中文 G2P（ChineseG2P）在 _merge_continuous_three_tones_2 中的越界崩溃。
 *
 * 崩溃机理（cesium）：ToneSandhi.pre_merge_for_modify 直接对 jieba 分词结果的每个 token 做
 * lazy_pinyin(..., Style.FINALS_TONE3)，随后在 _merge_continuous_three_tones_2 里访问
 * sub_finals_list[i-1][-1][-1]。若某个 token（如省略号 …、独立标点、纯符号）的 lazy_pinyin
 * 返回空列表（无韵母），则对该 token 的下一个索引做下标访问时会越界抛 IndexError。
 *
 * 规避策略：把可能触发空韵母的孤立符号替换为"有韵母/不会单独成空 token"的安全形式，
 * 使单次 /tts 请求即可成功，避免退回多段合成（多段会叠加参考音频，导致参考音重复）。
 */
function sanitizeGenieText(text: string): string | null {
  // 保留能产生停顿的中文停顿标点，只剔除会触发 G2P 越界崩溃的字符。
  //
  // 0) 整组剔除圆括号内容（心理/动作/场景描写，按演出规范不朗读）——
  //    旧逻辑只删括号字符保留内文，会把（她把靠窗的位置往里让了让）这类动作也读出来。
  //    跑两遍覆盖一层嵌套；剔空后若整句为空则无有效台词（调用方会得到空音频并报错）。
  let t = text
  t = t.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '')
  t = t.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '')
  t = t.trim()
  if (!t) {
    console.log('[genie] 剔除括号内容后无有效台词，跳过合成（原文：%s）', text.slice(0, 40))
    return null
  }
  //
  // 0.5) 英文缩写转中文谐音：Genie 中文 G2P 会删除所有英文字母（pattern_eng + pattern_filter），
  //      AI/GPU 等缩写会被静默跳过；提前转成谐音汉字让 Genie 按普通话读出。
  //      仅处理大写缩写与字母数字混排（3D/1080P），普通英文单词维持跳过（逐字母拼读反而怪异）。
  t = t.replace(ABBR_PATTERN, (m) => expandAbbrToZh(m))
  //
  // 崩溃机理：Genie 的 _merge_continuous_three_tones_2 对 jieba 分词的每个 token 做
  // lazy_pinyin FINALS_TONE3，再合并连续三声时访问 sub_finals_list[i-1][-1][-1]。
  // 若某 token 返回空韵母（无拼音）就会越界。触发源有两类：
  //   1) 非白名单的符号/括号/引号/破折号等（Genie 的 pattern_filter 本就会删掉它们，
  //      但 ToneSandhi 在 filter 前已对分词 token 做了 lazy_pinyin，空 token 提前崩溃）；
  //   2) 个别语气字本身无韵母（实测「嗯」「呣」lazy_pinyin FINALS_TONE3 返回空串）。
  // Genie 自带的 _replace_punctuation 会把中文停顿标点映射为合法停顿
  // （感号→!、问号→?、顿号/逗号/分号→,、句号→.、省略号→…），所以保留它们即可获得自然的
  // 停顿时长，同时规避崩溃。
  //
  // 保留：中文汉字、数字、字母 + 停顿标点 ，。！？…、；：
  // 1) 连续省略号/连续点压缩为单个省略号（避免 pattern_consecutive 合并异常，也避免过长停顿）
  t = t.replace(/…+/g, '…').replace(/\.{2,}/g, '…')
  // 2) 删除会触发空韵母崩溃的字符：括号、方括号、引号、书名号、破折号及各类特殊符号。
  //    这些本会被 Genie pattern_filter 删除，但在那之前已在分词阶段导致 lazy_pinyin 返回空。
  //    注意：保留顿号 、（Genie 会映射为停顿逗号）。
  t = t.replace(/[（）()【】\[\]「」『』《》〈〉“”"''———~～￥%&*@#+=/\|^_`{}]/g, '')
  // 3) 空韵母语气字归一（「嗯」「呣」无拼音，实测触发三声合并越界）：
  //    替换为近义可发声字「唔」（wú，韵母正常不触发崩溃），保住"闷闷的一声应答"的演出节拍，
  //    而非静默删字（删字会让「……嗯。」这类纯语气块只剩标点、必然空音频）。
  t = t.split('嗯').join('唔').split('呣').join('唔')
  // 3.5) 「哪儿」→「哪里」：Genie 2.0.2 的 g2pM 在「哪儿」里把「儿」按儿化后缀预测成 r5，
  //      to_finals_tone3 返回空韵母，ChineseG2P._pinyin_to_opencpop_phones 的 tone = v[-1] 越界崩溃
  //      （2026-10-23 实测：pinyin=['na3','r5'] finals=['a3','']）。换为等长同义的「哪里」，
  //      只影响合成文本、不改显示文本；其它儿化词（这儿/那儿/玩儿/一会儿等）实测正常，不做替换。
  t = t.split('哪儿').join('哪里')
  // 4) 其余字符原样保留；Genie 会用 pattern_filter 清理剩余非常规符号
  return t
}

/** 判断安全化后的文本是否含可发声内容（去掉停顿标点与空白后仍有字符） */
function hasSpeakableContent(text: string): boolean {
  return text.replace(/[，。！？…、；：,.!?;:\s]/g, '').length > 0
}

/** 中文模式客户端合并分句的目标段长（字符）：段内文本越长，相对参考音频条件的占比越高，复读概率越低 */
const MERGE_TARGET_LEN = 32
/** 单段长度上限（字符）：单句超过此长度时独立成段，避免单段推理过长 */
const MERGE_MAX_LEN = 48
/**
 * 首段合并上限（字符，P0-1 首段小段优先）：Genie 合成 ~0.3-0.4s/字，首段合并到 30-48 字
 * 意味着第一声要等 10-14s；首段收窄让第一段音频 5-6s 内出声，后续段仍按 32/48 贪心合并
 * 保音调连贯。首句本身超过上限时按句独立成段，不做句内细切。
 * 每个语音块的首段都收窄（块 N 的合成与块 N-1 的播放重叠，首段小即每块开播都快）。
 */
const MERGE_FIRST_MAX_LEN = 18
/**
 * 首段合并下限（字符，复诵参考音频源头治理，2026-10-16 01:26 轮实锤）：首段过短（4-6 字的
 * 语气片）会让"短文本泡在长参考条件里"的失衡达到极致，模型必然续写参考音频（实测 4 字
 * 合成 8.1s = 台词 + 参考音频开头，且重载角色重试无效——条件主导的确定性行为）。首段至少
 * 凑到该长度才封段，**下限优先于上限**（突破 MERGE_FIRST_MAX_LEN 也要凑满），从源头消除
 * 超短诱因段，同时保持首段较小（10-24 字 ≈ 3-9s，仍明显快于改造前的 48 字）。
 */
const MERGE_FIRST_MIN_LEN = 10

/**
 * 按停顿标点把安全化文本切句（标点保留在句尾），供合并分句使用。
 */
function splitByPunctuation(text: string): string[] {
  return text
    .split(/(?<=[，。！？…、；：])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 把句子贪心合并为接近目标长度的段：
 * 首段按"至少 MERGE_FIRST_MIN_LEN、趋向 MERGE_FIRST_MAX_LEN"封段（下限优先——低于下限继续
 * 并入下一片，哪怕突破上限，见 MERGE_FIRST_MIN_LEN 注释）；后续段相邻句累加到 MERGE_TARGET_LEN
 * 即封段；单句超过 MERGE_MAX_LEN 时独立成段；合并后无可发声内容的段（如孤立的"……"）
 * 会被过滤，避免必然空音频的请求。
 */
function mergeSentences(sentences: string[]): string[] {
  const segs: string[] = []
  let cur = ''
  let first = true
  for (const s of sentences) {
    if (s.length > MERGE_MAX_LEN) {
      if (cur) {
        segs.push(cur)
        cur = ''
        first = false
      }
      segs.push(s)
      continue
    }
    if (first) {
      // 首段：凑满下限才封段（下限优先于上限，见 MERGE_FIRST_MIN_LEN 注释）
      cur += s
      if (cur.length >= MERGE_FIRST_MIN_LEN) {
        segs.push(cur)
        cur = ''
        first = false
      }
      continue
    }
    if (cur && cur.length + s.length > MERGE_MAX_LEN) {
      segs.push(cur)
      cur = s
    } else {
      cur += s
      if (cur.length >= MERGE_TARGET_LEN) {
        segs.push(cur)
        cur = ''
      }
    }
  }
  if (cur) segs.push(cur)
  return segs.filter((s) => hasSpeakableContent(s))
}

/**
 * 日语缩约形展开：口语缩约形与完整形语义完全一致（完整形仅多一个 i 拍、听感稍正式），
 * 但 Genie ja G2P 对缩约形（实测"〜てない""〜てる"）会触发 njd2jpcommon convert_pos()
 * "助動詞 非自立" 警告并提前终止合成（线上案例：58 字文本只出 2.8s 音频，正常应 ~10s）。
 * 统一展开为完整形规避该缺陷；仅处理て类（で类需前缀锚定防误伤"出る"等独立词，暂不处理）。
 * 只影响合成读音（标准形），不改显示文本。
 */
function expandJaContractions(text: string): string {
  return text.split('てない').join('ていない').split('てる').join('ている')
}

/** 各语言参考语速（字/秒）：声库实测正常样本（Nanami_chiaki ≈ 6.2~6.6 ja），取保守均值用于时长预期 */
const REF_SPEECH_RATE: Record<string, number> = { ja: 5.5, zh: 4.0 }
/** 单句截断默认阈值（可在通用设置中调整）：实际时长低于"按参考语速的预期时长"的 55% 判定截断 */
const TRUNCATION_RATIO = 0.55
/** 最小校验字数：短段统计误差大且截断损失小，豁免校验 */
const TRUNCATION_MIN_CHARS = 20
/**
 * 短段硬上限：<20 字时实际阈值取 min(单句阈值, 0.5)。0.5 以下不存在合法解释：截断只会拉低比例、
 * 停顿只会抬高比例，正常语音最低 0.78（留 0.28 余量），实测案例 16 字/0.9s = 比例 0.22
 * （2026-10-15 实锤）、17 字/1.0s = 比例 0.32 恰卡 0.3 旧线之上漏判，"你居然在试探我"整句无音
 * （2026-10-17 实锤后收紧）。0.5~0.55 的部分截断（如 19 字/1.8s = 0.53）仍放行：短段截断损失小，
 * 重试代价 ~10s（重载角色）+ 播放阻塞，平衡点刻意留在 0.5。
 */
const TRUNCATION_HARD_RATIO = 0.5
/**
 * 时长比例上限（复诵参考音频治理，2026-10-15 实锤）：实际时长超过"按参考语速的预期时长"的
 * 4 倍且绝对时长 > 3s = 疑似复诵参考音频。zero-shot 克隆以参考音频+其转写为生成条件，
 * 超短目标文本与长条件的占比极端失衡时，模型会"续写"出参考音频的内容（实测「…うん。」
 * 4 字合成出 8.0s 音频 = 拖腔 + 参考音频原文）。正常语音波动 ≈ 0.85~1.2 倍，表达性拖长音
 * 极少超过 2 倍——4 倍 + 3s 双门槛不会误伤。上界不做小字段豁免：泄漏恰恰集中在超短段。
 */
const LEAK_RATIO = 4.0
/** 泄漏判定的绝对时长下限（秒）：超短段比例噪声大，绝对时长过小不判泄漏 */
const LEAK_MIN_SEC = 3.0

/** 段内是否还有硬句末（排除段尾连续的句末标点 / 省略号）：多句段风险标记 */
function hasInternalHardEnd(seg: string): boolean {
  // 先剥掉段尾连续的句末标点与省略号，避免把「真的吗？！」「你好。…」这类单句误判成多句段；
  // 注意不能把「，、；：」纳入剥离集合——C/E 案例的句号后面紧跟的就是「、」「，」。
  const body = seg.replace(/[。！？!?…\s]+$/, '')
  return /[。！？!?]/.test(body)
}

/** 比例阈值夹取：设置值异常（含 null）时回落到默认值，避免重试风暴或永不判定 */
function clampRatio(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined) return fallback
  const v = Number(value)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

/**
 * 段时长截断判定：音频时长远短于"文本按参考语速的预期时长" = 服务端合成提前终止。
 * 语速参考：ja 正常 5~7 字/s、zh 3.5~5 字/s；线上截断案例 58 字/2.8s = 20.7 字/s（比例 0.27）。
 * 单句模式下短段（< TRUNCATION_MIN_CHARS 字）实际阈值取「单句阈值」与 0.5 中的更低者
 * （统计误差大，0.5 作为短段上限）；调低单句阈值 = 更宽松，调高 = 更严格。
 * 多句段严格模式（设置项，默认开）：多句段改用单独阈值，且取消 20 字豁免——
 * Genie 在多句段的内部句号处会提前收尾（2026-10-23 实测：14 字/2.2s=0.64、12 字/2.6s=0.87），
 * 短句豁免会让这两类截断直接漏过。
 * 泄漏方向（leaked）不做字数豁免——复诵参考音频恰恰集中在超短段（见 LEAK_RATIO 注释）。
 */
function judgeSegmentTruncation(
  seg: string,
  pcm: Buffer,
  lang: string,
  options: { multiSentenceStrict: boolean; multiSentenceRatio: number; singleSentenceRatio: number },
): {
  truncated: boolean
  leaked: boolean
  sec: number
  expectedSec: number
  ratio: number
  multi: boolean
  threshold: number
} {
  const sec = pcm.length / 2 / 32000
  const rate = REF_SPEECH_RATE[lang] ?? 4.0
  const expectedSec = seg.length / rate
  const ratio = expectedSec > 0 ? sec / expectedSec : 1
  const multi = hasInternalHardEnd(seg)
  const useMulti = options.multiSentenceStrict && multi
  const threshold = useMulti ? options.multiSentenceRatio : options.singleSentenceRatio
  // 多句段严格模式：取消 20 字豁免，只看阈值；其余路径保持原逻辑
  const truncated = ratio < threshold && (useMulti || seg.length >= TRUNCATION_MIN_CHARS || ratio < TRUNCATION_HARD_RATIO)
  const leaked = ratio > LEAK_RATIO && sec > LEAK_MIN_SEC
  return { truncated, leaked, sec, expectedSec, ratio, multi, threshold }
}

/** 估计纯停顿块的静音时长（秒）：基础一拍 + 每个省略号加一拍，封顶 1.5s */
function estimatePauseSeconds(text: string): number {
  const ellipses = (text.match(/…/g) ?? []).length
  const pauses = (text.match(/[，。！？、；：]/g) ?? []).length
  return Math.min(1.5, 0.3 + 0.25 * ellipses + 0.1 * pauses)
}

/** 超短段最终音频缓存（<8 字，key = 语种|文本）：超短段复诵确定 + 应答词重复率极高，
 *  同文本二次合成直接复用（含静音占位/裁剪结果）。LRU 32 条防膨胀（2026-10-19 复诵治理三期） */
const segCache = new Map<string, Buffer>()
const SEG_CACHE_MAX = 32

/** 生成指定时长的静音 WAV（32kHz 单声道 int16，与 Genie /tts 输出格式一致） */
function buildSilenceWav(seconds: number): ArrayBuffer {
  const sampleRate = 32000
  const numSamples = Math.max(1, Math.round(seconds * sampleRate))
  const pcm = Buffer.alloc(numSamples * 2) // int16 静音 = 全 0
  const wav = Buffer.alloc(44 + pcm.byteLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.byteLength, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.byteLength, 40)
  pcm.copy(wav, 44)
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)
}
/**
 * 请求 Genie /tts 合成一段文本，返回原始音频字节（裸 int16 PCM，也可能已是 RIFF/WAV）。
 * split_sentence 固定 false：分段策略由客户端控制（见 mergeSentences）——
 * 服务端 TextSplitter 会把文本切得过碎，每句都注入一次完整参考音频条件，
 * "短文本泡在长条件里"会显著放大复诵参考音频（复读）的概率。
 * @returns 原始音频字节；请求失败/空响应返回 null（调用方负责重试与报错）
 */
async function genieFetchRaw(base: string, name: string, text: string): Promise<Uint8Array | null> {
  // 【诊断】确认实际发送给 Genie 的合成文本（判断是否因 stripBrackets 剥太薄而诱发复诵参考音频文本）
  console.log('[genie] tts text=%j', String(text).slice(0,120))
  const resp = await net.fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_name: name, text, split_sentence: false }),
    // 长句在核显/排队时推理可能超过 2 分钟，放宽到 3 分钟（超时后上层会重载角色重试一次）
    signal: AbortSignal.timeout(180000),
  })
  if (!resp.ok) return null
  const chunks: Uint8Array[] = []
  const reader = resp.body?.getReader()
  if (!reader) return null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  if (total === 0) return null
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * 把 /tts 返回的原始字节规范化为裸 int16 PCM：
 * RIFF/WAV 则定位 data 块提取 PCM，否则按裸 PCM 原样返回（Genie 官方默认输出格式）。
 * @returns PCM 字节；无有效数据返回 null
 */
function rawToPcm(raw: Uint8Array): Buffer | null {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length === 0) return null
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    // 诊断：Genie 官方输出固定 32kHz/16bit/单声道；参数异常时剥头按 32k/16bit 拼接可能出现变速/噪声。
    // 注意 fmt 块偏移按标准布局读取（与 parseWavDuration 同款简化），仅用于诊断告警。
    const channels = buf.readUInt16LE(22)
    const sampleRate = buf.readUInt32LE(24)
    const bits = buf.readUInt16LE(34)
    if (bits !== 16 || channels !== 1 || sampleRate !== 32000) {
      console.warn('[genie] /tts 返回 RIFF 参数非预期（ch=%d rate=%d bits=%d），拼接结果可能异常', channels, sampleRate, bits)
    }
    // 定位 data chunk
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.subarray(off, off + 4).toString('ascii')
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') {
        const dataOff = off + 8
        const len = Math.min(size, buf.length - dataOff)
        return len > 0 ? buf.subarray(dataOff, dataOff + len) : null
      }
      off += 8 + size + (size % 2)
    }
    return null
  }
  return buf
}

/**
 * 把参考音频规范化为单声道 16-bit PCM WAV（Genie prompt_encoder 只接受 rank=2 的 ref_audio，
 * 立体声/高比特位会被 ONNX 拒绝：Invalid rank for input: ref_audio Got: 3 Expected: 2）。
 * 支持 PCM 8/16/24/32bit 与 32-bit float、任意声道数；已是单声道 PCM16 的原路径返回；
 * 无法解析（如 mp3）返回 null，由调用方回退到角色内置参考音频。降混结果缓存为 <原名>.mono.wav。
 */
async function ensureMonoWav(p: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(p)
    if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return null
    const audioFormat = buf.readUInt16LE(20)
    const channels = buf.readUInt16LE(22)
    const bitsPerSample = buf.readUInt16LE(34)
    const isPcm = audioFormat === 1 && [8, 16, 24, 32].includes(bitsPerSample)
    const isFloat = audioFormat === 3 && bitsPerSample === 32
    if (!isPcm && !isFloat) {
      console.warn('[genie] 参考音频格式不受支持（format=%d bits=%d）：%s', audioFormat, bitsPerSample, p)
      return null
    }
    if (channels === 1 && bitsPerSample === 16) return p // 已是目标格式

    // 定位 data 块
    let off = 12
    let dataOffset = -1
    let dataLen = 0
    while (off + 8 <= buf.length) {
      const id = buf.subarray(off, off + 4).toString('ascii')
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') {
        dataOffset = off + 8
        dataLen = Math.min(size, buf.length - dataOffset)
        break
      }
      off += 8 + size + (size % 2)
    }
    if (dataOffset < 0 || dataLen === 0) return null

    const bytesPerSample = bitsPerSample / 8
    const frameBytes = bytesPerSample * channels
    const frames = Math.floor(dataLen / frameBytes)
    const mono = Buffer.alloc(frames * 2)
    const readSample = (offset: number): number => {
      if (isFloat) return Math.round(buf.readFloatLE(offset))
      switch (bitsPerSample) {
        case 8: return (buf.readUInt8(offset) - 128) << 8
        case 16: return buf.readInt16LE(offset)
        case 24: {
          const v = buf.readUIntLE(offset, 3)
          return v & 0x800000 ? v - 0x1000000 : v
        }
        default: return Math.round(buf.readInt32LE(offset) / 65536) // 32bit int → 16bit
      }
    }
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += readSample(dataOffset + i * frameBytes + c * bytesPerSample)
      mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2)
    }

    const sampleRate = buf.readUInt32LE(24)
    const out = Buffer.alloc(44 + mono.length)
    out.write('RIFF', 0)
    out.writeUInt32LE(36 + mono.length, 4)
    out.write('WAVE', 8)
    out.write('fmt ', 12)
    out.writeUInt32LE(16, 16)
    out.writeUInt16LE(1, 20)
    out.writeUInt16LE(1, 22)
    out.writeUInt32LE(sampleRate, 24)
    out.writeUInt32LE(sampleRate * 2, 28)
    out.writeUInt16LE(2, 32)
    out.writeUInt16LE(16, 34)
    out.write('data', 36)
    out.writeUInt32LE(mono.length, 40)
    mono.copy(out, 44)

    const target = `${p}.mono.wav`
    await fs.writeFile(target, out)
    console.log('[genie] 参考音频已规范化为单声道 16bit（原 format=%d bits=%d ch=%d）：%s', audioFormat, bitsPerSample, channels, target)
    return target
  } catch (err) {
    console.warn('[genie] 参考音频规范化失败：', err instanceof Error ? err.message : err)
    return null
  }
}

// 翻译（中文 ↔ 日文）已抽到 ttsTranslate.ts：Genie-TTS 与 SBV2 共用。
// 这里保留 re-export，兼容 windowManager 既有的动态导入写法。
export { prefetchTranslation } from './ttsTranslate'

/**
 * 用 GenieTTS 合成语音（声库自带性格）。
 * 单次请求：发送前先对文本做 sanitizeGenieText 规避 G2P 越界崩溃，
 * @param params.config Genie 配置
 * @param params.characterName 角色名
 * @param params.onnxModelDir onnx 模型目录
 * @param params.refAudioPath 参考音频路径（可选）
 * @param params.refAudioText 参考音频文本（可选）
 * @param params.text 文本
 * @param params.lang 目标语言（zh/ja；传给 Genie 时日语映射为 jp）
 * @returns WAV 字节的 ArrayBuffer
 */
export async function synthesizeGenie(params: {
  config: TTSGenieConfig
  characterName: string
  onnxModelDir: string
  refAudioPath?: string
  refAudioText?: string
  text: string
  lang: string
}): Promise<ArrayBuffer> {
  // 串行化：排队执行，前一个失败不影响后一个
  const next = synthChain.then(
    () => synthesizeGenieInner(params),
    () => synthesizeGenieInner(params),
  )
  synthChain = next.catch(() => undefined)
  return next
}

async function synthesizeGenieInner(params: {
  config: TTSGenieConfig
  characterName: string
  onnxModelDir: string
  refAudioPath?: string
  refAudioText?: string
  text: string
  lang: string
}): Promise<ArrayBuffer> {
  const { config, characterName, refAudioPath, refAudioText, text, lang } = params
  const onnxModelDir = normalizeOnnxModelDir(params.onnxModelDir)
  const base = normUrl(config.baseUrl)

  if (!(await probe(base))) {
    // 服务未就绪且配置了环境路径 → 自动拉起（startGenieServer 自带幂等前置 + 互斥 + 等就绪，
    // 合成路径与【启动服务】按钮共用同一套防重，杜绝双实例 bind 10048）
    if (config.workPath && !serverProcess && !manualStopped) {
      const started = await startGenieServer(config.workPath, config.baseUrl, config.dataDir)
      if (!started.ok) throw new Error(started.error ?? 'GenieTTS 服务启动失败。')
    }
    if (!(await probe(base))) {
      throw new Error('GenieTTS 服务未运行。请在设置中先【启动服务】并等待就绪，或确认地址/端口正确。')
    }
  }

  const name = characterName.trim()
  if (!name) throw new Error('未配置角色名，无法合成')
  // Genie /tts 强制要求已设置参考音频，否则返回 404。
  // 参考音频必须为单声道 16-bit PCM（prompt_encoder 只接受 rank=2）。
  // 候选顺序：模型卡参考音频 → 角色内置 prompt_wav（prompt_wav.json Normal 项，格式通常标准）；
  // 卡内参考无法规范化为单声道（如 mp3/怪格式）时自动回退内置项。
  const autoRef = await resolveDefaultReferenceAudio(onnxModelDir)
  let effRefPath = ''
  let effRefText = ''
  if (refAudioPath) {
    const normalized = await ensureMonoWav(refAudioPath)
    if (normalized) {
      effRefPath = normalized
      effRefText = refAudioText || (autoRef?.text ?? '')
    } else {
      console.warn('[genie] 模型卡参考音频无法规范化，回退角色内置参考音频：%s', autoRef?.path ?? '(无)')
    }
  }
  if (!effRefPath && autoRef?.path) {
    const normalized = await ensureMonoWav(autoRef.path)
    if (normalized) {
      effRefPath = normalized
      effRefText = autoRef.text ?? ''
    }
  }
  if (!effRefPath) {
    // 模型卡参考音频无法解析（非 WAV）且角色目录无内置 prompt_wav（GUI 导入的模型常见）。
    // Genie /tts 无参考音频会 404，与其报含糊的"空音频"，不如直接指引用户换 WAV。
    throw new Error('参考音频无法解析（仅支持 WAV 格式）。请在「语音合成 → TTS 模型卡」中重新导入 .wav 格式的参考音频（建议单声道）')
  }
  try {
    await ensureCharacterLoaded({ characterName: name, onnxModelDir, refAudioPath: effRefPath || undefined, refAudioText: effRefText || undefined }, base, lang)
  } catch (err) {
    loadedCharacter = '' // 加载失败：下次强制重载
    throw err
  }

  // 日语模式：将中文文本翻译为日语后再合成（AI 生成中文，TTS 输出日语语音）
  let synthText = text
  // 仅语言不符才翻译：日语模式下若文本已含日文（平假名/片假名），直接用原文合成，避免二次翻译扭曲语气
  const alreadyJa = lang === 'ja' && /[\u3040-\u309F\u30A0-\u30FF]/.test(text)
  if (lang === 'ja' && !alreadyJa) {
    console.log('[genie] 日语模式：翻译中文文本为日语')
    synthText = await translateWithCache(text, 'ja')
    console.log('[genie] 翻译结果:', synthText.slice(0, 50))
  } else if (lang === 'ja') {
    console.log('[genie] 日语模式：文本已含日文，跳过翻译')
  }

  // 文本预处理（整组剔除（）心理/动作内容）规避 G2P 越界崩溃；随后按语言分段合成
  const sanitized = sanitizeGenieText(synthText)
  if (!sanitized) {
    // 整段都在括号里（纯心理/动作/场景，无可朗读台词）
    throw new Error('该段内容均为心理/动作描写（括号内），没有可朗读的台词')
  }
  // ja 缩约形展开（てない→ていない、てる→ている，读音同义零损失）：规避 Genie ja G2P 的
  // convert_pos() 缺陷（缩约形触发"助動詞 非自立"警告后合成提前终止，详见 expandJaContractions）
  const safeText = lang === 'ja' ? expandJaContractions(sanitized) : sanitized
  // 纯停顿块短路（如「……」「！？」——语气字已归一为「唔」，一般不会再落到这里）：
  // 无可发声内容时调用 /tts 必然返回空音频，且重载角色重试也无法改变结果。
  // 直接返回一段短静音保留"停顿"演出节拍，不发起请求、不重载、不打错误。
  if (!hasSpeakableContent(safeText)) {
    const seconds = estimatePauseSeconds(safeText)
    console.log('[genie] 无可发声内容（纯停顿块），返回 %ss 静音节拍：%s', seconds.toFixed(2), safeText)
    return buildSilenceWav(seconds)
  }
  // 分段策略：客户端按标点切句并贪心合并为目标段长（30-48 字），逐段合成后拼接（ja/zh 同规则）——
  // 服务端 split_sentence=true 同样是逐句独立推理，但句子切得太碎：每句都注入一次完整参考音频
  // 条件，"短文本泡在长条件里"的比例失衡会显著放大模型复诵参考音频（复读）的概率；
  // 合并后注入次数与文本占比同时改善。ja 并入分段（原整段一次合成）：单次推理变短，
  // G2P 异常（convert_pos 截断）的暴露面与单次损失同步缩小。
  const segments = mergeSentences(splitByPunctuation(safeText))
  if (segments.length === 0) {
    // 理论上不可达（整体无可发声内容已被上游短路拦截），防御性回退整段合成
    segments.push(safeText)
  }

  // ②截断重试免重载开关 + 多句段截断判定参数（一次读取，逐段复用）
  //   - 截断非确定性行为：免重载重试是主路径，重载 8~13s 只是“真·模型状态坏”场景的保险
  //   - 多句段严格模式：多句段使用单独阈值且取消 20 字豁免（见 judgeSegmentTruncation）
  const genieSettings = await getSettings().catch(() => null)
  const truncationReloadRetry = genieSettings?.truncationReloadRetry ?? true
  const multiSentenceStrict = genieSettings?.genieMultiSentenceStrict ?? true
  const multiSentenceRatio = clampRatio(genieSettings?.genieMultiSentenceTruncationRatio, 0.5, 1, 0.9)
  const singleSentenceRatio = clampRatio(genieSettings?.genieTruncationRatio, 0.3, 0.9, TRUNCATION_RATIO)

  // 逐段合成（每段失败/判定截断自动重试一次：重载角色可复位服务端推理状态），全部成功后拼接 PCM。
  // 任一段重试后仍失败 → 放弃整段并向上报错（上层兜底：文本顶上跟读气泡），避免缺段语音。
  const pcms: Buffer[] = []
  for (const seg of segments) {
    // 超短段文本级缓存（2026-10-19 复诵治理三期）：超短段（<8 字）复诵是确定性行为且
    // 应答词（"…うん。""嗯。""哦。"）重复率极高——同文本第二次合成直接复用最终音频
    // （含静音占位/裁剪结果），零请求零等待。LRU 32 条防膨胀。
    const segCacheKey = seg.length < 8 ? `${lang}|${seg}` : null
    const cached = segCacheKey ? segCache.get(segCacheKey) : undefined
    if (cached) {
      console.log('[genie] 超短段缓存命中（%ss）：%s', (cached.length / 2 / 32000).toFixed(1), seg)
      pcms.push(cached)
      continue
    }
    let bestPcm: Buffer | null = null
    let bestVerdict: ReturnType<typeof judgeSegmentTruncation> | null = null
    let segErr: unknown = null
    let attempts = 0
    let truncated = false
    /** 重试路径（按最近一次判定/失败分流）：truncated=免重载优先；leaked/error=维持重载兜底 */
    let retryPath: 'truncated' | 'leaked' | 'error' = 'error'
    let freeRetried = false // 截断路径：免重载重试已执行
    let reloadRetried = false // 截断路径：重载兜底重试已执行（仅开关开时可能发生）
    for (let attempt = 1; ; attempt++) {
      attempts = attempt
      if (attempt > 1) {
        if (retryPath === 'truncated' && !freeRetried) {
          // ②首次截断：免重载直接重试（不重载角色）——同状态重掷骰子即可翻盘
          console.warn('[genie] 截断重试：免重载直接重试（不重载角色）：%s', seg)
          freeRetried = true
        } else if (retryPath === 'truncated' && !reloadRetried) {
          // 免重载重试仍截断：按开关决定是否重载兜底
          if (!truncationReloadRetry) {
            console.warn('[genie] 免重载重试仍截断，重载开关=关 → 放行较长时间版本')
            break
          }
          console.warn('[genie] 免重载重试仍截断，重载开关=开 → 重载角色兜底重试')
          reloadRetried = true
          loadedCharacter = ''
          try {
            await ensureCharacterLoaded({ characterName: name, onnxModelDir, refAudioPath: effRefPath || undefined, refAudioText: effRefText || undefined }, base, lang)
          } catch (err) {
            loadedCharacter = ''
            throw err
          }
        } else {
          // 泄漏 / 异常 / 空音频：维持现状，重载角色后重试（复位服务端推理状态）
          loadedCharacter = ''
          try {
            await ensureCharacterLoaded({ characterName: name, onnxModelDir, refAudioPath: effRefPath || undefined, refAudioText: effRefText || undefined }, base, lang)
          } catch (err) {
            loadedCharacter = ''
            throw err
          }
        }
      }
      try {
        const raw = await genieFetchRaw(base, name, seg)
        const pcm = raw ? rawToPcm(raw) : null
        if (pcm) {
          const verdict = judgeSegmentTruncation(seg, pcm, lang, {
            multiSentenceStrict,
            multiSentenceRatio,
            singleSentenceRatio,
          })
          // 取舍方向随判定不同：截断取较长版本（重试大概率更长，取长无损失）；
          // 泄漏（复诵参考音频）取较短版本（重试大概率更短）
          const prefer = verdict.leaked
            ? !bestVerdict || verdict.sec < bestVerdict.sec
            : !bestVerdict || verdict.sec > bestVerdict.sec
          if (prefer) {
            bestPcm = pcm
            bestVerdict = verdict
          }
          truncated = verdict.truncated
          if (!truncated && !verdict.leaked) break // 时长正常，提前结束
          retryPath = verdict.leaked ? 'leaked' : 'truncated'
          if (verdict.leaked) {
            console.warn(
              '[genie] 段时长校验判定过长（疑似复诵参考音频，第 %d 次）：字数=%d 实际=%ss 预期=%ss 比例=%s%s',
              attempt,
              seg.length,
              verdict.sec.toFixed(1),
              verdict.expectedSec.toFixed(1),
              verdict.ratio.toFixed(2),
              attempt === 1 ? ' —— 重载角色后重试一次' : ' —— 重试后仍长，按预期上限裁剪尾部',
            )
            if (attempt >= 2) break // 泄漏维持现状：重载重试一次后进裁剪兜底
          } else {
            const hint = !freeRetried
              ? ' —— 免重载直接重试'
              : truncationReloadRetry && !reloadRetried
                ? ' —— 免重载仍短，重载开关=开，重载后兜底重试'
                : ' —— 仍短，放行较长时间版本'
            console.warn(
              '[genie] 段时长校验判定截断（第 %d 次）：字数=%d 实际=%ss 预期=%ss 比例=%s 阈值=%s 多句段=%s%s',
              attempt,
              seg.length,
              verdict.sec.toFixed(1),
              verdict.expectedSec.toFixed(1),
              verdict.ratio.toFixed(2),
              verdict.threshold.toFixed(2),
              verdict.multi ? '是' : '否',
              hint,
            )
            // 截断重试上限：免重载 1 次 + 重载兜底 1 次（开关关则无兜底）
            if (freeRetried && (reloadRetried || !truncationReloadRetry)) break
          }
        } else {
          // 空音频/无效 PCM：走重试
          truncated = false
          retryPath = 'error'
          if (attempt >= 2) break
        }
      } catch (err) {
        segErr = err
        retryPath = 'error'
        console.warn('[genie] 合成请求异常（第 %d 次）：%s', attempt, err instanceof Error ? err.message : String(err))
        if (attempt >= 2) break
      }
      if (attempt === 1) {
        // 超短段（<8 字）复诵 = 确定性行为（2026-10-19 日志实锤：两次合成 8.0s 分毫不差，
        // 重载角色无法改变条件结果）——跳过必然无效的重载重试，直接进兜底（省 ~10s）
        if (bestVerdict?.leaked && seg.length < 8) {
          console.warn('[genie] 超短段复诵参考音频（确定性），跳过重载重试直接进兜底：%s', seg)
          break
        }
        if (retryPath !== 'truncated') {
          // 截断走免重载重试（不重载角色）；泄漏/异常/空音频维持现状提示
          loadedCharacter = '' // 服务端推理状态可能已被污染，强制下次重载角色
          console.warn(
            '[genie] 段合成%s，重载角色后自动重试一次',
            bestVerdict?.leaked ? '超长（疑似复诵参考音频）' : bestPcm ? '时长不足（疑似截断）' : segErr ? '请求异常' : '为空音频',
          )
        }
        await new Promise((r) => setTimeout(r, 800))
      }
    }
    if (!bestPcm) {
      if (segErr) throw segErr instanceof Error ? segErr : new Error(String(segErr))
      throw new Error(`GenieTTS 生成为空音频（段：${seg.slice(0, 30)}${seg.length > 30 ? '…' : ''}）`)
    }
    // 复诵参考音频兜底：重试后仍超长 → 按段长分治。
    // 超短段（<8 字）：复诵 = 整段内容即参考音频台词（台词本体几乎没被合成），裁剪保留的
    // 1.5s 依然是参考音频的开头（错误内容被用户听到，2026-10-19 "…うん。" 轮实锤）——
    // 整段替换为预期时长的静音占位（保留演出节拍，文本照常上屏）。
    // 中长段：台词发声主体在段首、复读内容在尾部，按预期上限硬裁尾部不损伤台词本体。
    // rawToPcm 为 32kHz 单声道 int16（2 字节/采样）。
    if (bestPcm && bestVerdict?.leaked) {
      if (seg.length < 8) {
        const silenceSec = Math.min(1.5, Math.max(bestVerdict.expectedSec, 0.4))
        console.warn(
          '[genie] 复诵参考音频兜底：超短段整段即参考音频内容，替换为 %ss 静音占位：%s',
          silenceSec.toFixed(1),
          seg,
        )
        bestPcm = Buffer.alloc(Math.max(1, Math.round(silenceSec * 32000)) * 2) // int16 静音 = 全 0
      } else {
        const leakCapSec = bestVerdict.expectedSec * LEAK_RATIO
        const maxBytes = Math.floor(leakCapSec * 32000) * 2
        if (bestPcm.length > maxBytes) {
          console.warn(
            '[genie] 复诵参考音频兜底：段 %ss 超过预期上限 %ss，裁剪尾部',
            (bestPcm.length / 2 / 32000).toFixed(1),
            leakCapSec.toFixed(1),
          )
          bestPcm = bestPcm.subarray(0, maxBytes)
        }
      }
    }
    // 诊断埋点（排查"长语音提前结束"与"复诵参考音频"）：字数 / 语种 / PCM 实际时长 /
    // 实际/预期时长比例（下界=截断、上界=复诵，一维归因）/ 尝试次数。
    // 人工核对口径：中文正常约 3.5~5 字/秒、日文约 5~7 字/秒（含标点停顿），明显偏短 = 模型截断；
    // 出现"段合成请求异常/为空音频"warn + 上层"[pet] TTS 合成失败" = 弃段（该块音频整体丢失）。
    // 注意 util.format 不支持 %.1f 精度修饰（会原样输出并导致参数错位），秒数须先 toFixed 再用 %s。
    const secNum = bestPcm.length / 2 / 32000
    const finalRatio = seg.length > 0 ? secNum / (seg.length / (REF_SPEECH_RATE[lang] ?? 4.0)) : 1
    console.log('[genie] 段合成完成：语种=%s 字数=%d 时长=%ss 比例=%s 尝试=%d次%s', lang, seg.length, secNum.toFixed(1), finalRatio.toFixed(2), attempts, truncated ? '（截断重试后仍短，已放行较长版本）' : '')
    pcms.push(bestPcm)
    // 超短段结果写入缓存（最终定稿形态，含静音占位/裁剪）
    if (segCacheKey) {
      if (segCache.size >= SEG_CACHE_MAX) {
        const oldest = segCache.keys().next().value
        if (oldest !== undefined) segCache.delete(oldest)
      }
      segCache.set(segCacheKey, bestPcm)
    }
  }
  // 拼接各段 PCM（32kHz 单声道 int16）封装为 WAV；段尾标点的停顿由 Genie 生成，无需额外静音
  const wav = wrapToWav(pcms)
  if (!wav) {
    throw new Error('GenieTTS 拼接分段音频失败（无有效 PCM 数据）')
  }
  return wav
}
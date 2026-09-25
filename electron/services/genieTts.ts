/**
 * Genie-TTS(https://github.com/High-Logic/Genie-TTS) 本地声库语音服务客户端。
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
import type { TTSGenieConfig } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { readApiKey } from './crypto'
import { getSettings } from './repository'

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

/** 清理已拉起进程 */
export function stopGenieServer(): void {
  if (serverProcess) {
    try {
      serverProcess.kill()
    } catch {
      /* ignore */
    }
    serverProcess = null
  }
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
 * 启动 GenieTTS 服务：用 genie_tts 库的内置 start_server 拉起 FastAPI。
 * 启动前必须保证 GenieData 资源就绪（否则 genie 在 import 时会交互式弹卡，导致进程崩溃）。
 * @param workPath Genie 环境目录（含 python.exe；可空则用系统 python）
 * @param baseUrl 服务地址（取端口）
 * @param dataDir GenieData 资源目录（不存在则报错，不启动）
 */
export async function startGenieServer(workPath: string, baseUrl = DEFAULT_CONFIG.baseUrl, dataDir = ''): Promise<{ ok: boolean; error?: string }> {
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
  // 转发 stderr 便于排查
  serverProcess.stderr?.on('data', (d) => console.error('[genie]', String(d)))
  return { ok: true }
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
  const roleDir = path.dirname(onnxModelDir || '')
  const promptJson = path.join(roleDir, 'prompt_wav.json')
  if (!existsSync(promptJson)) return null
  try {
    const meta = await readJson<{ Normal?: { wav?: string; text?: string } }>(promptJson, {})
    const wav = meta?.Normal?.wav
    const text = meta?.Normal?.text
    if (!wav || !text) return null
    const wavPath = path.join(roleDir, 'prompt_wav', wav)
    if (!existsSync(wavPath)) return null
    return { path: wavPath, text }
  } catch {
    return null
  }
}

/** 加载角色（POST /load_character），角色名/语言变化时才重新加载；可选设置参考音频 */
async function ensureCharacterLoaded(params: { characterName: string; onnxModelDir: string; refAudioPath?: string; refAudioText?: string }, base: string, lang: string): Promise<void> {
  const name = params.characterName.trim()
  if (!name) throw new Error('未配置角色名（characterName）')
  if (!params.onnxModelDir) throw new Error('未配置角色 onnx 模型目录（onnxModelDir）')
  const gLang = toGenieLang(lang)
  if (loadedCharacter === `${name}|${gLang}`) return

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

  // 可选参考音频（用于情绪/语气素材；未配置则跳过，用声库默认）
  if (params.refAudioPath && params.refAudioText) {
    const refResp = await net.fetch(`${base}/set_reference_audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character_name: name,
        audio_path: params.refAudioPath,
        audio_text: params.refAudioText,
        language: gLang,
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
  // 3) 剔除空韵母语气字（无拼音，实测「嗯」「呣」触发三声合并越界）
  t = t.replace(/[嗯呣]/g, '')
  // 4) 其余字符原样保留；Genie 会用 pattern_filter 清理剩余非常规符号
  return t
}
/**
 * 调用 Genie /tts 合成并把裸 PCM/RIFF 封装为 WAV。
 * @param splitSentence 是否让服务端按语种分句拼接。中文用 true 更稳定；
 *       日语建议 false（Genie 日语分句脆弱，易返回空音频，用 false）。
 */
async function genieFetchWav(base: string, name: string, text: string, splitSentence = true): Promise<ArrayBuffer | null> {
  // 【诊断】确认实际发送给 Genie 的合成文本（判断是否因 stripBrackets 剥太薄而诱发复诵参考音频文本）
  console.log('[genie] tts text=%j', String(text).slice(0,120))
  const resp = await net.fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_name: name, text, split_sentence: splitSentence }),
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
  return wrapToWav(chunks)
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

/**
 * 使用 LLM API 将文本翻译为目标语言。
 * 用于日语 TTS 模型：AI 生成中文文本，翻译为日语后交给 GenieTTS 合成。
 */
async function translateText(text: string, targetLang: 'ja' | 'zh'): Promise<string> {
  try {
    const settings = await getSettings()
    const apiKey = await readApiKey()
    if (!apiKey || !settings.baseURL.trim() || !settings.model.trim()) {
      console.warn('[genie] 翻译跳过：未配置 LLM API')
      return text
    }
    const langName = targetLang === 'ja' ? '日语' : '中文'
    const result = await sendChatCompletion(
      [
        { role: 'system', content: `你是一个翻译助手。将用户输入的文本翻译为${langName}，只输出翻译结果，不要任何解释、注释或额外内容。保持原文的情感和语气。` },
        { role: 'user', content: text },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.3,
        stream: false,
        maxTokensOverride: 1024,
      },
    )
    return result.trim() || text
  } catch (err) {
    console.error('[genie] 翻译失败，使用原文合成', err)
    return text
  }
}

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
    // 服务未就绪且配置了环境路径 → 自动拉起一次（互斥：并发合成共用同一次启动）
    if (config.workPath && !serverProcess) {
      if (!startPromise) {
        startPromise = startGenieServer(config.workPath, config.baseUrl, config.dataDir).then(() => undefined)
        void startPromise.finally(() => {
          startPromise = null
        })
      }
      await startPromise
      // 轮询等待就绪：模型导入可能比固定 sleep 慢，最多等 20s
      for (let i = 0; i < 20; i++) {
        if (await probe(base)) break
        await new Promise((r) => setTimeout(r, 1000))
      }
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
    synthText = await translateText(text, 'ja')
    console.log('[genie] 翻译结果:', synthText.slice(0, 50))
  } else if (lang === 'ja') {
    console.log('[genie] 日语模式：文本已含日文，跳过翻译')
  }

  // 文本预处理（整组剔除（）心理/动作内容）规避 G2P 越界崩溃，再单次合成（保证参考音频只播一遍、不重复）
  const safeText = sanitizeGenieText(synthText)
  if (!safeText) {
    // 整段都在括号里（纯心理/动作/场景，无可朗读台词）
    throw new Error('该段内容均为心理/动作描写（括号内），没有可朗读的台词')
  }
  // 合成（失败自动重试一次）：服务端推理偶发失败（semantic_tokens None 崩溃 / 请求超时），
  // 重载角色可复位服务端状态，重试能显著提升成功率；重试仍失败才向上报错。
  let wav: ArrayBuffer | null = null
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      // 重试前强制重载角色（复位服务端推理状态），稍等片刻给 worker 恢复时间
      loadedCharacter = ''
      try {
        await ensureCharacterLoaded({ characterName: name, onnxModelDir, refAudioPath: effRefPath || undefined, refAudioText: effRefText || undefined }, base, lang)
      } catch (err) {
        loadedCharacter = ''
        throw err
      }
    }
    try {
      wav = await genieFetchWav(base, name, safeText, lang !== 'ja')
    } catch (err) {
      lastErr = err
      wav = null
      console.warn('[genie] 合成请求异常（第 %d 次）：%s', attempt, err instanceof Error ? err.message : String(err))
    }
    if (wav) break
    loadedCharacter = '' // 服务端推理状态可能已被污染，强制下次重载角色
    if (attempt === 1) {
      console.warn('[genie] 合成%s，重载角色后自动重试一次', lastErr ? '请求异常' : '为空音频')
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  if (!wav) {
    if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    throw new Error(`GenieTTS 生成为空音频（文本经安全化后仍无法合成，可疑片段：${safeText.slice(0, 30)}` + (safeText.length > 30 ? '…' : '') + '）')
  }
  return wav
}
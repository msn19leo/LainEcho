/**
 * 本地 SBV2（Style-Bert-VITS2）服务管理。
 *
 * 与 Genie-TTS 的区别：SBV2 不是 HTTP 服务，而是一个伴随进程（sidecar），
 * 主进程 spawn 它后用 stdin/stdout 走 NDJSON 协议。好处是没有端口占用、
 * 换声线不用重载进程；代价是要自己管进程生命周期与崩溃恢复。
 *
 * 只支持日文：调用方必须保证传入的文本已是日文（中文台词先翻译）。
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { app } from 'electron'
import path from 'path'
import { paths, readJson, writeJson } from './storage'
import { getTTSModel } from './repository'
import { translateWithCache } from './ttsTranslate'
import type { Sbv2Device, Sbv2ServerStatus, TTSsbv2Config } from '../../src/types'

const DEFAULT_CONFIG: TTSsbv2Config = {
  bertDir: '',
  device: 'cpu',
  sdpRatio: 0.2,
  exeDir: '',
}

/** 启动含加载 BERT，CPU 档约 2s、DML 档约 4.5s，留足余量 */
const START_TIMEOUT_MS = 120_000
/** 单段合成超时（长句 + 首次 kernel 编译） */
const SYNTH_TIMEOUT_MS = 180_000

let child: ChildProcess | null = null
let status: Sbv2ServerStatus = { state: 'stopped', message: '未启动' }
let startPromise: Promise<void> | null = null
/** 有意停止：用于区分「用户点停止」与「进程异常退出」 */
let intentionalStop = false
let requestSeq = 0
const pending = new Map<
  number,
  { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>()
let stdoutBuf = ''
/** 已在 sidecar 内加载的声线 ident（进程重启后清空） */
const loadedVoices = new Set<string>()
/** 合成串行化：sidecar 单会话，并发会污染 holder 状态 */
let synthChain: Promise<unknown> = Promise.resolve()

export class Sbv2Error extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'Sbv2Error'
  }
}

// ---------------------------------------------------------------- 配置

export async function getSbv2Config(): Promise<TTSsbv2Config> {
  const current = await readJson<Partial<TTSsbv2Config>>(paths.ttsSbv2ConfigFile, DEFAULT_CONFIG)
  return { ...DEFAULT_CONFIG, ...current }
}

/**
 * 保存配置（部分合并）。
 * 推理设备变更需要重建 ONNX 会话，因此在服务就绪时会自动重启一次。
 */
export async function saveSbv2Config(patch: Partial<TTSsbv2Config>): Promise<TTSsbv2Config> {
  const current = await getSbv2Config()
  const next: TTSsbv2Config = { ...current, ...patch }
  next.bertDir = (next.bertDir ?? '').trim()
  next.exeDir = (next.exeDir ?? '').trim()
  next.device = (next.device ?? 'cpu').trim() || 'cpu'
  const rawSdp = Number(next.sdpRatio)
  next.sdpRatio = Number.isFinite(rawSdp) ? Math.min(1, Math.max(0, rawSdp)) : 0.2
  await writeJson(paths.ttsSbv2ConfigFile, next)

  const deviceChanged = current.device !== next.device
  const bertChanged = current.bertDir !== next.bertDir
  if ((deviceChanged || bertChanged) && status.state === 'ready') {
    console.log('[sbv2] 配置变更，重启服务以重建会话')
    void restart()
  }
  return next
}

function setStatus(next: Sbv2ServerStatus): void {
  status = next
}

/** 权威状态：进程不在就一定不是 ready */
export function getSbv2Status(): Sbv2ServerStatus {
  if (!child && status.state !== 'stopped') {
    return { state: 'stopped', message: '未启动' }
  }
  return status
}

// ---------------------------------------------------------------- 路径

/** sidecar 目录：打包后 resources/sbv2，开发期 cargo 产物目录 */
export function resolveSidecarDir(cfg: TTSsbv2Config): string {
  if (cfg.exeDir.trim()) return cfg.exeDir.trim()
  if (app.isPackaged) return path.join(process.resourcesPath, 'sbv2')
  // dist/ 是「装配目录」：cargo clean 不会碰它，dll 与 exe 都放这里
  return path.join(app.getAppPath(), 'electron', 'services', 'sbv2-server', 'dist')
}

interface SidecarFiles {
  exe: string
  ortDll: string
}

function resolveSidecarFiles(cfg: TTSsbv2Config): SidecarFiles {
  const dir = resolveSidecarDir(cfg)
  return {
    exe: path.join(dir, 'sbv2-sidecar.exe'),
    ortDll: path.join(dir, 'onnxruntime.dll'),
  }
}

/** 校验 sidecar 与 DeBERTa 目录，返错信息（空串 = 通过） */
export function validateSbv2Setup(cfg: TTSsbv2Config): string {
  const files = resolveSidecarFiles(cfg)
  if (!fs.existsSync(files.exe)) {
    return `未找到 sidecar 程序：${files.exe}。若为开发环境请先执行 cargo build --release。`
  }
  if (!fs.existsSync(files.ortDll)) {
    return `未找到 onnxruntime.dll（应与 sidecar 同目录）：${files.ortDll}`
  }
  if (!cfg.bertDir.trim()) return '请先选择 DeBERTa 目录（含 deberta.onnx 与 tokenizer.json）'
  const bert = path.join(cfg.bertDir, 'deberta.onnx')
  const tok = path.join(cfg.bertDir, 'tokenizer.json')
  if (!fs.existsSync(bert)) return `DeBERTa 目录里缺少 deberta.onnx：${cfg.bertDir}`
  if (!fs.existsSync(tok)) return `DeBERTa 目录里缺少 tokenizer.json：${cfg.bertDir}`
  return ''
}

// ---------------------------------------------------------------- 协议

function request(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const proc = child
  if (!proc || !proc.stdin) {
    return Promise.reject(new Sbv2Error('NOT_RUNNING', 'SBV2 服务未启动'))
  }
  const id = ++requestSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Sbv2Error('TIMEOUT', `SBV2 响应超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      proc.stdin!.write(`${JSON.stringify({ id, ...payload })}\n`)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function handleStdoutChunk(chunk: string): void {
  stdoutBuf += chunk
  for (;;) {
    const idx = stdoutBuf.indexOf('\n')
    if (idx < 0) break
    const line = stdoutBuf.slice(0, idx).trim()
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (!line) continue
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.warn('[sbv2] 无法解析的输出:', line.slice(0, 200))
      continue
    }
    const id = typeof message.id === 'number' ? message.id : null
    if (id === null) continue
    const waiter = pending.get(id)
    if (!waiter) continue
    pending.delete(id)
    clearTimeout(waiter.timer)
    if (message.ok) waiter.resolve(message)
    else {
      const err = message.error as { code?: string; message?: string } | undefined
      waiter.reject(new Sbv2Error(err?.code ?? 'SIDECAR_ERROR', err?.message ?? 'SBV2 请求失败'))
    }
  }
}

function rejectAllPending(error: Error): void {
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  pending.clear()
}

// ---------------------------------------------------------------- 进程

function wireProcess(proc: ChildProcess): void {
  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => handleStdoutChunk(chunk))

  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    const text = String(chunk).trimEnd()
    if (text) console.log(text)
  })

  proc.on('error', (err) => {
    console.error('[sbv2] 进程错误:', err)
    setStatus({ state: 'error', message: `SBV2 进程启动失败：${err.message}` })
  })

  proc.on('exit', (code, signal) => {
    const wasIntentional = intentionalStop
    intentionalStop = false
    child = null
    loadedVoices.clear()
    rejectAllPending(new Sbv2Error('SERVICE_EXITED', 'SBV2 服务进程已退出'))
    if (wasIntentional) {
      setStatus({ state: 'stopped', message: '已停止' })
      return
    }
    const detail = signal ? `信号 ${signal}` : `退出码 ${code}`
    console.error(`[sbv2] 进程异常退出（${detail}）`)
    setStatus({
      state: 'error',
      message: `SBV2 服务已退出（${detail}）。若被杀毒软件拦截，请将安装目录加入白名单后重试。`,
    })
  })
}

/** 启动服务：spawn + 加载 BERT。已启动时复用同一个 Promise。 */
export async function startSbv2Server(): Promise<void> {
  if (status.state === 'ready' && child) return
  if (startPromise) return startPromise

  startPromise = (async () => {
    const cfg = await getSbv2Config()
    const invalid = validateSbv2Setup(cfg)
    if (invalid) throw new Sbv2Error('CONFIG_INVALID', invalid)

    const files = resolveSidecarFiles(cfg)
    setStatus({ state: 'starting', message: '正在加载模型…' })

    const proc = spawn(files.exe, [], {
      cwd: path.dirname(files.exe),
      env: { ...process.env, ORT_DYLIB_PATH: files.ortDll },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = proc
    intentionalStop = false
    stdoutBuf = ''
    wireProcess(proc)

    try {
      const res = await request(
        {
          cmd: 'load',
          bert: path.join(cfg.bertDir, 'deberta.onnx'),
          tokenizer: path.join(cfg.bertDir, 'tokenizer.json'),
          device: cfg.device,
        },
        START_TIMEOUT_MS,
      )
      const device = String(res.device ?? cfg.device)
      setStatus({ state: 'ready', message: `已就绪（${describeDevice(device)}）`, device, voices: [] })
      console.log(`[sbv2] 服务就绪，设备=${device}，加载耗时 ${res.loadMs}ms`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ state: 'error', message: `模型加载失败：${message}` })
      stopSbv2Server()
      throw err instanceof Sbv2Error ? err : new Sbv2Error('LOAD_FAILED', message)
    }
  })()

  try {
    await startPromise
  } finally {
    startPromise = null
  }
}

async function restart(): Promise<void> {
  await stopSbv2Server()
  try {
    await startSbv2Server()
  } catch (err) {
    console.error('[sbv2] 重启失败:', err)
  }
}

export function stopSbv2Server(): void {
  const proc = child
  if (!proc) {
    setStatus({ state: 'stopped', message: '未启动' })
    return
  }
  intentionalStop = true
  rejectAllPending(new Sbv2Error('SERVICE_STOPPING', 'SBV2 服务正在停止'))
  loadedVoices.clear()
  try {
    proc.stdin?.write(`${JSON.stringify({ id: ++requestSeq, cmd: 'quit' })}\n`)
  } catch {
    /* ignore */
  }
  // 给进程 1.5s 优雅退出，超时强杀
  const killer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }, 1500)
  proc.once('exit', () => clearTimeout(killer))
  setStatus({ state: 'stopped', message: '已停止' })
}

export function disposeSbv2Server(): void {
  if (child) {
    intentionalStop = true
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
}

// ---------------------------------------------------------------- 声线

/** 确保声线已在 sidecar 内加载（进程重启后会重新加载） */
async function ensureVoiceLoaded(ident: string, voicePath: string): Promise<void> {
  if (loadedVoices.has(ident)) return
  const res = await request({ cmd: 'voice', ident, path: voicePath, warmup: true }, START_TIMEOUT_MS)
  loadedVoices.add(ident)
  console.log(
    `[sbv2] 声线 ${ident} 已加载（${res.form}），load=${res.loadMs}ms warmup=${res.warmupMs}ms`,
  )
}

// ---------------------------------------------------------------- 文本规范化

/**
 * SBV2 / jtalk 只认假名与汉字，拉丁字母会让它「连不上音素」
 * （日志里的 `First mora cannot be chained`），进而拉出几十秒的噪音。
 * 日语译文里出现品牌名/型号是正常的，所以这里不是拒绝，而是转写成片假名读音。
 */
const LATIN_KANA: Record<string, string> = {
  gemini: 'ジェミニ',
  gpt: 'ジーピーティー',
  claude: 'クロード',
  openai: 'オープンエーアイ',
  bilibili: 'ビリビリ',
  youtube: 'ユーチューブ',
  twitter: 'ツイッター',
  google: 'グーグル',
  apple: 'アップル',
  windows: 'ウィンドウズ',
  android: 'アンドロイド',
  live2d: 'ライブツーディー',
  onnx: 'オニキス',
  vtuber: 'ブイチューバー',
  pixiv: 'ピクシブ',
  niconico: 'ニコニコ',
  ai: 'エーアイ',
  cpu: 'シーピーユー',
  gpu: 'ジーピーユー',
  api: 'エーピーアイ',
  url: 'ユーアールエル',
  pc: 'ピーシー',
  ok: 'オーケー',
  line: 'ライン',
  discord: 'ディスコード',
  github: 'ギットハブ',
  nvidia: 'エヌビディア',
  intel: 'インテル',
  // AI 厂商与模型名：不查表就会逐字母念（OpenAI → オーピーイーエヌエーアイ）
  anthropic: 'アンソロピック',
  meta: 'メタ',
  llama: 'ラマ',
  deepseek: 'ディープシーク',
  kimi: 'キミ',
  glm: 'ジーエルエム',
  bigmodel: 'ビッグモデル',
  qwen: 'クウェン',
  mistral: 'ミストラル',
  copilot: 'コパイロット',
  huggingface: 'ハギングフェイス',
  ollama: 'オラマ',
  groq: 'グロック',
  perplexity: 'パープレキシティ',
  moonshot: 'ムーンショット',
  bytedance: 'バイトダンス',
  alibaba: 'アリババ',
  baidu: 'バイドゥ',
  tencent: 'テンセント',
  microsoft: 'マイクロソフト',
  amazon: 'アマゾン',
  azure: 'アジュール',
  aws: 'エーダブリューエス',
  iphone: 'アイフォン',
  ipad: 'アイパッド',
  ios: 'アイオーエス',
  macos: 'マックオーエス',
  steam: 'スチーム',
  nintendo: 'ニンテンドー',
  playstation: 'プレイステーション',
}

const LETTER_KANA: Record<string, string> = {
  a: 'エー', b: 'ビー', c: 'シー', d: 'ディー', e: 'イー', f: 'エフ', g: 'ジー',
  h: 'エイチ', i: 'アイ', j: 'ジェー', k: 'ケー', l: 'エル', m: 'エム', n: 'エヌ',
  o: 'オー', p: 'ピー', q: 'キュー', r: 'アール', s: 'エス', t: 'ティー', u: 'ユー',
  v: 'ブイ', w: 'ダブリュー', x: 'エックス', y: 'ワイ', z: 'ゼット',
}

/** jtalk 连不上音素的符号（引号、反斜杠、花括号等），直接剔除 */
const UNSPEAKABLE_SYMBOLS = /[¿¡“”‘’"'`\\<>\[\]{}|^~@#$%&*_=+]/g

/**
 * 把日文文本里 jtalk 读不出来的部分转成可读形式。
 * - 拉丁词：查表 → 片假名；未命中 → 逐字母拼读
 * - 阿拉伯数字保持原样（jtalk 自己能读「2026年」这类数词，转拼音反而更差）
 * - 剩余符号剔除
 */
export function normalizeForJaTts(input: string): string {
  // 圆括号内容是动作/心理描写，按演出规范不朗读，整组剔除（与 Genie 的 sanitizeGenieText 对齐）。
  // 跑两遍是为了覆盖一层嵌套；剔空后调用方会收到空文本并跳过合成。
  let t = input
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
  // 全角英字 → 半角，便于统一处理（全角数字不动）
  t = t.replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  t = t.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, (m) => {
    const key = m.toLowerCase().replace(/['’]/g, '')
    const hit = LATIN_KANA[key]
    if (hit) return hit
    return [...key].map((ch) => LETTER_KANA[ch] ?? '').join('')
  })
  t = t.replace(UNSPEAKABLE_SYMBOLS, '')
  return t.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- 合成

export async function synthesizeSbv2(params: {
  /** 声线卡 id，作为 sidecar 内的 ident */
  ident: string
  /** 声线目录或 .sbv2 文件路径 */
  voicePath: string
  /** 日文文本（调用方负责先翻译） */
  text: string
  /** 随机度 sdp_ratio（0–1）；缺省由调用方从配置读，未给则用 0.2 */
  sdpRatio?: number
}): Promise<ArrayBuffer> {
  const text = (params.text ?? '').trim()
  if (!text) throw new Sbv2Error('TEXT_EMPTY', '合成文本为空')
  if (status.state !== 'ready' || !child) {
    throw new Sbv2Error(
      'SERVICE_NOT_READY',
      status.state === 'starting'
        ? 'SBV2 服务正在加载模型，请稍候再试'
        : 'SBV2 服务未启动，请在「设置 → 语音合成 → 本地 SBV2」中点击启动',
    )
  }

  // 送进 sidecar 前统一规范化：拉丁字母转假名、剔除 jtalk 读不出的符号，
  // 否则 jtalk 会在英文处断开并拉出一段噪音。
  const jaText = normalizeForJaTts(text)
  if (jaText !== text) {
    console.log('[sbv2] 文本规范化：%d 字 → %d 字', text.length, jaText.length)
  }
  if (!jaText.trim()) {
    throw new Sbv2Error('TEXT_UNSPEAKABLE', '文本里没有可朗读的内容（可能全是符号或英文缩写）')
  }

  const task = synthChain.then(async () => {
    await ensureVoiceLoaded(params.ident, params.voicePath)
    const res = await request(
      {
        cmd: 'synth',
        ident: params.ident,
        text: jaText,
        sdpRatio: params.sdpRatio ?? 0.2,
      },
      SYNTH_TIMEOUT_MS,
    )
    const b64 = String(res.wav ?? '')
    if (!b64) throw new Sbv2Error('SYNTH_EMPTY', 'SBV2 未返回音频数据')
    const buffer = Buffer.from(b64, 'base64')
    const copy = new ArrayBuffer(buffer.byteLength)
    new Uint8Array(copy).set(buffer)
    return copy
  })
  synthChain = task.catch(() => {})
  return task
}

/**
 * 从 TTS 模型卡合成（供「设置 → 语音合成」与剧情模式共用）。
 *
 * 把「取卡 → 校验 → 强制日文 → 中文翻译 → 下发随机度」收在一处：
 * 否则两条通道各写一份，改翻译策略时必然漏掉一边（46 秒噪音事故的教训）。
 * 调用方只负责自行决定要不要 applyAudioSpeed。
 */
export async function synthesizeSbv2FromCard(params: {
  ttsModelId: string
  text: string
}): Promise<ArrayBuffer> {
  const ident = params.ttsModelId
  const model = await getTTSModel(ident)
  if (!model) {
    throw new Sbv2Error('VOICE_NOT_FOUND', '声线卡不存在，请在「设置 → 语音合成 → 本地 SBV2」中重新绑定')
  }
  const voicePath = model.onnxModelDir?.trim()
  if (!voicePath) throw new Sbv2Error('VOICE_NOT_CONFIGURED', '声线卡未配置声线目录')

  // SBV2 只能读日文：中文台词先翻译（走预取缓存，剧情模式同样受益）
  let synthText = params.text.trim()
  const alreadyJa = /[\u3040-\u309F\u30A0-\u30FF]/.test(synthText)
  if (!alreadyJa) {
    console.log('[sbv2] 日语模式：翻译中文文本为日语')
    synthText = await translateWithCache(synthText, 'ja')
  }
  // 送进 sidecar 的最终文本：排查「乱音 / 超长」的第一现场（两条通道共用同一份日志）
  console.log(
    '[sbv2] 合成文本：%d 字 原%s → %j',
    synthText.length,
    alreadyJa ? '（已是日文）' : '（译文）',
    synthText.slice(0, 200),
  )

  const cfg = await getSbv2Config()
  const wav = await synthesizeSbv2({ ident, voicePath, text: synthText, sdpRatio: cfg.sdpRatio })
  console.log(
    '[sbv2] 合成完成：字数=%d 音频=%d 字节（约 %ss @44.1k 估算）',
    synthText.length,
    wav.byteLength,
    (wav.byteLength / 2 / 44100).toFixed(1),
  )
  return wav
}

// ---------------------------------------------------------------- 设备

function describeDevice(spec: string): string {
  if (spec === 'cpu' || spec === '') return 'CPU'
  if (spec === 'dml') return 'GPU（DirectML）'
  const m = /^dml:(\d+)$/.exec(spec)
  return m ? `显卡 #${m[1]}` : spec
}

/** 询问正在运行的进程；未运行时临时拉起一个只做枚举的子进程（不加载模型，几百毫秒） */
export async function listSbv2Devices(): Promise<Sbv2Device[]> {
  if (child) {
    const res = await request({ cmd: 'devices' }, 15_000)
    return (res.devices as Sbv2Device[]) ?? []
  }

  const cfg = await getSbv2Config()
  const files = resolveSidecarFiles(cfg)
  if (!fs.existsSync(files.exe)) return []

  return new Promise<Sbv2Device[]>((resolve) => {
    const proc = spawn(files.exe, [], {
      cwd: path.dirname(files.exe),
      env: { ...process.env, ORT_DYLIB_PATH: files.ortDll },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buf = ''
    let done = false
    const finish = (devices: Sbv2Device[]): void => {
      if (done) return
      done = true
      try {
        proc.stdin?.write(`${JSON.stringify({ id: 1, cmd: 'quit' })}\n`)
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      }, 300)
      resolve(devices)
    }
    const timer = setTimeout(() => finish([]), 10_000)
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { ok?: boolean; devices?: Sbv2Device[] }
          if (msg.ok && msg.devices) {
            clearTimeout(timer)
            finish(msg.devices)
            return
          }
        } catch {
          /* ignore */
        }
      }
    })
    proc.on('error', () => {
      clearTimeout(timer)
      finish([])
    })
    try {
      proc.stdin?.write(`${JSON.stringify({ id: 1, cmd: 'devices' })}\n`)
    } catch {
      clearTimeout(timer)
      finish([])
    }
  })
}

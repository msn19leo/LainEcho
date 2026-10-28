/**
 * TTS 音频变速（客户端后处理）：
 * 两个 TTS 引擎（Genie /tts 与 MiMo voiceclone）的请求体均不暴露语速参数，
 * 故在主进程合成返回后对音频做重采样变速——加速=按倍率抽采样点，减速=线性插值补点。
 *
 * - 变调特性：时间伸缩会同步改变音调（快放升高/慢放降低），与 GPT-SoVITS 原生
 *   speed_factor 的实现同本质，±20% 内可接受（UI 限 0.75–1.5）；
 * - 输入兼容两种形态：裸 int16 PCM（Genie /tts 输出）与 RIFF/WAV 容器（MiMo 输出）——
 *   按头部魔数区分，WAV 仅重采样 data chunk 并回写 RIFF/data 长度字段；
 * - 调用时机：必须在段级截断检测/重试之后（变速改变时长会令"时长/预期字数"比例失真，
 *   检测先行、变速殿后）。
 */

/** 变速倍率安全钳制（UI 限制 0.75–1.5，函数再兜底） */
const SPEED_MIN = 0.5
const SPEED_MAX = 2.0

/**
 * Int16 单声道 PCM 重采样变速（线性插值）。
 * @param pcm 输入采样
 * @param rate 倍率：>1 加速（输出更短），<1 减速（输出更长）
 */
export function resamplePcmI16(pcm: Int16Array, rate: number): Int16Array {
  const r = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate))
  if (!Number.isFinite(r) || Math.abs(r - 1) < 0.001 || pcm.length === 0) return pcm
  const outLen = Math.max(1, Math.round(pcm.length / r))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * r
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, pcm.length - 1)
    const frac = pos - i0
    // 线性插值：四舍五入回 int16
    const v = pcm[i0]! * (1 - frac) + pcm[i1]! * frac
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)))
  }
  return out
}

/** 在 RIFF 容器中定位 data chunk（遍历 chunk 列表，兼容带 LIST 等扩展块的非标准头） */
function findDataChunk(buf: Uint8Array): { dataStart: number; dataLen: number } | null {
  // 标准 44 字节头：RIFF(12) + fmt chunk(24) → data 在 36 偏移
  if (buf.length >= 44 && buf[36] === 0x64 && buf[37] === 0x61 && buf[38] === 0x74 && buf[39] === 0x61) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    return { dataStart: 44, dataLen: view.getUint32(40, true) }
  }
  // 扩展头：从 12 开始遍历 chunk（id 4B + size 4B + payload）
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!)
    const size = view.getUint32(off + 4, true)
    if (id === 'data') return { dataStart: off + 8, dataLen: Math.min(size, buf.length - off - 8) }
    off += 8 + size + (size % 2) // chunk 按 2 字节对齐
  }
  return null
}

/** ASCII 魔数判断是否 RIFF/WAV 容器 */
function isWavContainer(buf: Uint8Array): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45 // WAVE
  )
}

/**
 * 对合成结果做变速，返回新 ArrayBuffer（原缓冲不动）。
 * rate 缺省/≈1 时原样返回。裸 int16 PCM 直接重采样；WAV 容器重采样 data chunk 并回写长度。
 */
export function applyAudioSpeed(buf: ArrayBuffer, rate?: number | null): ArrayBuffer {
  const r = rate ?? 1
  if (!Number.isFinite(r) || Math.abs(r - 1) < 0.001) return buf
  const src = new Uint8Array(buf)
  if (isWavContainer(src)) {
    const loc = findDataChunk(src)
    if (!loc || loc.dataLen < 4) return buf
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
    const channels = view.getUint16(22, true) || 1 // fmt: channels @22
    const frameBytes = channels * 2 // int16
    const frames = Math.floor(loc.dataLen / frameBytes)
    const inPcm = new Int16Array(src.buffer, src.byteOffset + loc.dataStart, frames * channels)
    const outPcm = resamplePcmI16(inPcm, r) // 多声道交错样本按帧序列整体重采样（倍率语义一致）
    const outDataLen = outPcm.length * 2
    const out = new Uint8Array(loc.dataStart + outDataLen + (outDataLen % 2))
    out.set(src.subarray(0, loc.dataStart)) // 头部原样
    out.set(new Uint8Array(outPcm.buffer, outPcm.byteOffset, outDataLen), loc.dataStart)
    const outView = new DataView(out.buffer)
    outView.setUint32(loc.dataStart - 4, outDataLen, true) // data chunk size
    outView.setUint32(4, out.length - 8, true) // RIFF size
    return out.buffer
  }
  // 裸 int16 PCM（Genie /tts 输出）
  const inPcm = new Int16Array(buf)
  const outPcm = resamplePcmI16(inPcm, r)
  return outPcm.buffer.slice(0) as ArrayBuffer
}

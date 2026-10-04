/**
 * 将 PNG 转换为标准多尺寸 Windows 图标（默认 build/icon.png → build/icon.ico）。
 * 纯 Node 实现（zlib 解码/编码 + 自写 PNG 解析与合成），无任何第三方依赖。
 * 流程：校验 PNG 文件头 → 解析 PNG → 还原 RGBA 像素 →
 *       sRGB 空间重采样（保「白底黑线」类小尺寸细节；--linear 可切线性光对比）：
 *       超大缩小比先 box 面积低通到 4× 目标（无振铃，压制细碎素材的摩尔纹）
 *       → Lanczos-3 直降到目标尺寸（避免多级缩放的低通滤波累积发虚）
 *       → 输出钳位到窗口源值范围（抑制 Lanczos 负瓣在黑白硬边的振铃光晕）
 *       → 小尺寸做轻度 USM 锐化（48px 起用 5×5 模糊半径，alpha 通道单独加权）→
 *       各自编码为 PNG（自适应滤波与全 0 滤波各压一次取小者）→ 组装进 ICO 容器。
 * 用法：node scripts/png-to-ico.mjs [输入.png] [输出.ico] [--linear]
 */
import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 需要输出的图标尺寸。
 * 覆盖 Windows 标准规格 + 125%/150% DPI 常用量子（20/24/40/96）：
 * 缺失这些尺寸时 Windows 会拉伸邻近尺寸渲染，导致显示发糊。
 */
const SIZES = [256, 128, 96, 64, 48, 40, 32, 24, 20, 16]

/** 小尺寸 USM 锐化强度（amount），尺寸越小缩放后越虚所以越强；未列出的尺寸不锐化 */
const SHARPEN = { 16: 0.5, 20: 0.45, 24: 0.4, 32: 0.35, 40: 0.3, 48: 0.25, 64: 0.15 }

// ---------------- PNG 解码 ----------------

/**
 * 遍历 PNG 文件中的各 chunk。
 * @param {Buffer} buf PNG 字节
 * @returns {{ type: string, data: Buffer }[]}
 */
function parseChunks(buf) {
  const chunks = []
  let off = 8 // 跳过 8 字节签名
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push({ type, data })
    off += 12 + len // 长度(4) + 类型(4) + 数据(len) + CRC(4)
  }
  return chunks
}

/**
 * 解码 PNG，得到 RGBA 像素 Buffer。仅支持 8 位深度、非隔行的常见类型。
 * @param {Buffer} buf PNG 字节
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function decodePng(buf) {
  const chunks = parseChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')?.data
  if (!ihdr) throw new Error('缺少 IHDR 块')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}，仅支持 8 位`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)
  const raw = inflateSync(Buffer.concat(idat))

  /**
   * 字节数/行，按颜色类型换算 (每行前置 1 字节 filter)。
   * 0=灰度, 2=RGB, 4=灰度+A, 6=RGBA
   */
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!bpp) throw new Error(`不支持的色彩类型 ${colorType}`)

  const stride = width * bpp
  const rgba = Buffer.alloc(width * height * 4)
  let pos = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i]
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let val = x
      if (filter === 1) val = x + a // Sub
      else if (filter === 2) val = x + b // Up
      else if (filter === 3) val = x + ((a + b) >> 1) // Average（注意优先级：+ 先于 >>）
      else if (filter === 4) val = x + paeth(a, b, c) // Paeth
      line[i] = val & 0xff
    }
    pos += stride
    // 写入 RGBA 目标行（0=灰度 1通道, 2=RGB, 4=灰度+Alpha, 6=RGBA）
    for (let i = 0; i < width; i++) {
      const s = i * bpp
      const d = (y * width + i) * 4
      let r, g, b, a
      if (colorType === 0) { r = g = b = line[s]; a = 255 }
      else if (colorType === 4) { r = g = b = line[s]; a = line[s + 1] }
      else if (colorType === 2) { r = line[s]; g = line[s + 1]; b = line[s + 2]; a = 255 }
      else { r = line[s]; g = line[s + 1]; b = line[s + 2]; a = line[s + 3] }
      rgba[d] = r
      rgba[d + 1] = g
      rgba[d + 2] = b
      rgba[d + 3] = a
    }
    prev = line
  }
  return { width, height, rgba }
}

/**
 * Paeth 预测器（PNG filter type 4）。
 * @param {number} a 左像素
 * @param {number} b 上像素
 * @param {number} c 左上像素
 * @returns {number}
 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// ---------------- 缩放 ----------------

/**
 * Lanczos-3 核函数：锐利的经典重采样核，对缩小的边缘保持度优于双线性。
 * @param {number} x 距采样点中心的距离（像素）
 * @returns {number} 权重，距离≥3 时为 0
 */
function lanczosKernel(x) {
  if (x === 0) return 1
  const a = Math.PI * x
  const b = Math.PI * (x / 3)
  return (3 * Math.sin(a) * Math.sin(b)) / (a * b)
}

// ---- 线性光（gamma 正确）转换：sRGB 与线性空间互转 ----

/** sRGB(0..255) → 线性(0..1) 查表（源像素是 8 位整数，LUT 免去百万次 pow） */
const SRGB_TO_LINEAR = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * 线性(0..1) → sRGB(0..1)。
 * 直接在 sRGB 空间求平均会让黑白硬边算出「视觉上过暗」的中间值；
 * 在线性空间重采样再转回，边缘亮度符合人眼感知，小尺寸更透亮。
 * @param {number} v 线性值（越界钳位到 0..1）
 * @returns {number}
 */
function linearToSrgb(v) {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v
  return c <= 0.0031308 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055
}

/**
 * 沿单个轴做 Lanczos 重采样（可分离实现）。
 * 缩小（scale>1）时用源像素做带抗锯齿的加权平均；放大（scale<1）时插值。
 * 输出钳位到窗口内源值范围：Lanczos 负瓣在黑白硬边会产生振铃（光晕），
 * 钳位把过冲限制在局部色域内，USM 放大后也不会出现脏边。
 * @param {Float64Array|number[]} src 源轴数据（预乘后的线性 RGB 或直接 alpha）
 * @param {number} dstLen 目标长度
 * @param {number} scale 源长度 / 目标长度
 * @returns {Float64Array}
 */
function resampleAxis(src, dstLen, scale) {
  const out = new Float64Array(dstLen)
  // Lanczos 支撑半径随缩小比例放大，保证覆盖率避免摩尔纹
  const radius = scale > 1 ? 3 * scale : 3
  const stretched = Math.min(1 / scale, 1)
  const last = src.length - 1
  for (let x = 0; x < dstLen; x++) {
    const center = (x + 0.5) * scale - 0.5
    let start = Math.floor(center - radius)
    let end = Math.ceil(center + radius)
    if (start < 0) start = 0 // 边缘钳位而非环绕，避免图标边框出现亮/暗边
    if (end > last) end = last
    let sum = 0
    let wsum = 0
    let lo = Infinity
    let hi = -Infinity
    for (let sx = start; sx <= end; sx++) {
      const w = lanczosKernel((center - sx) * stretched)
      if (w === 0) continue
      const v = src[sx]
      sum += v * w
      wsum += w
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (wsum === 0) { out[x] = 0; continue }
    const val = sum / wsum
    out[x] = val < lo ? lo : val > hi ? hi : val
  }
  return out
}

/**
 * 沿单个轴做 box（面积）平均重采样——仅用于超大缩小比的第一级低通。
 * 全正权重、不可能过冲，无振铃；先低通到 4× 目标再交给 Lanczos，
 * 可压制细碎像素块（glitch 素材）在 16px 下的摩尔纹/跳变。
 * @param {Float64Array|number[]} src 源轴数据
 * @param {number} dstLen 目标长度
 * @param {number} scale 源长度 / 目标长度（须 ≥ 1）
 * @returns {Float64Array}
 */
function boxResampleAxis(src, dstLen, scale) {
  const out = new Float64Array(dstLen)
  const last = src.length
  for (let x = 0; x < dstLen; x++) {
    const a = x * scale
    const b = Math.min(last, (x + 1) * scale)
    const i0 = Math.floor(a)
    const i1 = Math.min(last - 1, Math.ceil(b) - 1)
    let sum = 0
    let wsum = 0
    for (let sx = i0; sx <= i1; sx++) {
      const w = Math.min(b, sx + 1) - Math.max(a, sx)
      if (w <= 0) continue
      sum += src[sx] * w
      wsum += w
    }
    out[x] = wsum > 0 ? sum / wsum : 0
  }
  return out
}

/**
 * 缩放到目标尺寸。管线：sRGB→线性光 → alpha 预乘 →
 * （超大缩小比先 box 面积低通到 4× 目标）→ Lanczos-3 分轴重采样（带振铃钳位）
 * → 除以 alpha 还原 → 线性→sRGB。
 * 线性光保证黑白硬边的中间值不过暗；预乘保证透明边缘无暗边；
 * 两级缩放里第一级 box 全正权重无振铃，压制细碎像素块的摩尔纹。
 * @param {{ width: number, height: number, rgba: Buffer }} src 源图
 * @param {number} size 目标边长（宽=高）
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function resize(src, size, linear = false) {
  const n = src.width * src.height
  const scale = src.width / size
  // 预乘（alpha 是覆盖率，保持原值）。linear=true 时先转线性光再预乘
  const L = linear ? SRGB_TO_LINEAR : null
  const ch = [0, 1, 2, 3].map(() => new Float64Array(n))
  for (let i = 0; i < n; i++) {
    const a = src.rgba[i * 4 + 3]
    const f = a / 255
    ch[0][i] = (L ? L[src.rgba[i * 4]] : src.rgba[i * 4]) * f
    ch[1][i] = (L ? L[src.rgba[i * 4 + 1]] : src.rgba[i * 4 + 1]) * f
    ch[2][i] = (L ? L[src.rgba[i * 4 + 2]] : src.rgba[i * 4 + 2]) * f
    ch[3][i] = a
  }

  /** 分轴重采样（先垂直逐列、后水平逐行），kernel='box' 用面积平均，否则 Lanczos */
  const resample = (arr, w, h, dstW, dstH, box) => {
    const fn = box ? boxResampleAxis : resampleAxis
    const tmp = new Float64Array(dstH * w)
    const sc1 = h / dstH
    for (let x = 0; x < w; x++) {
      const col = new Float64Array(h)
      for (let y = 0; y < h; y++) col[y] = arr[y * w + x]
      const rs = fn(col, dstH, sc1)
      for (let y = 0; y < dstH; y++) tmp[y * w + x] = rs[y]
    }
    const out = new Float64Array(dstW * dstH)
    const sc2 = w / dstW
    for (let y = 0; y < dstH; y++) {
      const rs = fn(tmp.subarray(y * w, (y + 1) * w), dstW, sc2)
      out.set(rs, y * dstW)
    }
    return out
  }

  let w = src.width
  let h = src.height
  let arrs = ch
  // 缩小比 > 4×：先 box 低通到 4× 目标（16px 对应 64px 中间层），再 Lanczos 收尾
  if (scale > 4) {
    const mid = size * 4
    arrs = arrs.map((a) => resample(a, w, h, mid, mid, true))
    w = mid
    h = mid
  }
  arrs = arrs.map((a) => resample(a, w, h, size, size, false))

  // 还原：线性空间除以 alpha，再转回 sRGB
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = Math.max(0, Math.min(255, Math.round(arrs[3][i])))
    rgba[i * 4 + 3] = a
    if (a > 0) {
      const inv = 255 / a
      for (let c = 0; c < 3; c++) {
        const v = arrs[c][i] * inv
        rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(linear ? linearToSrgb(v) * 255 : v)))
      }
    }
  }
  return { width: size, height: size, rgba }
}

/** 分离式卷积核：半径 1 = [1,2,1]/4；半径 2 = [1,4,6,4,1]/16（高斯近似） */
const KERNELS = { 1: { k: [1, 2, 1], norm: 4 }, 2: { k: [1, 4, 6, 4, 1], norm: 16 } }

/**
 * 可分离高斯模糊（半径 1 或 2），在预乘 alpha 空间处理，
 * 透明边缘不会渗入黑色。仅作为 USM 锐化的模糊基准使用。
 * @param {{ width: number, height: number, rgba: Buffer }} img 输入图
 * @param {number} radius 模糊半径（1 = 3×3，2 = 5×5；48px 起用 2 更有效）
 * @returns {number[][]} 四通道（预乘 RGB + alpha）模糊结果
 */
function blur(img, radius = 1) {
  const { width, height, rgba } = img
  const n = width * height
  const { k, norm } = KERNELS[radius] ?? KERNELS[1]
  const half = k.length >> 1
  const ch = [0, 1, 2, 3].map((c) => {
    const a = new Array(n)
    for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + c]
    return a
  })
  for (let i = 0; i < n; i++) {
    const a = ch[3][i] / 255
    ch[0][i] *= a
    ch[1][i] *= a
    ch[2][i] *= a
  }
  // 水平卷积
  const horiz = ch.map((src) => {
    const out = new Array(n)
    for (let y = 0; y < height; y++) {
      const base = y * width
      for (let x = 0; x < width; x++) {
        let acc = 0
        for (let j = -half; j <= half; j++) {
          const sc = x + j < 0 ? 0 : x + j >= width ? width - 1 : x + j
          acc += src[base + sc] * k[j + half]
        }
        out[base + x] = acc / norm
      }
    }
    return out
  })
  // 垂直卷积
  return horiz.map((src) => {
    const out = new Array(n)
    for (let y = 0; y < height; y++) {
      const rows = []
      for (let j = -half; j <= half; j++) {
        const sy = y + j < 0 ? 0 : y + j >= height ? height - 1 : y + j
        rows.push(sy * width)
      }
      for (let x = 0; x < width; x++) {
        let acc = 0
        for (let j = 0; j <= half * 2; j++) acc += src[rows[j] + x] * k[j]
        out[y * width + x] = acc / norm
      }
    }
    return out
  })
}

/**
 * USM 锐化（Unsharp Mask）：out = 原图 + amount × (原图 - 模糊)。
 * 图标缩小后边缘对比度下降、观感发虚，轻度锐化可显著找回清晰度。
 * 在预乘空间计算，最后按新 alpha 还原，透明边缘无暗边。
 * alpha 通道单独加权（×1.25、封顶 0.75）：扁平图标里轮廓锐度由 alpha 主导。
 * @param {{ width: number, height: number, rgba: Buffer }} img 输入图
 * @param {number} amount 锐化强度（0.1~0.6 为合理范围）
 * @param {number} radius 模糊半径（小尺寸 1，48px 起 2）
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function unsharpMask(img, amount, radius = 1) {
  const { width, height, rgba } = img
  const bl = blur(img, radius)
  const aAmt = Math.min(0.75, amount * 1.25)
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const a0 = rgba[i * 4 + 3]
    const a = Math.max(0, Math.min(255, Math.round(a0 + aAmt * (a0 - bl[3][i]))))
    out[i * 4 + 3] = a
    if (a <= 0) continue
    const inv = 255 / a
    for (let c = 0; c < 3; c++) {
      const o = (rgba[i * 4 + c] * a0) / 255
      const v = o + amount * (o - bl[c][i])
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * inv)))
    }
  }
  return { width, height, rgba: out }
}

// ---------------- PNG 编码 ----------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * 计算 CRC32。
 * @param {Buffer} buf 输入
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 生成一个 PNG chunk。 */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/**
 * 将 RGBA 像素编码为 PNG（8 位 RGBA、非隔行）。
 * 逐行自适应滤波（0..4 取绝对值和最小者）与全 0 滤波各 deflate 一次、取体积小者：
 * 纯色图形上两者胜负不定（大面积同色行 filter 0 的重复字节反而更好压），
 * 取小保底，配合最高压缩率让 ICO 尽量小。
 * @param {{ width: number, height: number, rgba: Buffer }} img
 * @returns {Buffer}
 */
function encodePng(img) {
  const { width, height, rgba } = img
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type = RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = width * 4
  const bpp = 4
  const rawLen = (stride + 1) * height

  /** 生成滤波后的原始行流。adaptive=false → 全部 filter 0；true → 逐行选绝对值和最小的滤波 */
  const buildRaw = (adaptive) => {
    const raw = Buffer.alloc(rawLen)
    const cand = Buffer.alloc(stride)
    let best = Buffer.alloc(stride)
    let prev = Buffer.alloc(stride)
    for (let y = 0; y < height; y++) {
      const row = rgba.subarray(y * stride, (y + 1) * stride)
      if (!adaptive) {
        raw[y * (stride + 1)] = 0
        row.copy(raw, y * (stride + 1) + 1)
        prev = row
        continue
      }
      let bestSum = Infinity
      let bestFilter = 0
      for (let f = 0; f < 5; f++) {
        let sum = 0
        for (let i = 0; i < stride; i++) {
          const x = row[i]
          const a = i >= bpp ? row[i - bpp] : 0
          const b = prev[i]
          const c = i >= bpp ? prev[i - bpp] : 0
          let v
          if (f === 0) v = x
          else if (f === 1) v = x - a
          else if (f === 2) v = x - b
          else if (f === 3) v = x - ((a + b) >> 1)
          else v = x - paeth(a, b, c)
          v &= 0xff
          cand[i] = v
          sum += v < 128 ? v : 256 - v // 看作有符号字节的绝对值
        }
        if (sum < bestSum) {
          bestSum = sum
          bestFilter = f
          best = Buffer.from(cand)
        }
      }
      raw[y * (stride + 1)] = bestFilter
      best.copy(raw, y * (stride + 1) + 1)
      prev = row
    }
    return raw
  }

  const idatAdaptive = deflateSync(buildRaw(true), { level: 9 })
  const idatNone = deflateSync(buildRaw(false), { level: 9 })
  const idat = idatNone.length <= idatAdaptive.length ? idatNone : idatAdaptive
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------- ICO 组装 ----------------

/**
 * 将多个尺寸的 PNG 组装成一个多尺寸 ICO。
 * @param {{ size: number, png: Buffer }[]} images
 * @returns {Buffer}
 */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(images.length, 4) // 图片数量

  const dirSize = 16 * images.length
  const dir = Buffer.alloc(dirSize)
  const dataBlocks = []
  let offset = 6 + dirSize
  images.forEach((img, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16)
    e.writeUInt8(Math.min(img.size, 255) === img.size && img.size < 256 ? img.size : 0, 0) // width（≥256 记 0=256）
    e.writeUInt8(Math.min(img.size, 255) === img.size && img.size < 256 ? img.size : 0, 1) // height
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(img.png.length, 8) // 数据长度
    e.writeUInt32LE(offset, 12) // 数据偏移
    dataBlocks.push(img.png)
    offset += img.png.length
  })
  return Buffer.concat([header, dir, ...dataBlocks])
}

// ---------------- 主流程 ----------------

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
// --linear：切换到线性光（gamma 正确）重采样。实测对「白底黑线」类细节（脸部/发丝）
// 会使其变淡、小尺寸观感反而不如 sRGB 直接平均，故默认关闭，仅保留供对比实验。
const useLinear = args.includes('--linear')
const pos = args.filter((a) => !a.startsWith('--'))
const inPath = pos[0] ? resolve(pos[0]) : resolve(here, '../build/icon.png')
const outPath = pos[1] ? resolve(pos[1]) : resolve(here, '../build/icon.ico')

// 文件头校验：最常见的事故是把 JPEG 改名成 .png——手写解析器遇到会崩，
// 这里提前拦下并给出可读的修复指引。
let bytes
try {
  bytes = readFileSync(inPath)
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(
      `错误：找不到输入文件 ${inPath}\n` +
        `请先把 ≥512×512 的图标母版存为该路径，或直接指定文件：\n` +
        `  node scripts/png-to-ico.mjs <输入.png> [输出.ico]`,
    )
    process.exit(1)
  }
  throw err
}
const isPng =
  bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
if (!isPng) {
  const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'JPEG 图片' : '未知格式'
  console.error(
    `错误：${basename(inPath)} 不是真正的 PNG（检测到 ${kind}）。\n` +
      `请用图片工具重新导出为 PNG（不要只改扩展名），再运行本脚本。`,
  )
  process.exit(1)
}
const src = decodePng(bytes)

// 每个目标尺寸都从原始大图直接缩放：多级链式缩放会让每次重采样的低通滤波
// 逐级累积（16px 要经过 4~5 次缩放），小尺寸明显发虚；单次带抗锯齿的
// Lanczos-3 缩小反而更锐利。小尺寸再叠加轻度 USM 锐化找回边缘对比。
const images = SIZES.map((size) => {
  let img = resize(src, size, useLinear)
  const amount = SHARPEN[size]
  if (amount) img = unsharpMask(img, amount, size >= 40 ? 2 : 1)
  return { size, png: encodePng(img) }
})

const ico = encodeIco(images)
writeFileSync(outPath, ico)
console.log(
  `已生成 ${outPath} (${src.width}x${src.height} → 尺寸 ${SIZES.join('/')}, ${ico.length} bytes)`,
)
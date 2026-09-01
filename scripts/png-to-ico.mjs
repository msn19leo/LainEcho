/**
 * 将 build/icon.png 转换为标准多尺寸 Windows 图标 build/icon.ico。
 * 纯 Node 实现（zlib 解码/编码 + 自写 PNG 解析与合成），无任何第三方依赖。
 * 流程：解析 PNG → 还原 RGBA 像素 → 逐级缩放到多个尺寸 → 各自编码为 PNG →
 *       组装进 ICO 容器（每个尺寸一个目录项）。
 * 用法：node scripts/png-to-ico.mjs
 */
import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要输出的图标尺寸（Windows 图标标准规格） */
const SIZES = [256, 128, 64, 48, 32, 16]

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
      else if (filter === 3) val = x + (a + b) >> 1 // Average
      else if (filter === 4) val = x + paeth(a, b, c) // Paeth
      line[i] = val & 0xff
    }
    pos += stride
    // 写入 RGBA 目标行
    for (let i = 0; i < width; i++) {
      const s = i * bpp
      const d = (y * width + i) * 4
      const r = colorType === 0 || colorType === 4 ? line[s] : line[s]
      const g = colorType === 0 || colorType === 4 ? line[s] : line[s + 1]
      const b = colorType === 0 || colorType === 4 ? line[s] : line[s + (colorType === 2 ? 2 : 2)]
      const a = colorType === 4 || colorType === 6 ? line[s + bpp - 1] : 255
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

/**
 * 沿单个轴做 Lanczos 重采样（可分离实现）。
 * 缩小（scale>1）时用源像素做带抗锯齿的加权平均；放大（scale<1）时插值。
 * @param {number[]} src 源轴数据（预乘后的 RGB 或直接 alpha）
 * @param {number} dstLen 目标长度
 * @param {number} scale 源长度 / 目标长度
 * @returns {number[]}
 */
function resampleAxis(src, dstLen, scale) {
  const out = new Array(dstLen)
  // Lanczos 支撑半径随缩小比例放大，保证覆盖率避免摩尔纹
  const radius = scale > 1 ? 3 * scale : 3
  for (let x = 0; x < dstLen; x++) {
    const center = (x + 0.5) * scale - 0.5
    const start = Math.floor(center - radius)
    const end = Math.ceil(center + radius)
    let sum = 0
    let wsum = 0
    for (let sx = start; sx <= end; sx++) {
      if (sx < 0 || sx >= src.length) continue
      const w = lanczosKernel((center - sx) * Math.min(1 / scale, 1))
      sum += src[sx] * w
      wsum += w
    }
    out[x] = wsum > 0 ? sum / wsum : 0
  }
  return out
}

/**
 * 双线性缩放到目标尺寸（带 alpha 预乘 + Lanczos-3，边缘更锐利、透明边缘无暗边）。
 * 流程：先把 RGB 与 alpha 预乘，分两个轴重采样，最后除以 alpha 还原。
 * @param {{ width: number, height: number, rgba: Buffer }} src 源图
 * @param {number} size 目标边长（宽=高）
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function resize(src, size) {
  const scale = src.width / size
  // 拆成四通道数组，便于按轴重采样
  const ch = [0, 1, 2, 3].map((c) => {
    const a = new Array(src.width * src.height)
    for (let i = 0; i < a.length; i++) a[i] = src.rgba[i * 4 + c]
    return a
  })
  // 预乘：RGB × alpha/255，alpha 通道本身不动
  for (let i = 0; i < src.width * src.height; i++) {
    const a = ch[3][i]
    ch[0][i] = (ch[0][i] * a) / 255
    ch[1][i] = (ch[1][i] * a) / 255
    ch[2][i] = (ch[2][i] * a) / 255
  }

  // 垂直重采样：逐列把 (h×w) 压到 (size×w)
  for (let c = 0; c < 4; c++) {
    const temp = new Array(size * src.width)
    for (let x = 0; x < src.width; x++) {
      const col = new Array(src.height)
      for (let y = 0; y < src.height; y++) col[y] = ch[c][y * src.width + x]
      const rs = resampleAxis(col, size, scale)
      for (let y = 0; y < size; y++) temp[y * src.width + x] = rs[y]
    }
    ch[c] = temp
  }
  // 水平重采样：逐行把 (size×w) 压到 (size×size)
  for (let c = 0; c < 4; c++) {
    const row = new Array(src.width)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < src.width; x++) row[x] = ch[c][y * src.width + x]
      const rs = resampleAxis(row, size, scale)
      for (let x = 0; x < size; x++) ch[c][y * size + x] = rs[x]
    }
  }

  // 还原：RGB 除以 alpha，输出 RGBA Buffer
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = Math.max(0, Math.min(255, Math.round(ch[3][i])))
    rgba[i * 4 + 3] = a
    if (a > 0) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(ch[c][i] / (a / 255))))
    }
  }
  return { width: size, height: size, rgba }
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
 * 将 RGBA 像素编码为 PNG（8 位 RGBA、非隔行、每行 filter=0）。
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
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
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

const inPath = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.png')
const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.ico')

const src = decodePng(readFileSync(inPath))

// 逐级缩放：先缩到最大目标尺寸（256），再依次以「上一级结果」缩到更小尺寸，
// 相比每次都从原始大图直接缩，过渡更平滑、小尺寸细节更好。
const images = []
let current = src
for (const size of SIZES) {
  current = resize(current, size)
  images.push({ size, png: encodePng(current) })
}

const ico = encodeIco(images)
writeFileSync(outPath, ico)
console.log(
  `已生成 ${outPath} (${src.width}x${src.height} → 尺寸 ${SIZES.join('/')}, ${ico.length} bytes)`,
)
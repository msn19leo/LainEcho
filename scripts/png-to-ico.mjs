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
 * 双线性缩放到目标尺寸，输出 RGBA Buffer。
 * @param {{ width: number, height: number, rgba: Buffer }} src 源图
 * @param {number} size 目标边长（宽=高）
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function resize(src, size) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = src.width / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x * scale
      const sy = y * scale
      const x0 = Math.min(Math.floor(sx), src.width - 1)
      const y0 = Math.min(Math.floor(sy), src.height - 1)
      const x1 = Math.min(x0 + 1, src.width - 1)
      const y1 = Math.min(y0 + 1, src.height - 1)
      const fx = sx - x0
      const fy = sy - y0
      const d = (y * size + x) * 4
      for (let c = 0; c < 4; c++) {
        const v00 = src.rgba[(y0 * src.width + x0) * 4 + c]
        const v10 = src.rgba[(y0 * src.width + x1) * 4 + c]
        const v01 = src.rgba[(y1 * src.width + x0) * 4 + c]
        const v11 = src.rgba[(y1 * src.width + x1) * 4 + c]
        rgba[d + c] = Math.round(v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy)
      }
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
const images = SIZES.map((size) => ({ size, png: encodePng(resize(src, size)) }))
const ico = encodeIco(images)
writeFileSync(outPath, ico)
console.log(
  `已生成 ${outPath} (${src.width}x${src.height} → 尺寸 ${SIZES.join('/')}, ${ico.length} bytes)`,
)
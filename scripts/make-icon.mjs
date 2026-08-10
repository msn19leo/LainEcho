/**
 * 生成 build/icon.png（应用图标 + 托盘图标）。
 * 纯 Node 实现 PNG 编码（zlib），无需任何图像库。
 * 用法：node scripts/make-icon.mjs [size]
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = Number(process.argv[2]) || 256

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

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每行前置 filter byte 0
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

// ---------------- 绘制 ----------------

const px = Buffer.alloc(SIZE * SIZE * 4)

function setPixel(x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  // alpha 混合
  const srcA = a / 255
  const dstA = px[i + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA === 0) return
  px[i] = Math.round((r * srcA + px[i] * dstA * (1 - srcA)) / outA)
  px[i + 1] = Math.round((g * srcA + px[i + 1] * dstA * (1 - srcA)) / outA)
  px[i + 2] = Math.round((b * srcA + px[i + 2] * dstA * (1 - srcA)) / outA)
  px[i + 3] = Math.round(outA * 255)
}

function fillCircle(cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      if (d <= r) {
        // 抗锯齿边缘
        const alpha = Math.min(1, r - d + 0.5) * 255
        setPixel(x, y, [...color, alpha])
      }
    }
  }
}

// 背景渐变（左上紫 → 右下靛蓝）
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = (x + y) / (2 * (SIZE - 1))
    const r = Math.round(139 + (99 - 139) * t)
    const g = Math.round(92 + (102 - 92) * t)
    const b = Math.round(246 + (241 - 246) * t)
    setPixel(x, y, [r, g, b])
  }
}

// 桌宠「猫娘脸」：白底圆头 + 眼睛 + 腮红
const cx = SIZE / 2
const cy = SIZE / 2 + SIZE * 0.03
const headR = SIZE * 0.36
fillCircle(cx, cy, headR, [255, 255, 255])
fillCircle(cx, cy, headR * 0.28, [255, 255, 255]) // 强化圆润

// 猫耳（两个小三角 → 用圆近似）
fillCircle(cx - headR * 0.62, cy - headR * 0.82, headR * 0.3, [255, 255, 255])
fillCircle(cx + headR * 0.62, cy - headR * 0.82, headR * 0.3, [255, 255, 255])

// 眼睛
fillCircle(cx - headR * 0.35, cy + headR * 0.05, headR * 0.1, [43, 46, 56])
fillCircle(cx + headR * 0.35, cy + headR * 0.05, headR * 0.1, [43, 46, 56])

// 腮红
fillCircle(cx - headR * 0.62, cy + headR * 0.42, headR * 0.13, [251, 146, 184, 180])
fillCircle(cx + headR * 0.62, cy + headR * 0.42, headR * 0.13, [251, 146, 184, 180])

// 小嘴（圆）
fillCircle(cx, cy + headR * 0.38, headR * 0.08, [43, 46, 56])

// ---------------- 输出 ----------------
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(SIZE, SIZE, px))
console.log(`已生成 ${out} (${SIZE}x${SIZE})`)

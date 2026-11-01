/**
 * pet-res:// 自定义协议 —— 为渲染进程提供本地资源访问（Cubism Core / Live2D 模型资源）。
 *
 * 需要在 app ready 之前调用 registerSchemesAsPrivileged（在 main.ts 模块顶层完成），
 * ready 之后再调用 registerPetProtocolHandler 挂接实际处理。
 *
 * URL 约定：
 *   pet-res://core/<filename>            -> userData/live2d-core/<filename>
 *   pet-res://models/<modelId>/<...>     -> userData/models/<modelId>/<...>
 *
 * 安全性：解析后的绝对路径必须落在受控根目录内，防止路径穿越。
 */
import { app, protocol } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { paths } from './storage'

export const PET_SCHEME = 'pet-res'

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.moc3': 'application/octet-stream',
  '.physics3.json': 'application/json',
  '.motion3.json': 'application/json',
  '.exp3.json': 'application/json',
  '.cubism': 'application/octet-stream',
  '.cubismp': 'application/octet-stream',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
}

function mimeFor(filePath: string): string {
  // 优先匹配带后缀的多段扩展名（如 .motion3.json）
  for (const key of Object.keys(MIME_TYPES)) {
    if (filePath.endsWith(key)) return MIME_TYPES[key] ?? 'application/octet-stream'
  }
  return 'application/octet-stream'
}

/** 必须在 app ready 前调用 */
export function registerPetSchemesPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/** 在 app ready 后调用 */
export function registerPetProtocolHandler(): void {
  protocol.handle(PET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const host = url.host // 'core' 或 'models'
      // decodeURIComponent 处理中文文件名
      const pathname = decodeURIComponent(url.pathname)

      let root: string
      if (host === 'core') {
        root = paths.coreDir
      } else if (host === 'models') {
        root = paths.modelsDir
      } else if (host === 'sprites') {
        // 2D 立绘资源：pet-res://sprites/{spriteId}/{filePath}
        root = paths.spritesDir
      } else if (host === 'stories') {
        // 剧本资源（背景/音乐/封面）：pet-res://stories/{scriptId}/{filePath}
        root = paths.storiesDir
      } else if (host === 'story-backgrounds') {
        // 剧情背景库（用户上传）：pet-res://story-backgrounds/{文件名}
        root = paths.storyBackgroundsDir
      } else if (host === 'story-music') {
        // 剧情音乐库（用户上传）：pet-res://story-music/{文件名}
        root = paths.storyMusicsDir
      } else if (host === 'chat-images') {
        // 聊天图片附件：pet-res://chat-images/{sessionId}/{fileName}
        root = paths.chatImagesDir
      } else {
        return new Response('Unknown host', { status: 404 })
      }

      // 路径穿越防护：规范化后必须仍位于根目录内
      const resolved = path.normalize(path.join(root, pathname))
      const rel = path.relative(root, resolved)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return new Response('Forbidden', { status: 403 })
      }

      // 解析真实路径再校验一次：防止模型目录内 symlink 指向根目录外的文件
      const real = await fs.realpath(resolved).catch(() => null)
      if (real) {
        const realRel = path.relative(root, real)
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return new Response('Forbidden', { status: 403 })
        }
      }

      const file = real ?? resolved
      const mime = mimeFor(resolved)

      /**
       * 支持 HTTP Range —— 音频播放的必需项。
       *
       * 不实现 Range 时 `<audio>` 的表现（实测）：
       * 1. 拖动进度条 → 播放器无法定位，退回重新加载整段 → 进度归零、从头播；
       * 2. 没有 Content-Length → Chromium 用「已下载字节 ÷ 码率」估算总时长，
       *    随下载推进不断修正（可见总时长从 4:03 涨到 5:07）。
       * 所以：能 stat 就必须返回 Content-Length + Accept-Ranges，并对 Range 请求回 206。
       */
      const stat = await fs.stat(file)
      const total = stat.size
      const rangeHeader = request.headers.get('range')

      if (rangeHeader) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
        if (parsed) {
          let start = parsed[1] ? Number.parseInt(parsed[1], 10) : Number.NaN
          let end = parsed[2] ? Number.parseInt(parsed[2], 10) : Number.NaN
          if (Number.isNaN(start)) {
            // bytes=-N：末尾 N 字节
            const suffix = Number.isNaN(end) ? 0 : end
            start = Math.max(0, total - suffix)
            end = total - 1
          } else if (Number.isNaN(end)) {
            // bytes=start-：到文件末尾
            end = total - 1
          }
          start = Math.max(0, start)
          end = Math.min(end, total - 1)

          if (start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
            })
          }

          // 只读所需切片：整段 readFile 在长音频上会让内存翻倍
          const len = end - start + 1
          const buf = Buffer.alloc(len)
          const fh = await fs.open(file, 'r')
          try {
            await fh.read(buf, 0, len, start)
          } finally {
            await fh.close()
          }
          return new Response(buf, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(len),
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            },
          })
        }
      }

      const data = await fs.readFile(file)
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** 判断 URL 是否为 pet-res:// */
export function isPetResourceUrl(raw: string): boolean {
  return raw.startsWith(`${PET_SCHEME}://`)
}

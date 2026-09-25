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

      const data = await fs.readFile(real ?? resolved)
      return new Response(data, {
        headers: {
          'Content-Type': mimeFor(resolved),
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

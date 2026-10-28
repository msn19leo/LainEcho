/**
 * 输入区（InputArea）—— 替代旧 MessageInput。
 *
 * 设计：
 *   - 输入框：12px 圆角（规范），自动拉伸高度（rows 自适应，max-h 限制）。
 *   - 聚焦态：主色光晕环（0 0 0 3px primary-glow）。
 *   - 发送按钮：粉色渐变（accent-gradient）+ 粉色光晕，hover 加亮。
 *   - 流式中显示「停止」按钮（danger 边框）。
 *   - Enter 发送 / Shift+Enter 换行；中文输入法合成中不触发发送。
 *   - 图片附件：只做粘贴与拖拽两条入口（不做文件选择/截屏按钮），单条最多 4 张；
 *     附件在输入框上方以缩略图条呈现，可单张移除。
 *   - 草稿（文字 + 未发送的图片）存在 draftStore 并按会话隔离：折叠面板、
 *     关闭重开窗口都不会丢（详见 draftStore 头注释）。
 */
import { useEffect, useRef, useState } from 'react'
import { Send, Square, X } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useSettingsStore } from '../store/settingsStore'
import { NEW_SESSION_DRAFT_KEY, useDraftStore } from '../store/draftStore'
import { api } from '../api'
import { toast } from '../components/toast'
import { Lightbox } from '../components/Lightbox'
import { ChatImageThumb } from '../components/ChatImageThumb'
import type { ChatImage } from '../types'

/** 单条消息最多附带的图片数（硬上限：满额后第 5 张拖不进/粘不上） */
const MAX_IMAGES = 4
/** 允许的源格式（与主进程 chatImages 白名单保持一致，提前拦截给更快的反馈） */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])
/** 稳定的空数组：避免 store 缺失草稿时每次渲染都换新引用 */
const NO_IMAGES: ChatImage[] = []

export function InputArea() {
  const streaming = useSessionStore((s) => s.streaming)
  const rewinding = useSessionStore((s) => s.rewinding)
  const send = useSessionStore((s) => s.send)
  const stop = useSessionStore((s) => s.stop)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const imagesEnabled = useSettingsStore((s) => s.settings.vision.chatImagesEnabled)

  /** 草稿键：未建会话时用 `__new__`，会话创建后迁移（见下方 effect） */
  const draftKey = currentSessionId ?? NEW_SESSION_DRAFT_KEY
  const draft = useDraftStore((s) => s.drafts[draftKey])
  const patchDraft = useDraftStore((s) => s.patch)
  const clearDraft = useDraftStore((s) => s.clear)
  const value = draft?.text ?? ''
  const images = draft?.images ?? NO_IMAGES

  /** 附件落盘中（压缩+写盘），期间禁止发送与再次添加 */
  const [attaching, setAttaching] = useState(false)
  /** 文件拖拽悬停（整窗浮现投放区） */
  const [dragActive, setDragActive] = useState(false)
  /** 预览大图 */
  const [preview, setPreview] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** 最新的 attachFiles 引用（document 级 drop 监听只在挂载时绑定一次，靠 ref 取最新闭包） */
  const attachRef = useRef<((files: File[]) => Promise<void>) | null>(null)
  /** 上一轮的会话 id：用于识别"从无会话变为有会话"的瞬间 */
  const prevSessionId = useRef<string | null>(currentSessionId)

  // 会话首次创建后，把 `__new__` 下的草稿迁到真实会话 id（目标已有草稿时 store 内部会跳过）
  useEffect(() => {
    if (currentSessionId && prevSessionId.current !== currentSessionId) {
      useDraftStore.getState().migrate(NEW_SESSION_DRAFT_KEY, currentSessionId)
    }
    prevSessionId.current = currentSessionId
  }, [currentSessionId])

  // 流式/重答结束后重新聚焦输入框
  useEffect(() => {
    if (!streaming && !rewinding) textareaRef.current?.focus()
  }, [streaming, rewinding])

  /**
   * 窗口级拖拽兜底：
   * 1) Electron 会把拖入的文件当作导航目标，不拦会导致整个渲染进程跳到 file:// 白屏；
   * 2) 落点统一在 document 处理——拖到聊天窗任意位置都能添加，不要求精准落在输入区。
   * 只拦带 Files 的拖拽，文本拖拽不受影响。
   */
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
    const onDragOver = (e: DragEvent) => {
      // 必须阻止默认行为，否则 drop 不会触发（HTML5 拖放规范）；
      // 同时也阻止 Electron 把文件当导航目标（否则整个渲染进程跳到 file:// 白屏）
      if (isFileDrag(e)) e.preventDefault()
    }
    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      setDragActive(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      // relatedTarget 为 null = 真正离开了窗口（子元素间的 leave 不算）
      if (e.relatedTarget === null) setDragActive(false)
    }
    const onDropAnywhere = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      setDragActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) void attachRef.current?.(files)
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDropAnywhere)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDropAnywhere)
    }
  }, [])

  /** 自动拉伸高度：按 scrollHeight 调整，上限 128px */
  const autoResize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }

  useEffect(autoResize, [value])

  const setText = (next: string) => patchDraft(draftKey, { text: next })

  /** 在光标处插入文本（图文混排粘贴时，拦截后需手动补回文字） */
  const insertAtCursor = (text: string) => {
    const el = textareaRef.current
    if (!el) {
      setText(value + text)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`
    setText(next)
    requestAnimationFrame(() => {
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
    })
  }

  /**
   * 接收一批文件：格式校验 → 剩余额度截断 → 主进程压缩落盘。
   * 超量时按剩余额度截断并明确提示（整批拒绝在只剩 1 个位子时特别难用）。
   */
  const attachFiles = async (files: File[]) => {
    if (!imagesEnabled) {
      toast('已在设置中关闭「允许发送图片」', 'info')
      return
    }
    if (attaching) return
    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      toast(`最多 ${MAX_IMAGES} 张图片`, 'info')
      return
    }
    const valid = files.filter((f) => ALLOWED_MIME.has(f.type))
    if (valid.length === 0) {
      toast('只支持 PNG / JPEG / WebP 图片', 'error')
      return
    }
    if (valid.length < files.length) toast('已忽略不支持的文件格式', 'info')
    const accepted = valid.slice(0, remaining)
    if (valid.length > remaining) toast(`最多 ${MAX_IMAGES} 张，只接收了 ${accepted.length} 张`, 'info')

    const sessionId = await useSessionStore.getState().ensureSession()
    if (!sessionId) {
      toast('请先选择角色卡', 'error')
      return
    }
    // 会话可能刚创建 → 草稿键随之变化：先把旧键草稿迁过去（否则之前打的字会留在 __new__ 下），
    // 再按最新键回填图片
    const key = useSessionStore.getState().currentSessionId ?? draftKey
    if (key !== draftKey) useDraftStore.getState().migrate(draftKey, key)
    setAttaching(true)
    try {
      const saved: ChatImage[] = []
      for (const file of accepted) {
        const buffer = await file.arrayBuffer()
        saved.push(await api.chat.attachImage({ sessionId, buffer, mime: file.type }))
      }
      const current = useDraftStore.getState().get(key).images
      patchDraft(key, { images: [...current, ...saved] })
    } catch (err) {
      toast(err instanceof Error ? err.message : '图片处理失败', 'error')
    } finally {
      setAttaching(false)
    }
  }
  // document 级 drop 监听靠 ref 拿最新闭包（监听只在挂载时绑定一次）
  attachRef.current = attachFiles

  /** 移除一张附件（同时删掉尚未发送的磁盘文件） */
  const removeImage = (img: ChatImage) => {
    patchDraft(draftKey, { images: images.filter((i) => i.path !== img.path) })
    void api.chat.discardImage({ path: img.path })
  }

  const canSend = (value.trim().length > 0 || images.length > 0) && !streaming && !rewinding && !attaching

  /** 发送消息 */
  const handleSend = () => {
    if (!canSend) return
    const text = value.trim()
    const attached = images
    // 先清草稿再发送：send 内部可能创建会话，清空后即使发生迁移也只会迁走空草稿
    clearDraft(draftKey)
    void send(text, attached.length > 0 ? attached : undefined)
  }

  /** 键盘处理：Enter 发送 / Shift+Enter 换行；合成中不触发 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  /** 粘贴：只拦含图片的粘贴，纯文本走浏览器默认行为 */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData
    if (!dt) return
    const fromItems = Array.from(dt.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (fromItems.length === 0) return
    e.preventDefault()
    // 图文混排（从 Word/网页复制）：拦截后需手动把纯文本补回光标处，否则文字被一起吞掉
    const text = dt.getData('text/plain')
    if (text) insertAtCursor(text)
    void attachFiles(fromItems)
  }

  return (
    <div className="glass relative shrink-0 border-t-0 px-4 pb-3 pt-2">
      {/* 拖拽投放区：文件悬停在窗口任意位置时浮现，否则完全不占位 */}
      {dragActive && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-panel)]/80 backdrop-blur-sm">
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--primary-400)] px-6 py-4 text-sm font-medium text-[var(--primary-400)]">
            {images.length >= MAX_IMAGES ? `已达上限（${MAX_IMAGES} 张）` : '松开以添加图片'}
          </div>
        </div>
      )}

      {/* 附件预览条 */}
      {images.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          {images.map((img) => (
            <div key={img.path} className="group relative">
              <ChatImageThumb
                image={img}
                sizeClass="h-16 w-16"
                onClick={() => setPreview(api.chat.imageUrl(img.path))}
              />
              <button
                type="button"
                onClick={() => removeImage(img)}
                title="移除"
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </div>
          ))}
          <span className="text-[11px] text-text-muted">{`${images.length}/${MAX_IMAGES}`}</span>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          placeholder={
            streaming
              ? 'AI 正在回复…'
              : rewinding
                ? '正在处理上一条消息的重发…'
                : attaching
                  ? '图片处理中…'
                  : 'Enter 发送，Shift+Enter 换行 · 可粘贴或拖入图片'
          }
          className="max-h-32 min-h-[40px] flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface-2/70 px-4 py-3 text-sm leading-relaxed text-text outline-none transition-all placeholder:text-text-muted focus:border-[var(--border-strong)] focus:shadow-[0_0_0_3px_var(--primary-glow)]"
        />
        {streaming ? (
          <button
            onClick={() => stop()}
            title="停止"
            className="inline-flex w-[44px] shrink-0 items-center justify-center self-stretch rounded-[var(--radius-md)] border border-danger/40 bg-danger/10 text-danger transition-colors hover:bg-danger/20"
          >
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            title="发送"
            className="bg-accent-gradient glow-primary inline-flex w-[44px] shrink-0 items-center justify-center self-stretch rounded-[var(--radius-md)] text-[var(--on-brand)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <Send size={16} strokeWidth={2} />
          </button>
        )}
      </div>

      {preview && <Lightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

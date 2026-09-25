/**
 * 窗口管理器：持有桌宠/聊天/设置/剧情四个窗口引用，提供懒创建 / 显隐 / 跨窗口事件广播。
 * 各窗口共享主进程同一套数据读写逻辑。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import path from 'path'
import { createPetWindow, markPetWindowQuitting, PET_WINDOW_SIZE } from './petWindow'
import { createChatWindow } from './chatWindow'
import { createSettingsWindow } from './settingsWindow'
import { createStoryWindow } from './storyWindow'
import type { ModelSettings, PetCardPayload, StandardEmotion, TTSLanguage } from '../../src/types'

class WindowManager {
  pet: BrowserWindow | null = null
  chat: BrowserWindow | null = null
  settings: BrowserWindow | null = null
  story: BrowserWindow | null = null
  private tray: Tray | null = null
  private allowQuit = false
  /** 桌宠 renderer 是否已 ready（did-finish-load）。就绪前触发的语音缓存，避免首个回答丢声 */
  private petSpeakReady = false
  /** 当前缓存的最新的"本轮语音模式"（未就绪时暂存，就绪后先于首批语音补发） */
  private pendingVoiceMode: { voiceEnabled: boolean } | null = null
  /** 最近一次广播的语音模式（窗口就绪后补发用） */
  private lastVoiceMode: { voiceEnabled: boolean } | null = null
  /** 当前正在进行 AI 流式回复的会话 id（无则 null）。用于窗口重载/新建后就绪时补发，
   *  让重开/热更的窗口能"认领"进行中的会话，避免漏掉该轮的 stream-user/done 而看起来"生成失败" */
  private activeStreamingSession: string | null = null
  /** 最近一次推送给桌宠的角色卡形象配置。桌宠 renderer 就绪后补发（推送早于订阅时 IPC 消息会丢） */
  private lastPetCard: PetCardPayload | null = null
  private pendingPetSpeaks: Array<{
    text: string
    voiceId: string | null
    languageOverride: TTSLanguage | null
    chunks?: Array<{ text: string; emotion: StandardEmotion }>
    follow: boolean
    engine?: 'genie' | 'mimo'
    genieOverride?: import('../../src/types').CharacterGenieOverride | null
  }> = []

  /** app ready 后调用：创建桌宠窗口 + 托盘 */
  init(): void {
    this.pet = createPetWindow()
    this.armPetSpeakReady(this.pet)
    this.setupTray()

    app.on('before-quit', () => {
      this.allowQuit = true
      markPetWindowQuitting()
    })

    // 第二实例（再次启动应用）→ 唤醒桌宠
    app.on('second-instance', () => {
      this.showPet()
    })
  }

  /** 注册桌宠窗口的"语音可用"信号：等 webContents 加载完成后再放行 speak，之前缓存 */
  private armPetSpeakReady(win: BrowserWindow): void {
    this.petSpeakReady = false
    if (!win.isDestroyed() && win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        this.petSpeakReady = true
        this.flushPendingPetSpeaks()
      })
    } else {
      this.petSpeakReady = true
    }
  }

  /** 桌宠就绪后一次性补发缓存的首批语音与语音模式 */
  private flushPendingPetSpeaks(): void {
    if (!this.petSpeakReady) return
    const win = this.pet
    if (!win || win.isDestroyed()) {
      this.pendingPetSpeaks = []
      this.pendingVoiceMode = null
      return
    }
    if (this.pendingVoiceMode) {
      win.webContents.send('pet:voice-mode', this.pendingVoiceMode)
      this.pendingVoiceMode = null
    }
    const pending = this.pendingPetSpeaks
    this.pendingPetSpeaks = []
    for (const body of pending) {
      win.webContents.send('pet:speak', body)
    }
  }

  // ---------------- 桌宠 ----------------

  getPetWindow(): BrowserWindow | null {
    return this.pet
  }

  /** 剧情窗引用（IPC 弹对话框时作为父窗口用；可能为 null） */
  getStoryWindow(): BrowserWindow | null {
    return this.story
  }

  showPet(): void {
    if (!this.pet || this.pet.isDestroyed()) {
      this.pet = createPetWindow()
      this.armPetSpeakReady(this.pet)
      return
    }
    this.pet.show()
    this.pet.focus()
  }

  togglePet(): void {
    if (!this.pet || this.pet.isDestroyed()) {
      this.pet = createPetWindow()
      this.armPetSpeakReady(this.pet)
      return
    }
    if (this.pet.isVisible()) this.pet.hide()
    else {
      this.pet.show()
      this.pet.focus()
    }
  }

  /** 角色卡切换后同步桌宠的 Live2D 模型 + 覆盖配置 + 立绘/渲染模式。
   *  同时缓存 payload：桌宠 renderer 尚未挂载订阅时该消息会被丢弃，就绪后由 resendPetCard 补发 */
  setPetCard(payload: PetCardPayload): void {
    this.lastPetCard = payload
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:set-card', payload)
    }
  }

  /** 模型导入/删除后广播给桌宠刷新列表 */
  notifyModelsChanged(): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:models-changed')
    }
  }

  /** 立绘集导入/删除后广播给桌宠刷新列表 */
  notifySpritesChanged(): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:sprites-changed')
    }
  }

  /** Cubism Core 运行库导入后广播给桌宠，触发重新初始化（解决运行中导入后不显示模型） */
  notifyCoreChanged(): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:core-changed')
    }
  }

  /** 模型设置变化后广播给桌宠窗口（实时更新参数/动画） */
  notifyModelSettingsChanged(settings: ModelSettings): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:model-settings-changed', settings)
    }
  }

  /**
   * 通知桌宠窗口播放语音（由聊天窗口 AI 回复后调用）。
   * 桌宠窗口收到 pet:speak 事件后：调用 TTS 合成 → 播放音频 → 口型同步。
   * languageOverride 为角色级 TTS 语言覆盖（null 表示跟随全局）。
   */
  speak(text: string, voiceId: string | null, languageOverride?: TTSLanguage | null, payload?: { chunks?: import('../../src/types').DialogueChunk[]; follow?: boolean; engine?: 'genie' | 'mimo'; genieOverride?: import('../../src/types').CharacterGenieOverride | null }): void {
    const win = this.pet
    if (!win || win.isDestroyed()) return
    const body: {
      text: string
      voiceId: string | null
      languageOverride: TTSLanguage | null
      chunks?: Array<{ text: string; emotion: StandardEmotion }>
      follow: boolean
      engine?: 'genie' | 'mimo'
      genieOverride?: import('../../src/types').CharacterGenieOverride | null
    } = {
      text,
      voiceId,
      languageOverride: languageOverride ?? null,
      chunks: payload?.chunks,
      follow: payload?.follow ?? true,
      engine: payload?.engine,
      genieOverride: payload?.genieOverride ?? null,
    }
    // 桌宠 renderer 未就绪（首个回答常发生）→ 先缓存，ready 后补发，避免丢声
    if (!this.petSpeakReady) {
      this.pendingPetSpeaks.push(body)
      return
    }
    win.webContents.send('pet:speak', body)
  }

  /** 把 AI 流式事件同时广播给聊天窗与宠物窗（两侧各自维护会话视图，保持同步） */
  broadcastAI(channel: string, payload?: unknown): void {
    for (const win of [this.chat, this.pet]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  /** 广播"本轮是否有语音"（流式开始时下发），供宠物窗与聊天窗提前决定文本展示方式 */
  notifyVoiceMode(opts: { voiceEnabled: boolean }): void {
    // 记录最近一次语音模式：供窗口就绪后（renderer-ready）补发，保证两端都拿到
    this.lastVoiceMode = opts
    const win = this.pet
    if (!win || win.isDestroyed()) return
    // 桌宠 renderer 未就绪：先缓存最新的语音模式，就绪后随首批语音一起补发
    if (!this.petSpeakReady) {
      this.pendingVoiceMode = opts
      return
    }
    win.webContents.send('pet:voice-mode', opts)
    // 聊天窗同样需要知道本轮语音模式，以便与宠物窗采用一致的分段跟读显示
    if (this.chat && !this.chat.isDestroyed()) {
      this.chat.webContents.send('chat:voice-mode', opts)
    }
  }

  /** 单个窗口 renderer 就绪后补发最近一次语音模式（只发给出问题的窗口，避免把旧模式广播到其它窗口导致误入待输出） */
  resendVoiceMode(target: 'pet' | 'chat'): void {
    if (!this.lastVoiceMode) return
    const win = target === 'pet' ? this.pet : this.chat
    if (!win || win.isDestroyed()) return
    if (target === 'pet') win.webContents.send('pet:voice-mode', this.lastVoiceMode)
    else win.webContents.send('chat:voice-mode', this.lastVoiceMode)
  }

  /** 记录当前正在进行 AI 流式回复的会话 id（流式开始置入，结束置 null） */
  setActiveStreamingSession(sessionId: string | null): void {
    this.activeStreamingSession = sessionId
  }

  /** 单个窗口 renderer 就绪后补发"进行中的会话 id"（null 表示当前无流式）。
   *  重载窗口借此认领进行中的会话，避免漏掉该轮事件；故意只发给指定窗口，不广播干扰其它窗口 */
  resendActiveSession(target: 'pet' | 'chat'): void {
    const win = target === 'pet' ? this.pet : this.chat
    if (!win || win.isDestroyed()) return
    win.webContents.send('ai:active-session', this.activeStreamingSession)
  }

  /** 桌宠 renderer 就绪后补发最近一次角色卡形象配置（防推送早于订阅而丢失导致形象空白） */
  resendPetCard(): void {
    if (!this.lastPetCard) return
    if (!this.pet || this.pet.isDestroyed()) return
    this.pet.webContents.send('pet:set-card', this.lastPetCard)
  }

  /** 剧情轮次流式预览（7.7 性能第一批）：AI 生成中的可读文本（累积全文）实时推给剧情窗；
   *  生成完成后由 story:message 增量同步接管正式分段播放，预览仅用于消除"干等" */
  pushStoryStream(runId: string, text: string): void {
    if (this.story && !this.story.isDestroyed()) {
      this.story.webContents.send('story:stream-delta', { runId, text })
    }
  }

  /** 聊天窗切会话/新建会话后，把当前会话 id 转发给宠物窗，让内容框跟随同步 */
  notifyCurrentSession(sessionId: string | null): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('session:current', sessionId)
    }
  }

  /** 宠物窗朗读到某段文本时转发给聊天窗，让其随语音段段显示（null 表示清空） */
  notifyReadingText(text: string): void {
    if (this.chat && !this.chat.isDestroyed()) {
      this.chat.webContents.send('chat:reading-text', text)
    }
  }

  /** 桌宠窗朗读是否进行中 → 转发给聊天窗控制光标 */
  notifyReadingActive(active: boolean): void {
    console.log('[sync] pet阅读Active→chat', active)
    if (this.chat && !this.chat.isDestroyed()) {
      this.chat.webContents.send('chat:reading-active', active)
    }
  }

  /** AI 回复完成后把归一化情绪广播给桌宠，驱动形象层切表情/切立绘 */
  notifyEmotion(emotion: StandardEmotion): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:emotion', emotion)
    }
  }

  /** 广播"思考中"状态给桌宠：true 进入思考（立绘切思考图），false 退出 */
  notifyThinking(thinking: boolean): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:thinking', thinking)
    }
  }

  /** 向所有窗口广播事件（会话变化等，用于跨窗口同步） */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }

  /** 返回当前全部活跃窗口（供 updater IPC 广播更新状态） */
  getAllWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows()
  }

  /** 会话新建/删除后广播，聊天窗口据此刷新并处理「当前会话被删」的情况 */
  notifySessionsChanged(): void {
    this.broadcast('sessions-changed')
  }

  // ---------------- 聊天 ----------------

  showChat(sessionId?: string): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.chat = createChatWindow()
      // 窗口创建后（DOM 就绪）再把目标会话 id 交给聊天窗加载
      this.chat.webContents.once('did-finish-load', () => {
        if (sessionId) this.chat?.webContents.send('chat:open-session', sessionId)
      })
      return
    }
    if (sessionId) this.chat.webContents.send('chat:open-session', sessionId)
    if (!this.chat.isVisible()) this.chat.show()
    this.chat.focus()
  }

  // ---------------- 设置 ----------------

  showSettings(): void {
    if (!this.settings || this.settings.isDestroyed()) {
      this.settings = createSettingsWindow()
      return
    }
    if (!this.settings.isVisible()) this.settings.show()
    this.settings.focus()
  }

  // ---------------- 剧情 ----------------

  /** 打开/聚焦剧情窗（演出在主进程进行，窗口关闭不中断；重开按快照恢复） */
  showStory(): void {
    if (!this.story || this.story.isDestroyed()) {
      this.story = createStoryWindow()
      return
    }
    if (!this.story.isVisible()) this.story.show()
    this.story.focus()
  }

  /** 向剧情窗发送事件（快照补发等；窗口未开则静默忽略） */
  sendToStory(channel: string, payload?: unknown): void {
    if (this.story && !this.story.isDestroyed()) {
      this.story.webContents.send(channel, payload)
    }
  }

  // ---------------- 更新 ----------------

  /** 托盘触发「检查更新」：同时弹出设置窗（若未开）并广播 updater:check-request */
  checkForUpdates(): void {
    this.showSettings()
    this.broadcast('updater:check-request')
  }

  // ---------------- 托盘 ----------------

  private setupTray(): void {
    const iconPath = path.join(__dirname, '../build/icon.png')
    let icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      // 兜底：无图标时创建 16x16 透明占位
      icon = nativeImage.createEmpty()
    }
    // Windows 托盘建议 16x16
    icon = icon.resize({ width: 16, height: 16 })
    this.tray = new Tray(icon)
    this.tray.setToolTip('LainEcho')

    const menu = Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏桌宠',
        click: () => this.togglePet(),
      },
      { type: 'separator' },
      { label: '打开聊天窗口', click: () => this.showChat() },
      { label: '打开设置', click: () => this.showSettings() },
      { type: 'separator' },
      { label: '检查更新…', click: () => this.checkForUpdates() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.allowQuit = true
          markPetWindowQuitting()
          app.quit()
        },
      },
    ])
    this.tray.setContextMenu(menu)
    // 左键单击切换桌宠显隐（Windows）
    this.tray.on('click', () => this.togglePet())
  }

  /** 是否允许真正退出（用于 pet 窗口 close 事件判断） */
  get shouldAllowQuit(): boolean {
    return this.allowQuit
  }
}

export const windowManager = new WindowManager()

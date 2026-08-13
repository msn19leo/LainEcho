/**
 * 窗口管理器：持有三个窗口引用，提供懒创建 / 显隐 / 跨窗口事件广播。
 * 三个窗口共享主进程同一套数据读写逻辑。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import path from 'path'
import { createPetWindow, markPetWindowQuitting, PET_WINDOW_SIZE } from './petWindow'
import { createChatWindow } from './chatWindow'
import { createSettingsWindow } from './settingsWindow'
import type { ModelSettings, CharacterModelOverride, TTSLanguage } from '../../src/types'

class WindowManager {
  pet: BrowserWindow | null = null
  chat: BrowserWindow | null = null
  settings: BrowserWindow | null = null
  private tray: Tray | null = null
  private allowQuit = false

  /** app ready 后调用：创建桌宠窗口 + 托盘 */
  init(): void {
    this.pet = createPetWindow()
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

  // ---------------- 桌宠 ----------------

  getPetWindow(): BrowserWindow | null {
    return this.pet
  }

  showPet(): void {
    if (!this.pet || this.pet.isDestroyed()) {
      this.pet = createPetWindow()
      return
    }
    this.pet.show()
    this.pet.focus()
  }

  togglePet(): void {
    if (!this.pet || this.pet.isDestroyed()) {
      this.pet = createPetWindow()
      return
    }
    if (this.pet.isVisible()) this.pet.hide()
    else {
      this.pet.show()
      this.pet.focus()
    }
  }

  /** 角色卡切换后同步桌宠的 Live2D 模型 + 表情/待机动作覆盖 */
  setPetCard(payload: { modelId: string | null; modelOverride: CharacterModelOverride | null }): void {
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
  speak(text: string, voiceId: string | null, languageOverride?: TTSLanguage | null): void {
    if (this.pet && !this.pet.isDestroyed()) {
      this.pet.webContents.send('pet:speak', { text, voiceId, languageOverride: languageOverride ?? null })
    }
  }

  /** 向所有窗口广播事件（会话变化等，用于跨窗口同步） */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }

  /** 会话新建/删除后广播，聊天窗口据此刷新并处理「当前会话被删」的情况 */
  notifySessionsChanged(): void {
    this.broadcast('sessions-changed')
  }

  // ---------------- 聊天 ----------------

  showChat(): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.chat = createChatWindow()
      return
    }
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

/**
 * 主进程入口：单实例锁、窗口创建、托盘、自定义协议、IPC 注册。
 */
import { app } from 'electron'
import { initLogger } from './services/logger'
import { ensureDataDirs } from './services/storage'
import { pruneEmptySessions, migrateSpriteEmotionMaps, dedupeFailedUserResends, getSettings } from './services/repository'
import { cleanupExpiredImages } from './services/chatImages'
import { migrateApiProfiles } from './services/apiProfiles'
import { compensateMissingVectors } from './services/memory/memoryVectors'
import { migrateMemoryPerspectives } from './services/memoryExtraction'
import { startProactiveScheduler } from './services/proactive/scheduler'
import { ensureSampleStories } from './services/storyEngine/samples'
import { registerPetSchemesPrivileged, registerPetProtocolHandler } from './services/petProtocol'
import { registerAllIpc } from './ipc'
import { disposeSbv2Server } from './services/sbv2Tts'
import { syncNativeTheme } from './services/nativeTheme'
import { windowManager } from './windows/windowManager'

// pet-res:// 特权 scheme 必须在 app ready 之前注册
registerPetSchemesPrivileged()

// 日志系统尽早初始化：后续所有主进程 console 输出自动落盘（渲染端经 api.logs.forward 转发）
initLogger()

// Windows 通知/任务栏归属
app.setAppUserModelId('com.lainecho.pet')

// 单实例：重复启动时唤醒已有实例的桌宠
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    await ensureDataDirs()
    // 原生主题跟随应用主题（必须早于建窗）：
    // 不同步时，系统深色 + 应用浅色会让文本输入光标被画成白色，落在浅色输入框上等于消失
    syncNativeTheme((await getSettings()).theme)
    // 清理历史遗留的空会话（无消息 = 从未使用）
    await pruneEmptySessions().catch((err) => console.error('清理空会话失败', err))
    // 聊天图片保留期清理（imageRetentionDays=0 时跳过；只删文件不改消息，失败不影响启动）
    void getSettings()
      .then((s) => cleanupExpiredImages(s.vision.imageRetentionDays))
      .then((n) => { if (n > 0) console.log('[chat-image] 清理过期原图 %d 张', n) })
      .catch((err) => console.error('[chat-image] 保留期清理失败', err))
    // 重发去重清理（一次性、幂等）：移除"失败 user + 同内容重发 user"相邻重复对
    await dedupeFailedUserResends().catch((err) => console.error('重发去重清理失败', err))
    // API 档案迁移（一次性、幂等）：旧单配置字段 + 各独立 Key 文件 → 首批服务商档案（须先于各窗口使用）
    await migrateApiProfiles()
    registerPetProtocolHandler()
    registerAllIpc()
    windowManager.init()
    // 「截图时隐藏桌宠」默认开：启动时按设置应用一次（只作用于桌宠窗口）。
    // 刻意不动聊天/设置窗口——用户经常要截图设置页反馈问题，被保护后截出来是空白。
    void getSettings()
      .then((s) => windowManager.applyContentProtection(s.vision.hideFromCapture))
      .catch(() => {})

    // 记忆人称迁移：把存量记忆一次性归一到第三人称档案体（{角色名}/用户），幂等；
    // 迁移会删除被改写记忆的旧向量，完成后再跑补偿，按新文本重嵌
    void migrateMemoryPerspectives().then(() => compensateMissingVectors())

    // 立绘状态迁移（一次性，幂等）：旧 emotionMap（6 枚举→图）→ 状态词表条目并剥离旧字段
    void migrateSpriteEmotionMaps().catch((err) => console.error('[migrate] 立绘状态迁移失败', err))

    // 示例剧本：首次启动写入 data/stories/（已存在不覆盖）
    await ensureSampleStories().catch((err) => console.error('[story] 示例剧本写入失败', err))

    // 主动搭话调度器：每 30s 一轮，enableProactive 关闭时循环空转（开销可忽略）
    startProactiveScheduler()

    app.on('activate', () => {
      // macOS Dock 点击时恢复桌宠窗口（兼容处理）
      if (!windowManager.getPetWindow()) windowManager.showPet()
    })
  })

  // Windows/macOS：关闭所有窗口后保持托盘常驻（不退出）
  app.on('window-all-closed', () => {
    // 保持运行，等待托盘退出
  })

  // 退出时收掉 SBV2 sidecar，否则会留下一个占 600MB 左右的孤儿进程
  app.on('before-quit', () => {
    disposeSbv2Server()
  })
}

/**
 * 主进程入口：单实例锁、窗口创建、托盘、自定义协议、IPC 注册。
 */
import { app } from 'electron'
import { ensureDataDirs } from './services/storage'
import { pruneEmptySessions, migrateSpriteEmotionMaps } from './services/repository'
import { compensateMissingVectors } from './services/memory/memoryVectors'
import { migrateMemoryPerspectives } from './services/memoryExtraction'
import { startProactiveScheduler } from './services/proactive/scheduler'
import { ensureSampleStories } from './services/storyEngine/samples'
import { registerPetSchemesPrivileged, registerPetProtocolHandler } from './services/petProtocol'
import { registerAllIpc } from './ipc'
import { windowManager } from './windows/windowManager'

// pet-res:// 特权 scheme 必须在 app ready 之前注册
registerPetSchemesPrivileged()

// Windows 通知/任务栏归属
app.setAppUserModelId('com.lainecho.pet')

// 单实例：重复启动时唤醒已有实例的桌宠
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    await ensureDataDirs()
    // 清理历史遗留的空会话（无消息 = 从未使用）
    await pruneEmptySessions().catch((err) => console.error('清理空会话失败', err))
    registerPetProtocolHandler()
    registerAllIpc()
    windowManager.init()

    // 记忆人称迁移：把存量记忆一次性归一到第三人称档案体（{角色名}/用户），幂等；
    // 迁移会删除被改写记忆的旧向量，完成后再跑补偿，按新文本重嵌
    void migrateMemoryPerspectives().then(() => compensateMissingVectors())

    // 立绘情绪迁移（一次性，幂等）：旧 emotionMap（6 枚举→图）→ 情绪词表条目并剥离旧字段
    void migrateSpriteEmotionMaps().catch((err) => console.error('[migrate] 立绘情绪迁移失败', err))

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
}

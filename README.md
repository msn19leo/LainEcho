# AI 桌宠

一个基于 Electron 的桌面 AI 桌宠应用：Live2D 形象展示 + 大模型对话 + 角色卡切换 + 长期记忆 + 会话管理。

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 🧸 桌宠形象 | Live2D 模型渲染，无边框透明窗口、始终置顶、可拖动、滚轮缩放 |
| 💬 AI 对话 | 兼容 OpenAI 格式 API，支持 SSE 流式输出（打字机效果） |
| 🎭 角色卡 | 编写/切换 AI 人设（身份与意识），切换时自动新建会话 |
| 🧠 记忆体 | 用户手动维护的全局固定记忆条目，每次请求前实时拼接 |
| 🗂️ Data | 会话新建/搜索/按角色卡筛选/导出为 Markdown 后删除 |
| 🔒 安全 | API Key 经 safeStorage(DPAPI) 加密落盘，仅主进程内存中解密使用 |

## 🚀 快速开始

```bash
npm install

# 开发模式（启动 Vite dev server + Electron）
npm run dev

# 类型检查
npm run typecheck

# 仅构建（产出 dist/ + dist-electron/）
npm run build

# 打包 Windows 安装包（NSIS）
npm run build:win
```

## 🧩 Live2D Cubism Core（必需）

Cubism Core（`live2dcubismcore.min.js`）是 Live2D 官方闭源专有 SDK，**不能打包进仓库或安装包**，需要首次使用时手动导入：

1. 前往 [Live2D 官网](https://www.live2d.com/sdk/download/web/) 下载 **Cubism SDK for Web**
2. 解压后找到其中的 `live2dcubismcore.min.js`
3. 打开应用 → 设置 → **角色模型** → 点击「导入运行库」选择该文件

> 未导入 Cubism Core 时桌宠窗口会提示，Live2D 无法渲染。

## 🧸 导入 Live2D 模型

1. 准备一个包含 `xxx.model3.json` 的模型文件夹（Cubism 3 及以上格式）
2. 设置 → **角色模型** → 「从文件夹导入」
3. 导入会**整体复制**到应用数据目录（`userData/models/{modelId}/`），原文件夹移动/删除不影响应用

## 📁 数据存储

所有数据位于 Electron `userData` 目录（Windows：`%APPDATA%/ai-desktop-pet/`）：

```
userData/
├── data/
│   ├── characterCards.json     # 角色卡
│   ├── memory.json             # 全局记忆体
│   ├── settings.json           # 非敏感配置（baseURL、model 等）
│   ├── secure/apiKey.enc       # safeStorage 加密的 API Key
│   └── sessions/               # 会话索引 + 单个会话消息
├── models/{modelId}/           # 导入的 Live2D 模型副本
└── live2d-core/                # 用户手动放入的 Cubism Core
```

## 🔧 技术栈

- **桌面框架**：Electron（`contextIsolation` + `sandbox` + 白名单 preload）
- **前端**：React 19 + TypeScript + Vite
- **样式**：Tailwind CSS v4（AIRI 风格深色卡片式）
- **状态**：Zustand
- **Live2D**：pixi.js v7 + pixi-live2d-display
- **打包**：electron-builder（Windows NSIS）
- **自定义协议**：`pet-res://` 服务本地 Live2D 资源（路径穿越防护）

## 🪟 窗口

| 窗口 | 唤起方式 |
|---|---|
| 桌宠窗口 | 应用启动即显示；托盘菜单可显隐 |
| 聊天窗口 | 双击桌宠、托盘菜单、聊天窗口内「设置」旁的按钮 |
| 设置窗口 | 托盘菜单、聊天窗口右上角 ⚙ |

## ⚠️ 已知限制 / 后续可扩展

- 记忆条目过多时的 token 截断策略（目前全量拼接）
- 会话标题自动取首条用户消息前 20 字（暂不支持手动重命名）
- Live2D 模型切换暂无过渡动画
- 目前仅支持 Windows 打包目标

## 🔒 安全设计要点

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`
- preload 仅暴露白名单方法，渲染进程拿不到 `ipcRenderer` 原始对象
- API Key 明文永不进入渲染进程；AI 请求全部由主进程代理
- 模型导入复制到受控目录，`pet-res://` 协议做路径穿越防护

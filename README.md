# LainEcho

一个基于 Electron 的桌面 AI 桌宠应用：Live2D 形象展示 + 大模型对话 + 语音合成 + 角色卡切换 + 会话管理。

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 桌宠形象 | Live2D Cubism 4 模型渲染，无边框透明窗口、始终置顶、可拖动、滚轮缩放 |
| 主题系统 | 深色 / 浅色 / 跟随系统三模式，跨窗口实时同步，防白屏闪烁 |
| AI 对话 | 兼容 OpenAI 格式 API，支持 SSE 流式输出（打字机效果） |
| 语音合成 | 小米 MiMo 声音克隆 TTS，参考音频管理，流式分句合成，口型同步驱动 |
| 角色卡 | 动漫角色复刻人设（存在锚点/内心结构/感知方式/关系模式/「你的身份」/语言质感/状态系统/世界观碎片/禁止项，支持 AI 生成草稿），示例对话，可选绑定 Live2D 模型与参考音频 |
| 记忆体 | 用户手动维护的全局固定记忆条目，每次请求前实时拼接 |
| Data | 会话搜索/筛选/重命名/导出 Markdown，数据存放位置可自定义并迁移 |
| 安全 | API Key 经 safeStorage(DPAPI) 加密落盘，仅主进程内存中解密使用 |

### Live2D 参数引擎

参考 [airi](https://github.com/moeru-ai/airi) 的实现，每帧由自定义参数引擎驱动（执行顺序：用户参数 → 表情 → 眨眼 → 眼神 → 口型同步）：

- **用户参数**：头部旋转、眼睛开合、眉毛、嘴巴、身体、呼吸等 20+ 参数可调
- **表情系统**：解析模型文件夹下 `exp3.json`，支持 Add / Multiply / Overwrite 三种混合模式，防残留机制（每帧还原基础值再应用）
- **眨眼**：Auto 模式（SDK 内置曲线 × 用户系数）+ Force 模式（自定义状态机，3~8s 随机间隔）
- **鼠标跟踪**：屏幕任意位置鼠标跟踪（主进程 33ms 轮询），lerp 缓动，1s 超时切空闲眼神
- **空闲眼神**：加权概率扫视间隔（800~4400ms），focusController 驱动头部旋转
- **口型同步**：RMS 时域振幅分析实时驱动 `ParamMouthOpen` / `ParamMouthOpenY`，指数平滑 + 增益

### 语音合成（TTS）

基于小米 [MiMo](https://mimo.mi.com/docs/zh-CN/api/audio/tts) 声音克隆模型（`mimo-v2.5-tts-voiceclone`）：

- **参考音频管理**：导入 wav/mp3 参考音频（建议 5-30s 干净人声），支持重命名/删除，导入时自动检测 WAV 时长并给出质量提示
- **流式分句合成**：AI 回复流式输出时按标点分句，短句累积避免情感断裂；长回复边流式边合成降低延迟，短回复整段合成保持情感连贯
- **情感上下文**：分句合成时附带前文作为情感参考，让 MiMo 参考前文语气保持连贯
- **双队列流水线**：合成循环与播放循环并行运行，播放第 N 句时已在合成第 N+1 句，句间几乎无间隔
- **口型同步**：桌宠窗口通过 AudioContext 实时分析音频振幅，驱动 Live2D 嘴巴开合参数
- **角色级覆盖**：每个角色卡可独立配置 TTS 语言（中文/日文）和自动播放开关，覆盖全局设置
- **语言切换**：中文默认按文本语言合成，日文语音暂时无法实现

## 角色卡 · 人设体系

借鉴动漫角色复刻设计，人设由多个维度构成（按注入 system prompt 的优先级排序），只注入填写的部分：

| 维度 | 作用 |
|---|---|
| 存在锚点 | 1-3 句话定性角色本质，优先级最高 |
| 内心结构 | 核心渴望 / 内在恐惧 / 核心矛盾 / 自我认知状态 |
| 感知方式 | 注意什么 / 情绪处理机制 / 对外部世界的态度 |
| 关系模式 | 靠近人的方式 / 亲密节奏 / 边界 / 对"被需要"的态度 |
| 你的身份 | 你是谁 / 你们的关系 / AI 角色怎么看你 / 特殊约定或记忆 |
| 语言质感 | 说话节奏 / 用词特征 / 不会说的话 / 特殊语言行为 |
| 状态系统 | 日常状态 / 触发开关 / 不同情境下的状态变化 |
| 世界观碎片 | 角色会真实说出口的零碎观点 |
| 禁止项 | 绝不能出现的表达，最高优先级硬性边界 |

### AI 生成人设

输入角色名 + 角色来源描述（原作设定 / 台词 / 简介），让 LLM 按上述结构生成 JSON 草稿并回填编辑器。

- **部分生成**：AI 自动填充各人设维度；`你的身份` 中的 `你是谁` 与 `AI 角色怎么看你` 会生成，其余由你手填（涉及你与角色的私密关系）
- 产物为草稿，需逐项检查确认后才入库；生成失败时自动修复尾逗号、字符串内换行等常见 JSON 瑕疵

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

1. 前往 [Live2D 官网](https://www.live2d.com/sdk/download/web/) 下载 **Cubism SDK for Web** 推荐下载 `CubismSdkForWeb-5-r.4`
2. 解压后找到其中的 `live2dcubismcore.min.js`
3. 打开应用 → 设置 → **角色模型** → 点击「导入运行库」选择该文件

> 未导入 Cubism Core 时桌宠窗口会提示，Live2D 无法渲染。

## 🧸 导入 Live2D 模型

1. 准备一个包含 `xxx.model3.json` 的模型文件夹（Cubism 3 及以上格式）
2. 设置 → **角色模型** → 「从文件夹导入」
3. 导入会**整体复制**到应用数据目录（`userData/models/{modelId}/`），原文件夹移动/删除不影响应用
4. 点击模型卡片可设为「当前选择」，角色卡未绑定模型时默认使用该模型

### 表情配置

模型文件夹下的 `exp3.json` 表情文件需要在 `model3.json` 中声明才能被识别：

```json
{
  "FileReferences": {
    "Expressions": [
      { "Name": "开心", "File": "happy.exp3.json" },
      { "Name": "害羞", "File": "shy.exp3.json" }
    ]
  }
}
```

在设置 → 角色模型 → 表情面板中开启表情系统并选择表情即可。角色卡也可通过「模型设置覆盖」指定专属表情和待机动作。

## 🗣️ 配置语音合成

1. 前往 [MiMo 开放平台](https://mimo.mi.com/) 注册并获取 API Key
2. 设置 → **语音合成** → 填写 MiMo API Key 和模型名（如 `mimo-v2.5-tts-voiceclone`）
3. 导入参考音频（建议 5-30 秒干净人声，wav/mp3 格式）
4. 在角色卡中绑定参考音频，即可在 AI 回复时自动合成语音并驱动桌宠口型同步

> TTS API Key 与 LLM API Key 隔离加密存储，互不影响。

## 📁 数据存储

所有数据位于 Electron `userData` 目录（Windows 默认：`%APPDATA%/LainEcho/`），可在设置 → Data 中自定义存放位置：

```
userData/
├── data/
│   ├── characterCards.json     # 角色卡
│   ├── memory.json             # 全局记忆体
│   ├── settings.json           # 非敏感配置（baseURL、model 等）
│   ├── model-settings.json     # 模型设置（缩放/位置/动画/表情）
│   ├── voice-settings.json     # TTS 非敏感配置（语言、自动播放）
│   ├── secure/
│   │   ├── apiKey.enc          # safeStorage 加密的 LLM API Key
│   │   └── voiceApiKey.enc     # safeStorage 加密的 MiMo TTS API Key
│   ├── voices/
│   │   ├── index.json          # 参考音频索引
│   │   └── voice_xxx.wav       # 参考音频文件
│   └── sessions/               # 会话索引 + 单个会话消息
├── models/{modelId}/           # 导入的 Live2D 模型副本
├── live2d-core/                # 用户手动导入的 Cubism Core
└── data-dir-config.json        # 自定义数据目录配置（仅在自定义时存在）
```

**数据迁移**：在设置 → Data → 数据存放位置中点击「更改位置」，选择新目录后所有数据（含参考音频）会复制过去，需手动重启应用生效。原目录数据不会被删除。

## 🔧 技术栈

- **桌面框架**：Electron 37（`contextIsolation` + `sandbox` + 白名单 preload）
- **前端**：React 19 + TypeScript + Vite 6
- **样式**：Tailwind CSS v4
- **动画**：framer-motion
- **状态**：Zustand
- **Live2D**：pixi.js v6 + pixi-live2d-display（动态 import `/cubism4` 子路径）
- **TTS**：小米 MiMo voiceclone API（声音克隆）+ Web Audio API 口型同步
- **打包**：electron-builder（Windows NSIS，可选安装目录，卸载不删数据）
- **自定义协议**：`pet-res://` 服务本地 Live2D 资源（路径穿越防护）

## 🪟 窗口

| 窗口 | 唤起方式 |
|---|---|
| 桌宠窗口 | 应用启动即显示；托盘菜单可显隐；右键菜单 |
| 聊天窗口 | 桌宠右上角按钮、托盘菜单 |
| 设置窗口 | 桌宠右上角按钮、聊天窗口右上角 ⚙、托盘菜单 |

## ⚠️ 已知限制

- 记忆条目过多时的 token 截断策略（目前全量拼接）
- Live2D 模型切换暂无过渡动画，模型空闲动作问题暂未解决
- 模型日文语音输出暂未实现
- 目前仅支持 Windows 打包目标

## 🔒 安全设计要点

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`
- preload 仅暴露白名单方法，渲染进程拿不到 `ipcRenderer` 原始对象
- API Key 明文永不进入渲染进程；AI 请求与 TTS 合成全部由主进程代理
- LLM API Key 与 MiMo TTS API Key 隔离加密存储（各自独立的 `.enc` 文件）
- 模型导入复制到受控目录，`pet-res://` 协议做路径穿越防护
- 数据写入采用原子策略（`.tmp` → `rename`），同一文件串行化队列防并发丢更新

## 📄 License

本项目仅限个人学习与研究使用，未经授权不得用于商业用途。
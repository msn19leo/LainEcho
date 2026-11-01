#!/usr/bin/env node
/**
 * ⑥ 离线能力表导出：不开应用，直接把每个 Live2D 模型的"参数能力"导出来。
 *
 * 导出内容（与运行时 ModelProfile 同口径）：
 *   - params：模型真实拥有的参数 + 量程/默认值（读 Cubism core）
 *   - drivers：物理输出参数 → 上游驱动参数（读 physics3.json）
 *   - physicsOutputs：所有被物理每帧重算的参数
 *   - eyeBlink / lipSync：model3.json 的 Groups（非空表示引擎会每帧写这些参数）
 *
 * 为什么不做"像素效果探测"：软件渲染下同一参数在 400² / 800² 测出的差异相差 10 倍
 * （眼睛 0.16% vs 1.67%），不足以判定"有没有效果"。能力表本身是确定的，先导出这个。
 *
 * 用途：
 *   - 换模型/重导入后对比能力表，确认"滑杆为什么突然不动了"
 *   - 不上应用也能查某只模型缺哪些标准参数
 *
 * 前置：先起一个静态服务，根目录指向 E: 盘（探针页与模型都要能访问）
 *   cd /e && python -m http.server 8899 --bind 127.0.0.1
 *
 * 用法：
 *   node scripts/probe-model-profile.mjs
 *   node scripts/probe-model-profile.mjs --models=model_xxx,model_yyy
 *   node scripts/probe-model-profile.mjs --port=8899
 *
 * 产物：<data>/model-profile-report.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(process.env.LAINECHO_ROOT || 'E:/')
const MODELS_DIR = path.resolve(process.env.LAINECHO_MODELS || path.join(ROOT, 'LainEcho_Data/models'))
const DATA_DIR = path.resolve(process.env.LAINECHO_DATA || path.join(ROOT, 'LainEcho_Data/data'))
const PROBE_PATH = '/LainEcho/.workbuddy/l2dprobe/index.html'

/** 姿态面板关心的 21 个标准参数，用来算"这只模型有几项可用" */
const POSE_IDS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeSmile',
  'ParamBrowLX', 'ParamBrowRX', 'ParamBrowLY', 'ParamBrowRY',
  'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'ParamMouthOpenY', 'ParamMouthForm', 'ParamCheek',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
]

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const onlyModels = opt('models', '')
  ? new Set(opt('models', '').split(',').map((s) => s.trim()).filter(Boolean))
  : null
const port = Number(opt('port', '8899'))

/** 找 Playwright 装的无头 Chromium（也支持 CHROME_PATH 覆盖） */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright')
  if (!fs.existsSync(base)) return null
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(base, d, rel)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/** 收集模型：只认顶层带 *.model3.json 的目录 */
function listModels() {
  if (!fs.existsSync(MODELS_DIR)) return []
  return fs
    .readdirSync(MODELS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(MODELS_DIR, e.name)
      const m3 = fs.readdirSync(dir).find((f) => f.endsWith('.model3.json'))
      return m3 ? { id: e.name, name: m3.replace(/\.model3\.json$/i, ''), file: m3, dir } : null
    })
    .filter(Boolean)
    .filter((m) => !onlyModels || onlyModels.has(m.id))
}

function toUrlPath(rel) {
  return rel.split(/[\\/]/).map((s) => encodeURIComponent(s)).join('/')
}

/** 从 --dump-dom 的文本里抽出 JSON 结果行 */
export function parseProfile(out) {
  const i = out.indexOf('--- profile ---')
  if (i < 0) return null
  const line = out
    .slice(i + '--- profile ---'.length)
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('{'))
  if (!line) return null
  try {
    return JSON.parse(line.trim())
  } catch {
    return null
  }
}

function runProfile(chrome, url) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=520,520',
    // 只等模型加载完，不需要长预算
    '--virtual-time-budget=15000',
    '--dump-dom',
    url,
  ]
  // stdin 必须断开：pipe 着的 stdin 会让 headless Chrome 迟迟不退出
  const out = execFileSync(chrome, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return parseProfile(out)
}

async function checkServer() {
  const url = `http://127.0.0.1:${port}${PROBE_PATH}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.error(`连不上 ${url}`)
    console.error('先启动静态服务（根目录指向 E: 盘）：')
    console.error('  cd /e && python -m http.server 8899 --bind 127.0.0.1')
    console.error(`原因：${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    console.error('找不到 Chromium。请设置 CHROME_PATH，或先安装 playwright 的 chromium。')
    process.exit(1)
  }
  await checkServer()
  const models = listModels()
  if (models.length === 0) {
    console.error(`没有在 ${MODELS_DIR} 下找到模型`)
    process.exit(1)
  }

  const report = { generatedAt: new Date().toISOString(), root: ROOT, models: {} }
  for (const model of models) {
    const modelRel = path.relative(ROOT, path.join(model.dir, model.file))
    const url =
      `http://127.0.0.1:${port}${PROBE_PATH}?mode=profile` +
      `&id=${encodeURIComponent(model.id)}` +
      `&model=/${toUrlPath(modelRel)}`
    process.stdout.write(`\n=== ${model.name} (${model.id}) ===\n`)
    let profile = null
    try {
      profile = runProfile(chrome, url)
    } catch (err) {
      console.log(`  探测失败：${err instanceof Error ? err.message.split('\n')[0] : err}`)
      continue
    }
    if (!profile) {
      console.log('  解析失败（模型可能缺贴图 / Cubism Core 未就位）')
      continue
    }
    const available = POSE_IDS.filter((id) => profile.params?.[id])
    const missing = POSE_IDS.filter((id) => !profile.params?.[id])
    const driven = POSE_IDS.filter((id) => profile.drivers?.[id])
    console.log(`  参数总数 ${Object.keys(profile.params || {}).length}`)
    console.log(`  姿态 21 项：可用 ${available.length}，缺失 ${missing.length}${missing.length ? `（${missing.join(', ')}）` : ''}`)
    console.log(`  物理输出 ${profile.physicsOutputs?.length ?? 0}，可反推驱动 ${Object.keys(profile.drivers || {}).length}`)
    console.log(`  眨眼组 ${profile.eyeBlink?.length ?? 0}，口型组 ${profile.lipSync?.length ?? 0}`)
    if (driven.length) console.log(`  受物理驱动：${driven.map((id) => `${id}←${profile.drivers[id]}`).join(', ')}`)
    report.models[model.id] = profile
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const outFile = path.join(DATA_DIR, 'model-profile-report.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n报告已写入 ${outFile}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

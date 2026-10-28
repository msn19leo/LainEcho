#!/usr/bin/env node
/**
 * 装配 SBV2 sidecar 的运行目录 `electron/services/sbv2-server/dist/`。
 *
 * 为什么要单独一个 dist：
 *   `cargo clean` 只会删 target/，但 onnxruntime.dll / DirectML.dll 不是编译产物，
 *   放在 target/release 里会被一起清掉，导致打包与开发期都找不到文件。
 *   所以把「exe + 两个 dll」统一装配到 dist/，开发和打包都指向它。
 *
 * 步骤：
 *   1. 把 target/release/sbv2-sidecar.exe 拷到 dist/
 *   2. dist/onnxruntime.dll 缺失时，从 NuGet 取 DirectML 版（1.24.4）
 *   3. dist/DirectML.dll 缺失时，从 ort 的下载缓存里找一份（cargo build 后才有）
 *
 * 用法：npm run sbv2:build（内部会先 cargo build --release 再跑本脚本）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'electron', 'services', 'sbv2-server')
const DIST = path.join(SERVER, 'dist')
const RELEASE = path.join(SERVER, 'target', 'release')

const ORT_NUGET_VERSION = '1.24.4'
const ORT_NUGET_URL =
  `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/` +
  `${ORT_NUGET_VERSION}/microsoft.ml.onnxruntime.directml.${ORT_NUGET_VERSION}.nupkg`

const log = (msg) => console.log(`[sbv2-dist] ${msg}`)
const exists = (p) => fs.existsSync(p)
const sizeMb = (p) => (fs.statSync(p).size / 1048576).toFixed(1)

async function ensureExe() {
  const src = path.join(RELEASE, 'sbv2-sidecar.exe')
  const dst = path.join(DIST, 'sbv2-sidecar.exe')
  if (!exists(src)) {
    log(`未找到 ${src}`)
    log('请先执行：cargo build --release --manifest-path electron/services/sbv2-server/Cargo.toml')
    process.exitCode = 1
    return false
  }
  await fsp.copyFile(src, dst)
  log(`exe 已装配（${sizeMb(dst)} MB）`)
  return true
}

async function ensureOnnxRuntime() {
  const dst = path.join(DIST, 'onnxruntime.dll')
  if (exists(dst)) {
    log(`onnxruntime.dll 已存在（${sizeMb(dst)} MB），跳过`)
    return
  }
  log(`下载 ONNX Runtime DirectML ${ORT_NUGET_VERSION} …`)
  const res = await fetch(ORT_NUGET_URL)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const zip = new AdmZip(buf)
  const entry = zip.getEntry('runtimes/win-x64/native/onnxruntime.dll')
  if (!entry) throw new Error('nupkg 里没有 runtimes/win-x64/native/onnxruntime.dll')
  await fsp.writeFile(dst, entry.getData())
  log(`onnxruntime.dll 已写入（${sizeMb(dst)} MB）`)
}

/** 从 ort 的下载缓存里找 DirectML.dll（cargo build 时 ort-sys 会下载） */
async function findDirectML() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ort.pyke.io')
  if (!exists(base)) return null
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.toLowerCase() === 'directml.dll') {
        try {
          if (fs.statSync(full).size > 1024 * 1024) return full
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null
}

async function ensureDirectML() {
  const dst = path.join(DIST, 'DirectML.dll')
  if (exists(dst)) {
    log(`DirectML.dll 已存在（${sizeMb(dst)} MB），跳过`)
    return
  }
  const src = await findDirectML()
  if (!src) {
    log('未找到 DirectML.dll')
    log('它由 ort-sys 在构建时下载，请先执行一次 cargo build --release，再重跑本脚本。')
    process.exitCode = 1
    return
  }
  await fsp.copyFile(src, dst)
  log(`DirectML.dll 已复制（${sizeMb(dst)} MB，来源 ${src}）`)
}

async function main() {
  await fsp.mkdir(DIST, { recursive: true })
  const ok = await ensureExe()
  if (!ok) return
  await ensureOnnxRuntime()
  await ensureDirectML()
  if (!process.exitCode) log(`完成，产物在 ${DIST}`)
}

main().catch((err) => {
  console.error('[sbv2-dist] 失败：', err)
  process.exitCode = 1
})

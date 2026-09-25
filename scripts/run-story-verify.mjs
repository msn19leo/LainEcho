/**
 * 剧情引擎自检运行器：与 run-prompt-golden.mjs 同款机制（vite 自带 esbuild 打包成单文件后由 Node 执行）。
 * schema/draft 模块依赖链上有 electron（storage/crypto 的惰性 API），Node 直跑需要打桩——
 * 桩只提供命名导出，被测代码均在运行期才触碰这些 API，校验路径不会实际调用。
 * 用法：npm run test:story
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmpDir = mkdtempSync(join(tmpdir(), 'lainecho-story-verify-'))
const outFile = join(tmpDir, 'verify.mjs')
// electron 桩：app.getPath 指向临时目录（示例剧本端到端校验会把样本写入 <tmp>/data/stories/），
// safeStorage 等其余 API 仅被被测代码惰性引用，校验路径不会实际调用
writeFileSync(
  join(tmpDir, 'electron-stub.mjs'),
  `export const app = { getPath: () => ${JSON.stringify(tmpDir)} }\nexport const safeStorage = {}\nexport default {}\n`,
  'utf-8',
)

try {
  await build({
    entryPoints: ['scripts/verify-story-engine.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'warning',
    alias: { electron: join(tmpDir, 'electron-stub.mjs') },
    // yaml 包内部动态 require('process')：ESM 产物需要 createRequire 垫片
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  await import(pathToFileURL(outFile).href)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}

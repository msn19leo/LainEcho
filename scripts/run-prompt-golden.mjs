/**
 * 金样测试运行器：用 vite 自带的 esbuild 把 TS 测试入口打包成单文件后交给 Node 执行，
 * 不引入任何新依赖。用法：npm run test:prompt
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmpDir = mkdtempSync(join(tmpdir(), 'lainecho-golden-'))
const outFile = join(tmpDir, 'golden.mjs')

try {
  await build({
    entryPoints: ['scripts/verify-prompt-golden.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'warning',
  })
  await import(pathToFileURL(outFile).href)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('prune-node-modules.mjs', import.meta.url))

function stage(dir, relative, content) {
  const file = join(dir, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

test('the wasm sharp build only survives in Linux artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prune-test-'))
  try {
    const modules = join(dir, 'node_modules')
    stage(modules, '@img/sharp-wasm32/index.cjs', 'module.exports = 1')
    stage(modules, '@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm', 'x'.repeat(2048))
    stage(modules, '@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node', 'native')

    const result = spawnSync(process.execPath, [script, `--dir=${modules}`], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)

    const wasm = join(modules, '@img', 'sharp-wasm32')
    const native = join(modules, '@img', 'sharp-linux-x64', 'lib', 'sharp-linux-x64-0.35.5.node')
    assert.ok(existsSync(native), '原生包不能被删')
    if (process.platform === 'linux') {
      assert.ok(existsSync(wasm), 'Linux 产物必须保留 @img/sharp-wasm32')
      assert.ok(!result.stdout.includes('已删除平台专属包'), 'Linux 上不应报告删除')
    } else {
      assert.equal(existsSync(wasm), false, `${process.platform} 产物不应携带 @img/sharp-wasm32`)
      assert.match(result.stdout, /已删除平台专属包 @img\/sharp-wasm32：2 个文件/, '报告里必须写清删了多少')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

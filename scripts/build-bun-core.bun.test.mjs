import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./build-bun-core.mjs', import.meta.url))
const project = fileURLToPath(new URL('../', import.meta.url))

test('compiler rejects working installation, unsupported pin and layout drift without replacing entry', { skip: !process.versions.bun }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-compile-guard-'))
  const core = join(scratch, 'node_modules/@deepseek-ai/dsh')
  const bin = join(core, 'lib/bin.js')
  const source = 'export async function runCli() {}\nif (import.meta.main) await runCli();\n'
  const put = (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const run = (root, expected) => {
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expected)
  }
  try {
    run(project, /Compile a separate deployed directory/)
    put(bin, source)
    put(join(core, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'unsupported', type: 'module' }))
    run(scratch, /Bun adaptation requires @deepseek-ai\/dsh@0\.2\.1-alpha\.4/)
    put(join(core, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.4', type: 'module' }))
    for (const name of ['dsh-app-boot', 'dsh-ptc-runtime-node', 'cordis-plugin-loader']) {
      const directory = join(scratch, 'node_modules/@deepseek-ai', name)
      put(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, main: 'index.js', type: 'module' }))
      put(join(directory, 'index.js'), 'export const unsupportedLayout = true;')
    }
    run(scratch, /Unsupported core layout: internalModules/)
    assert.equal(readFileSync(bin, 'utf8'), source)
    assert.equal(existsSync(join(core, `dsh-core${process.platform === 'win32' ? '.exe' : ''}`)), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function installed(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh launcher-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const bin = join(pkg, 'lib', 'bin.js')
  const core = join(pkg, `dsh-core${process.platform === 'win32' ? '.exe' : ''}`)
  const cwd = join(root, 'working directory 中文')
  const fixture = join(root, 'fixture ü.mjs')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}')
  copyFileSync(new URL('./bun-launcher.mjs', import.meta.url), bin)
  copyFileSync(process.execPath, core)
  chmodSync(core, 0o755)
  return { bin, core, cwd, fixture }
}

const modes = [['default', []]]
if (process.platform !== 'win32') modes.push(['spawn fallback', ['--import', 'data:text/javascript,process.execve=undefined']])

for (const [mode, nodeArgs] of modes) {
  test(`installed launcher preserves argv, env, cwd, stdio and exit code (${mode})`, t => {
    const { bin, cwd, fixture } = installed(t)
    writeFileSync(fixture, `
      import { readFileSync } from 'node:fs'
      process.stdout.write(JSON.stringify({
        argv: process.argv.slice(1), cwd: process.cwd(),
        node: process.env.DSH_NODE, marker: process.env.LAUNCHER_MARKER,
        stdin: readFileSync(0, 'utf8'),
      }))
      process.stderr.write('fixture stderr 中文\\n')
      process.exitCode = 37
    `)
    const args = ['', 'with spaces', '"double" and \'single\'', '中文 🦄', 'back\\slash\\', 'ends with \\', 'a\\"b', '--literal-flag']
    for (const node of [undefined, '/custom node/路径', '']) {
      const env = { ...process.env, LAUNCHER_MARKER: 'literal "value" 中文' }
      delete env.DSH_NODE
      if (node !== undefined) env.DSH_NODE = node
      const result = spawnSync(process.execPath, [...nodeArgs, bin, fixture, ...args], {
        cwd, env, input: 'fixture stdin 中文\n', encoding: 'utf8', timeout: 15000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 37, result.stderr)
      assert.equal(result.signal, null)
      assert.deepEqual(JSON.parse(result.stdout), {
        argv: [fixture, ...args], cwd: realpathSync(cwd),
        node: node ?? process.execPath, marker: env.LAUNCHER_MARKER,
        stdin: 'fixture stdin 中文\n',
      })
      assert.equal(result.stderr, 'fixture stderr 中文\n')
    }
  })
}

test('missing installed core reports its path and exits nonzero', t => {
  const { bin, core, cwd } = installed(t)
  unlinkSync(core)
  const result = spawnSync(process.execPath, [bin], { cwd, encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes(`[dsh] Cannot launch compiled core ${core}:`), result.stderr)
  assert.match(result.stderr, /ENOENT/)
})

test('Unix spawn fallback forwards SIGTERM and bounds an uncooperative child', { skip: process.platform === 'win32' }, t => {
  const { bin, cwd, fixture } = installed(t)
  for (const ignore of [false, true]) {
    writeFileSync(fixture, `
      process.on('SIGTERM', () => { if (!${ignore}) process.exit(23) })
      setTimeout(() => process.exit(99), 8000)
      process.kill(process.ppid, 'SIGTERM')
    `)
    const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,process.execve=undefined', bin, fixture], {
      cwd, encoding: 'utf8', timeout: 12000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, ignore ? 137 : 23, result.stderr)
    assert.equal(result.signal, null)
  }
})

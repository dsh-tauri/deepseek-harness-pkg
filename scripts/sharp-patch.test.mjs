import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PATCHES, applyCorePatch, isPatched } from './core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = PATCHES.find(candidate => candidate.name === 'sharp')
assert.ok(entry, 'core-patches.mjs 必须登记 sharp')

const WASM_REQUIRE = 'sharp = require("@img/sharp-wasm32/sharp.node");'

// 上游 dist/sharp.cjs 加载器的最小样本：与 sharp 0.35.x 一致，第二个 `if (!sharp)`
// 里包着 try + 原生平台 switch。缩进与空行原样保留。
const SAMPLE = [
  'let sharp;',
  'const errors = [];',
  'try {',
  '  sharp = require(`../src/build/Release/sharp-${runtimePlatform}-${version}.node`);',
  '} catch (err) {',
  '  errors.push(err);',
  '}',
  'if (!sharp) {',
  '  try {',
  '    sharp = require(`../src/build/Release/sharp-wasm32-${version}.node`);',
  '  } catch (err) {',
  '    errors.push(err);',
  '  }',
  '}',
  'if (!sharp) {',
  '  try {',
  '    switch (runtimePlatform) {',
  '      case "darwin-arm64":',
  '        sharp = require("@img/sharp-darwin-arm64/sharp.node");',
  '        break;',
  '      case "linux-x64":',
  '        sharp = require("@img/sharp-linux-x64/sharp.node");',
  '        break;',
  '    }',
  '  } catch (err) {',
  '    errors.push(err);',
  '  }',
  '}',
  'module.exports = sharp;',
  '',
].join('\n')

const patched = applyCorePatch(SAMPLE, entry).source

test('the sharp patch inserts the wasm shortcut instead of rewriting the loader', () => {
  // 补丁只新增：上游的加载语句、switch 分支、错误收集都原样保留。
  for (const line of SAMPLE.split('\n')) {
    if (line !== '') assert.ok(patched.includes(line), `补丁删掉了上游行: ${line}`)
  }
  assert.equal(patched.split(WASM_REQUIRE).length - 1, 1, '样本里只应新增一次 wasm require')
})

test('the wasm shortcut lands outside the guard that protects the native platform switch', () => {
  const guard = patched.indexOf(entry.markers[1])
  const nativeSwitch = patched.indexOf('switch (runtimePlatform)')
  assert.ok(guard > 0, '缺少 Electron + Linux 判断')
  assert.ok(nativeSwitch > guard, 'WebAssembly 分支必须在原生平台 switch 之前')
  assert.match(patched, /if \(!sharp && Boolean\(process\.versions\.electron\) && runtimePlatform\.startsWith\("linux"\)\) \{/)
  // 关键：switch 里每个 case 都是无条件的 `sharp = require(...)`。wasm 尝试必须放在
  // 包住 switch 的那个 `if (!sharp)` 之外，否则会被 case 覆盖回原生二进制。
  const between = patched.slice(guard, nativeSwitch)
  assert.match(between, /if \(!sharp\) \{\s*\n\s*try \{\s*$/u, 'wasm 短路必须位于原生分派的 if (!sharp) 之外')
  // 加载失败只记录错误，随后仍会走原生 switch，即回落到原生二进制。
  assert.match(patched, /errors\.push\(err\);\s*\}\s*\}\s*if \(!sharp\) \{/)
})

test('the shortcut is only for Electron on Linux', () => {
  const guard = patched.slice(patched.indexOf(entry.markers[1]), patched.indexOf('switch (runtimePlatform)'))
  assert.doesNotMatch(guard, /darwin|win32|android/, '平台判断不能外溢到其它系统')
  assert.doesNotMatch(guard, /process\.platform ===/, '必须沿用 runtimePlatform，否则会绕开 libc 判定')
})

test('markers separate the patched loader from the upstream one', () => {
  assert.equal(isPatched(SAMPLE, entry), false, '原始文件不应含任何标记')
  assert.equal(isPatched(patched, entry), true, '打补丁后应含全部标记')
  for (const marker of entry.markers) {
    assert.ok(!SAMPLE.includes(marker), `标记在原文里已存在，缺少区分度: ${marker}`)
  }
})

// 行为验证：真跑一遍补丁后的加载器，确认 Electron + Linux 命中 wasm、纯 Node 命中原生。
// 只做文本断言抓不到 run 43351855853 那种「wasm 加载后又被原生 case 覆盖」的回归。
test('the patched loader really picks wasm under Electron on Linux and native otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sharp-loader-test-'))
  try {
    const stubs = {
      '@img/sharp-wasm32': 'wasm',
      '@img/sharp-linux-x64': 'native',
      '@img/sharp-darwin-arm64': 'native',
    }
    for (const [name, engine] of Object.entries(stubs)) {
      const pkg = join(dir, 'node_modules', ...name.split('/'))
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name,
        version: '0.0.0',
        exports: { './sharp.node': './index.cjs' },
      }))
      writeFileSync(join(pkg, 'index.cjs'), `module.exports = { engine: ${JSON.stringify(engine)}, pkg: ${JSON.stringify(name)} };\n`)
    }
    // 真实加载器要做的就是 runtimePlatform 的分派；把它钉成 linux-x64 即可在任意宿主上验证。
    const loader = join(dir, 'sharp.cjs')
    writeFileSync(loader, `const runtimePlatform = 'linux-x64';\nconst version = '0.0.0';\n${patched}`)
    const script = join(dir, 'probe.cjs')
    writeFileSync(script, [
      "const electron = process.argv[2] === 'electron'",
      "if (electron) Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })",
      `const sharp = require(${JSON.stringify(loader)})`,
      'console.log(JSON.stringify({ engine: sharp.engine, pkg: sharp.pkg }))',
    ].join('\n'))

    const wasmRun = spawnSync(process.execPath, [script, 'electron'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(wasmRun.status, 0, wasmRun.stderr)
    assert.deepEqual(JSON.parse(wasmRun.stdout.trim()), { engine: 'wasm', pkg: '@img/sharp-wasm32' })

    // 纯 Node 必须仍走平台原生二进制，不能因为补丁掉性能。
    const nativeRun = spawnSync(process.execPath, [script, 'node'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(nativeRun.status, 0, nativeRun.stderr)
    assert.deepEqual(JSON.parse(nativeRun.stdout.trim()), { engine: 'native', pkg: '@img/sharp-linux-x64' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const installed = join(root, 'node_modules', 'sharp', 'dist', 'sharp.cjs')

test('the real installed sharp is rewritable and stays otherwise intact', { skip: !existsSync(installed) }, () => {
  const source = readFileSync(installed, 'utf8')
  const { source: result } = applyCorePatch(source, entry)
  assert.ok(isPatched(result, entry), 'node_modules 里的 sharp 无法套用 wasm 短路补丁')
  assert.match(result, /^module\.exports = sharp;$/m, '文件尾部必须保持完整')
  // 上游自带的 wasm 兜底（switch 之后）与补丁（原生分派之前）各自保留一份。
  const guard = result.indexOf(entry.markers[1])
  const nativeSwitch = result.indexOf('switch (runtimePlatform)')
  assert.ok(guard > 0 && nativeSwitch > guard, '补丁必须落在原生 switch 之前')
  assert.match(result.slice(guard, nativeSwitch), /if \(!sharp\) \{\s*\n\s*try \{\s*$/u, '补丁必须在保护原生分派的 if (!sharp) 之外')
})

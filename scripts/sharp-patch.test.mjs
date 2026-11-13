import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PATCHES, applyCorePatch, isPatched } from './core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = PATCHES.find(candidate => candidate.name === 'sharp')
assert.ok(entry, 'core-patches.mjs 必须登记 sharp')

const WASM_REQUIRE = 'sharp = require("@img/sharp-wasm32/sharp.node");'

// 上游 dist/sharp.cjs 加载器的最小样本（sharp 0.35.x 的形状，缩进与空行原样保留）。
const SAMPLE = [
  'let sharp;',
  'const errors = [];',
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

test('the wasm shortcut lands before the native platform switch', () => {
  const guard = patched.indexOf(entry.markers[1])
  const nativeSwitch = patched.indexOf('switch (runtimePlatform)')
  assert.ok(guard > 0, '缺少 Electron + Linux 判断')
  assert.ok(nativeSwitch > guard, 'WebAssembly 分支必须在原生平台 switch 之前')
  assert.match(patched, /if \(!sharp && Boolean\(process\.versions\.electron\) && runtimePlatform\.startsWith\("linux"\)\) \{/)
  // 加载失败只记录错误，随后仍会走原生 switch，即回落到原生二进制。
  assert.match(patched, /errors\.push\(err\);\s*\}\s*\}\s*switch \(runtimePlatform\) \{/)
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

const installed = join(root, 'node_modules', 'sharp', 'dist', 'sharp.cjs')

test('the real installed sharp is rewritable and stays otherwise intact', { skip: !existsSync(installed) }, () => {
  const source = readFileSync(installed, 'utf8')
  const { source: result } = applyCorePatch(source, entry)
  assert.ok(isPatched(result, entry), 'node_modules 里的 sharp 无法套用 wasm 短路补丁')
  assert.match(result, /^module\.exports = sharp;$/m, '文件尾部必须保持完整')
  // 上游自带的 wasm 兜底（switch 之后）与补丁（switch 之前）各自保留一份。
  const guard = result.indexOf(entry.markers[1])
  const nativeSwitch = result.indexOf('switch (runtimePlatform)')
  assert.ok(guard > 0 && nativeSwitch > guard, '补丁必须落在原生 switch 之前')
})

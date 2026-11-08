import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PATCHES, applyUnifiedDiff, isPatched, parseHunks } from './core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const patchPath = join(root, 'patches', 'sharp@0.35.5.patch')
const patch = readFileSync(patchPath, 'utf8')
const entry = PATCHES.find(candidate => candidate.name === 'sharp')
assert.ok(entry, 'core-patches.mjs 必须登记 sharp')

// 只保留补丁里非新增的行，得到上游 dist/sharp.cjs 对应片段的最小样本。
const pristine = parseHunks(patch)
  .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text))
  .join('\n')

const patched = applyUnifiedDiff(pristine, patch, entry.patch)
const WASM_REQUIRE = 'sharp = require("@img/sharp-wasm32/sharp.node");'

test('the sharp patch inserts the wasm shortcut instead of rewriting the loader', () => {
  const hunks = parseHunks(patch)
  assert.equal(hunks.length, 1, '只应有一个 hunk，避免多点改写')
  assert.equal(hunks[0].lines.filter(line => line.kind === 'remove').length, 0, '补丁只新增，不改动上游行')
  assert.match(patch, /^--- a\/dist\/sharp\.cjs$/m)
  assert.match(patch, /^\+\+\+ b\/dist\/sharp\.cjs$/m)
})

test('the wasm shortcut lands before the native platform switch', () => {
  const guard = patched.indexOf(entry.markers[1])
  const nativeSwitch = patched.indexOf('switch (runtimePlatform)')
  assert.ok(guard > 0, '缺少 Electron + Linux 判断')
  assert.ok(nativeSwitch > guard, 'WebAssembly 分支必须在原生平台 switch 之前')
  // 补丁只在开关前新增一次 wasm require；上游在原生 switch 之后的兜底必须原样保留。
  assert.equal(pristine.split(WASM_REQUIRE).length - 1, 0)
  assert.equal(patched.split(WASM_REQUIRE).length - 1, 1)
  assert.match(patched, /if \(!sharp && Boolean\(process\.versions\.electron\) && runtimePlatform\.startsWith\("linux"\)\) \{/)
  // 加载失败只记录错误，随后仍会走原生 switch，即回落到原生二进制。
  assert.match(patched, /errors\.push\(err\);\s*\}\s*\}\s*if \(!sharp\) \{/)
})

test('the shortcut is only for Electron on Linux', () => {
  const guard = patched.slice(patched.indexOf(entry.markers[1]), patched.indexOf('switch (runtimePlatform)'))
  assert.doesNotMatch(guard, /darwin|win32|android/, '平台判断不能外溢到其它系统')
  assert.doesNotMatch(guard, /process\.platform ===/, '必须沿用 runtimePlatform，否则会绕开 libc 判定')
})

test('markers separate the patched loader from the upstream one', () => {
  assert.equal(isPatched(pristine, entry), false, '原始文件不应含任何标记')
  assert.equal(isPatched(patched, entry), true, '打补丁后应含全部标记')
  for (const marker of entry.markers) {
    assert.ok(!pristine.includes(marker), `标记在原文里已存在，缺少区分度: ${marker}`)
  }
})

test('the real installed sharp carries the patch and stays otherwise intact', { skip: !existsSync(join(root, 'node_modules', 'sharp', 'dist', 'sharp.cjs')) }, () => {
  const source = readFileSync(join(root, 'node_modules', 'sharp', 'dist', 'sharp.cjs'), 'utf8')
  // 移除补丁新增的行还原上游文件，再用补丁打回去：两个方向都必须逐字节对齐。
  const added = parseHunks(patch).flatMap(hunk => hunk.lines.filter(line => line.kind === 'add').map(line => line.text))
  const lines = source.split('\n')
  const start = lines.findIndex((_, index) => added.every((text, offset) => lines[index + offset] === text))
  assert.ok(start >= 0, 'node_modules 里的 sharp 没有补丁（pnpm-workspace.yaml 的 patchedDependencies 未生效？）')
  const upstream = [...lines.slice(0, start), ...lines.slice(start + added.length)].join('\n')
  assert.equal(isPatched(upstream, entry), false)
  assert.equal(applyUnifiedDiff(upstream, patch, entry.patch), source, '补丁必须能把上游文件还原成安装后的内容')
  assert.match(source, /^module\.exports = sharp;$/m, '文件尾部必须保持完整')
})

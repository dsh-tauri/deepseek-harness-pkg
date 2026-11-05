import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from './apply-core-patches.mjs'
import { check } from './check-core-patches.mjs'
import { PATCHES, applyUnifiedDiff, isPatched, parseHunks } from './core-patches.mjs'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const patchesDir = fileURLToPath(new URL('patches/', root))

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-core-patches-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function pristineSource(entry) {
  return parseHunks(read(`patches/${entry.patch}`))
    .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text))
    .join('\n')
}

function patchedSource(entry) {
  return applyUnifiedDiff(pristineSource(entry), read(`patches/${entry.patch}`), entry.patch)
}

function stage(dir, entry, content) {
  const file = join(dir, 'node_modules', ...entry.name.split('/'), entry.file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

test('each patch applies to its own context and exposes every marker', () => {
  for (const entry of PATCHES) {
    const pristine = pristineSource(entry)
    assert.equal(isPatched(pristine, entry), false, `${entry.name}: 原始样本已含标记，标记缺少区分度`)
    const patched = applyUnifiedDiff(pristine, read(`patches/${entry.patch}`), entry.patch)
    assert.ok(isPatched(patched, entry), `${entry.name}: 应用后仍缺标记`)
  }
})

test('applying a patch twice is rejected so callers cannot double-write', () => {
  for (const entry of PATCHES) {
    const patched = patchedSource(entry)
    const again = isPatched(patched, entry) ? patched : applyUnifiedDiff(patched, read(`patches/${entry.patch}`), entry.patch)
    assert.equal(again, patched)
  }
})

test('a hunk whose context is gone is rejected instead of applied blindly', () => {
  assert.throws(() => applyUnifiedDiff('nothing like the real file\n', read(`patches/${PATCHES[0].patch}`), 'sample'), /不匹配/)
})

test('check names every missing package and marker', () => {
  withTempDir((dir) => {
    assert.equal(check(dir).length, PATCHES.length)
    for (const entry of PATCHES) stage(dir, entry, patchedSource(entry))
    assert.deepEqual(check(dir), [])
    stage(dir, PATCHES[0], patchedSource(PATCHES[0]).replace(PATCHES[0].markers[0], ''))
    const missing = check(dir)
    assert.equal(missing.length, 1)
    assert.match(missing[0], /dsh-client-ui-renderer/)
  })
})

test('apply writes the patches once, then reports them as already applied', () => {
  withTempDir((dir) => {
    for (const entry of PATCHES) stage(dir, entry, pristineSource(entry))
    const first = apply(dir, patchesDir)
    assert.deepEqual(first.applied.sort(), PATCHES.map(entry => entry.name).sort())
    assert.deepEqual(check(dir), [])
    const second = apply(dir, patchesDir)
    assert.deepEqual(second.applied, [])
    assert.equal(second.skipped.length, PATCHES.length)
  })
})

test('apply leaves packages the deploy does not ship untouched', () => {
  withTempDir((dir) => {
    stage(dir, PATCHES[0], patchedSource(PATCHES[0]))
    const { applied, skipped } = apply(dir, patchesDir)
    assert.deepEqual(applied, [])
    assert.equal(skipped.length, PATCHES.length)
  })
})

test('apply refuses a target that is not a deploy output', () => {
  withTempDir((dir) => {
    assert.throws(() => apply(dir, patchesDir), /暂无|没有/)
  })
})

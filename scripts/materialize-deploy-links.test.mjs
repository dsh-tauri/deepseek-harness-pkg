import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { materialize } from './materialize-deploy-links.mjs'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-materialize-links-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writePackage(dir, name, body) {
  const root = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.js'), body)
  return root
}

test('a linked package is replaced by real files', () => {
  withTempDir((dir) => {
    const payload = join(dir, 'payload')
    const source = writePackage(payload, 'linked-pack', 'export const linked = true')
    const consumer = writePackage(payload, 'consumer', 'export const consumer = true')
    mkdirSync(join(consumer, 'node_modules'), { recursive: true })
    symlinkSync(source, join(consumer, 'node_modules', 'linked-pack'), 'junction')
    const report = materialize(payload)
    assert.equal(report.replaced, 1)
    assert.equal(readFileSync(join(consumer, 'node_modules', 'linked-pack', 'index.js'), 'utf8'), 'export const linked = true')
  })
})

test('a link back into the payload is dropped instead of copied into itself', () => {
  withTempDir((dir) => {
    const payload = join(dir, 'payload')
    writePackage(payload, 'self', 'export const self = true')
    const link = join(payload, 'node_modules', 'dsh-python-runtime-closure')
    symlinkSync(payload, link, 'junction')
    const report = materialize(payload)
    assert.equal(report.dropped, 1)
    assert.equal(existsSync(link), false)
    assert.equal(readFileSync(join(payload, 'node_modules', 'self', 'index.js'), 'utf8'), 'export const self = true')
  })
})

test('a cyclic workspace link chain terminates and leaves no links behind', () => {
  withTempDir((dir) => {
    const payload = join(dir, 'payload')
    const a = writePackage(payload, 'pack-a', 'export const a = true')
    const b = writePackage(payload, 'pack-b', 'export const b = true')
    mkdirSync(join(a, 'node_modules'), { recursive: true })
    symlinkSync(b, join(a, 'node_modules', 'pack-b'), 'junction')
    mkdirSync(join(b, 'node_modules'), { recursive: true })
    symlinkSync(a, join(b, 'node_modules', 'pack-a'), 'junction')
    const report = materialize(payload)
    assert.ok(report.replaced >= 2, '每个方向的链接都要解引用')
    // 复制时不再带上嵌套 node_modules，循环因此就地终止。
    assert.equal(existsSync(join(a, 'node_modules', 'pack-b', 'node_modules', 'pack-a', 'node_modules')), false)
    assert.equal(readFileSync(join(a, 'node_modules', 'pack-b', 'index.js'), 'utf8'), 'export const b = true')
  })
})

test('a .bin link directory is removed', () => {
  withTempDir((dir) => {
    const payload = join(dir, 'payload')
    const bin = join(payload, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const target = writePackage(payload, 'cli', '#!/usr/bin/env node')
    symlinkSync(target, join(bin, 'cli'), 'junction')
    const report = materialize(payload)
    assert.equal(report.bins, 1)
    assert.equal(existsSync(bin), false)
  })
})

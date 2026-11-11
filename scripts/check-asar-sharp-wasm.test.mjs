import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkAsar } from './check-asar-sharp-wasm.mjs'

const WASM_BYTES = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d]), Buffer.alloc(64)])

function buildAsar(files) {
  const header = { files: {} }
  let offset = 0
  const bodies = []
  const insert = (parts, name, bytes) => {
    let node = header
    for (const part of parts.slice(0, -1)) {
      if (node.files[part] === undefined) node.files[part] = { files: {} }
      node = node.files[part]
    }
    node.files[parts[parts.length - 1]] = { size: bytes.length, offset: String(offset) }
    bodies.push(bytes)
    offset += bytes.length
  }

  for (const [path, bytes] of Object.entries(files)) {
    insert(path.split('/'), path.split('/').pop(), Buffer.from(bytes))
  }

  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - ((16 + json.length) % 4)) % 4
  const bodySize = offset
  const headerSize = json.length + 8 + pad
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerSize, 4)
  prefix.writeUInt32LE(json.length + 4 + pad, 8)
  prefix.writeUInt32LE(json.length, 12)
  return Buffer.concat([prefix, json, Buffer.alloc(pad), ...bodies])
}

const patchedSharp = '// sharp\n/* dsh-tauri-desktop: Electron for Linux links the system GLib */\nmodule.exports = 1\n'

function wasmFiles(sharpSource = patchedSharp) {
  return {
    'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp', version: '0.35.5' }),
    'node_modules/sharp/dist/sharp.cjs': sharpSource,
    'node_modules/@img/sharp-wasm32/package.json': JSON.stringify({ name: '@img/sharp-wasm32', version: '0.35.5' }),
    'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm': WASM_BYTES,
    'node_modules/@emnapi/runtime/package.json': JSON.stringify({ name: '@emnapi/runtime', version: '1.11.3' })
  }
}

function writeArchive(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asar-check-'))
  const path = join(dir, 'core.asar')
  writeFileSync(path, buildAsar(files))
  return { dir, path }
}

test('an asar carrying the wasm fallback passes', () => {
  const { dir, path } = writeArchive(wasmFiles())
  try {
    const result = checkAsar(path)
    assert.deepEqual(result.problems, [])
    assert.equal(result.sharpVersion, '0.35.5')
    assert.equal(result.wasmVersion, '0.35.5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the published artifact shape is reported as broken', () => {
  const { dir, path } = writeArchive({
    'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp', version: '0.35.5' }),
    'node_modules/sharp/dist/sharp.cjs': '// upstream sharp\n'
  })
  try {
    const result = checkAsar(path)
    assert.ok(result.problems.some(problem => problem.includes('@img/sharp-wasm32')), '缺少 wasm 包必须报出来')
    assert.ok(result.problems.some(problem => problem.includes('wasm 短路补丁')), '缺少补丁必须报出来')
    assert.ok(result.problems.some(problem => problem.includes('@emnapi/runtime')), '缺少运行时依赖必须报出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wasm package of another version is rejected', () => {
  const files = wasmFiles()
  files['node_modules/@img/sharp-wasm32/package.json'] = JSON.stringify({ name: '@img/sharp-wasm32', version: '0.34.0' })
  const { dir, path } = writeArchive(files)
  try {
    const result = checkAsar(path)
    assert.ok(result.problems.some(problem => problem.includes('版本')), '版本不一致必须报出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a truncated wasm file is rejected', () => {
  const files = wasmFiles()
  files['node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm'] = Buffer.from('not wasm')
  const { dir, path } = writeArchive(files)
  try {
    const result = checkAsar(path)
    assert.ok(result.problems.some(problem => problem.includes('不是合法的 wasm 文件')), '非法 wasm 必须报出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('require-wasm=false only checks the sharp patch', () => {
  const { dir, path } = writeArchive({
    'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp', version: '0.35.5' }),
    'node_modules/sharp/dist/sharp.cjs': patchedSharp
  })
  try {
    assert.deepEqual(checkAsar(path, { requireWasm: false }).problems, [])
    assert.ok(checkAsar(path).problems.length > 0, '默认仍要求 wasm 回退')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

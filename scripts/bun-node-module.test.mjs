import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stripTypeScriptTypes } from './bun-node-module.mjs'

const node = process.env.DSH_NODE || process.execPath
const referenceScript = `
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
const { code, options } = JSON.parse(readFileSync(0, 'utf8'))
try {
  process.stdout.write(JSON.stringify({ result: stripTypeScriptTypes(code, options) }))
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { name: error.name, message: error.message, code: error.code } }))
}
`

function compare(code, options) {
  const reference = spawnSync(node, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', referenceScript], {
    input: JSON.stringify({ code, options }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000,
  })
  assert.ifError(reference.error)
  assert.equal(reference.status, 0, 'Reference requires a real Node with stripTypeScriptTypes; set DSH_NODE under Bun')
  const expected = JSON.parse(reference.stdout)
  if (expected.error) {
    assert.throws(() => stripTypeScriptTypes(code, options), error => {
      assert.ok(error instanceof Error)
      assert.deepEqual(JSON.parse(JSON.stringify({ name: error.name, message: error.message, code: error.code })), expected.error)
      if (expected.error.name === 'TypeError') assert.ok(error instanceof TypeError)
      if (expected.error.name === 'SyntaxError') assert.ok(error instanceof SyntaxError)
      return true
    })
    return expected
  }
  const result = stripTypeScriptTypes(code, options)
  assert.equal(result, expected.result)
  return { result }
}

test('default stripping preserves exact whitespace, comments, line endings and Unicode', () => {
  for (const code of [
    '',
    '\t// untouched\r\nconst text = "中文 🦄";  \r\n',
    'interface Item { value: number }\r\n\tconst item: Item = { value: 2 };\r\nitem.value satisfies number;\t',
    'type Pair<T> = [T, T];\nconst pair: Pair<number> = [1, 2] as const;\n',
    'const literal: string = "quotes and $()";\nthrow new Error("strip must not execute");',
  ]) assert.equal(typeof compare(code).result, 'string')
})

test('PTC fixed 35/-2 wrapper slices retain await and return semantics', async () => {
  const prefix = 'async function __dsh_program__() {\n'
  const suffix = '\n}'
  const program = '\tconst value: number = await Promise.resolve(42);\r\nreturn { value } satisfies { value: number }; // tail'
  assert.equal(prefix.length, 35)
  const { result } = compare(prefix + program + suffix)
  assert.equal(result.slice(0, 35), prefix)
  assert.equal(result.slice(-2), suffix)
  const body = result.slice(35, result.length - 2)
  assert.equal(body.length, program.length)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.deepEqual(await new AsyncFunction(body)(), { value: 42 })
  assert.equal(typeof compare('const value: number = await Promise.resolve(42);\nvalue;').result, 'string')
})

test('default and strip mode reject enum, non-erasable syntax and malformed TypeScript like Node', () => {
  for (const options of [undefined, { mode: 'strip' }]) {
    for (const code of [
      'enum State { Ready, Done }',
      'namespace State { export const ready = true }',
      'class State { constructor(public ready: boolean) {} }',
      'const broken: = ;',
    ]) assert.ok(compare(code, options).error)
  }
})

test('JSON options preserve sourceUrl, strip/transform modes and source maps', () => {
  const sourceUrl = 'file:///path/with%20space/来源.ts?value="quoted"'
  const code = 'const value: number = 42;'
  const stripped = compare(code, { mode: 'strip', sourceUrl }).result
  assert.ok(stripped.includes(`//# sourceURL=${sourceUrl}`))
  const transformed = compare('enum State { Ready, Done }\nconst value: State = State.Ready;', {
    mode: 'transform', sourceMap: true, sourceUrl,
  }).result
  assert.ok(transformed.includes('sourceMappingURL=data:application/json;base64,'))
  compare(code, { mode: 'transform', sourceMap: false, sourceUrl })
  compare(code, { transform: true, sourceMap: false })
})

test('code and option validation comes from Node, including unsupported option combinations', () => {
  for (const code of [undefined, null, 42, false, {}, []]) assert.ok(compare(code).error)
  for (const options of [
    null, false, 42, 'strip', [],
    { mode: 'unknown' }, { mode: false },
    { sourceMap: 'true' }, { mode: 'strip', sourceMap: true },
    { sourceUrl: 42 },
  ]) compare('const value: number = 42;', options)
})

test('bridge handles source larger than the spawnSync default buffer', () => {
  compare(`/*${'x'.repeat(1024 * 1024 + 64)}*/\r\nconst value: number = 42;\r\n`)
})

test('bad DSH_NODE fails without native fallback or program text in diagnostics', () => {
  const previous = process.env.DSH_NODE
  process.env.DSH_NODE = join(tmpdir(), `dsh-missing-node-${randomUUID()}`, 'node.exe')
  try {
    assert.throws(() => stripTypeScriptTypes('const secret: string = "private-program-token";'), error => {
      assert.equal(error.code, 'ENOENT')
      assert.match(error.message, /DSH_NODE/)
      assert.ok(!String(error.stack).includes('private-program-token'))
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_NODE
    else process.env.DSH_NODE = previous
  }
})

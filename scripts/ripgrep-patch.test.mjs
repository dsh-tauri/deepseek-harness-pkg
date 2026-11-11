import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PATCHES, applyUnifiedDiff, isPatched, parseHunks } from './core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const patch = readFileSync(join(root, 'patches', '@vscode__ripgrep@1.18.0.patch'), 'utf8')
const entry = PATCHES.find(candidate => candidate.name === '@vscode/ripgrep')
assert.ok(entry, 'core-patches.mjs 必须登记 @vscode/ripgrep')

// 上游 lib/index.js 的原始片段（去掉补丁新增行），用作最小样本。
const pristine = parseHunks(patch)
  .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text))
  .join('\n')

const patched = applyUnifiedDiff(pristine, patch, entry.patch)
const installed = join(root, 'node_modules', '@vscode', 'ripgrep', 'lib', 'index.js')
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'

test('the ripgrep patch replaces the CJS-only resolution instead of adding a second path', () => {
  assert.ok(patch.includes('--- a/lib/index.js'))
  assert.ok(patch.includes('+++ b/lib/index.js'))
  // 上游唯一的解析行必须被替换掉：留着 require.resolve 就等于 asar 路径照旧。
  assert.ok(patched.includes('resolved = resolveBinary('))
  assert.ok(!patched.includes('resolved = require.resolve('))
})

test('the patch only changes resolution and keeps the exported contract', () => {
  assert.ok(patched.includes('export const rgPath = resolved;'), 'rgPath 仍是具名导出')
  // 补丁不许删掉上游任何一行：二进制名、平台包名和错误文案都原样保留。
  assert.equal(parseHunks(patch).flatMap(hunk => hunk.lines.filter(line => line.kind === 'remove')).length, 1, '只应替换唯一的那行解析语句')
})

test('the fallbacks stay ordered: ESM resolve, then unpacked sibling, then a copy out', () => {
  const esm = patched.indexOf('fileURLToPath(import.meta.resolve(specifier))')
  const cjs = patched.indexOf('modulePath = require.resolve(specifier)')
  const unpacked = patched.indexOf('.asar.unpacked')
  const copy = patched.indexOf('return existsSync(unpacked) ? unpacked : materialize(modulePath)')
  assert.ok(esm > 0 && cjs > esm, 'ESM 解析失败才回落到 CJS require.resolve')
  assert.ok(unpacked > cjs && copy > unpacked, 'unpacked 探测必须在复制之前')
  // 纯 Node 产物（路径里没有 .asar）必须原样返回，行为不变。
  assert.ok(patched.includes('if (archive === -1) return modulePath;'))
  // 复制目标是按内容哈希命名的临时目录：同一份二进制只写一次。
  assert.ok(patched.includes("createHash('sha256')"))
  assert.ok(patched.includes("join(tmpdir(), 'dsh-ripgrep'"))
})

test('markers separate the patched module from the upstream one', () => {
  assert.equal(isPatched(pristine, entry), false, '原始文件不应含任何标记')
  assert.equal(isPatched(patched, entry), true, '打补丁后应含全部标记')
  for (const marker of entry.markers) {
    assert.ok(!pristine.includes(marker), '标记在原文里已存在，缺少区分度: ' + marker)
  }
})

test('the patched module keeps the plain Node path and really runs rg', { skip: !existsSync(installed) }, () => {
  const source = readFileSync(installed, 'utf8')
  assert.equal(isPatched(source, entry), true, 'node_modules 里的 @vscode/ripgrep 没有补丁（pnpm-workspace.yaml 的 patchedDependencies 未生效？）')
  // 这段只在真实上游文件上验证得到：补丁样本只含 hunk 上下文。
  assert.ok(source.includes("const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';"), '二进制名保持不变')
  assert.ok(source.includes('const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;'), '平台包名保持不变')
  assert.ok(source.includes('Could not find ${platformPkg}'), '解析失败仍抛出同一条可诊断错误')
  const result = probe(source, () => installed)
  const expected = join(root, 'node_modules', '@vscode', 'ripgrep-' + process.platform + '-' + process.arch, 'bin', binaryName)
  assert.equal(result.rgPath, expected)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ripgrep /)
})

test('a binary that only resolves into an .asar archive is copied out and runs', { skip: !existsSync(installed) }, () => {
  const platformPkg = '@vscode/ripgrep-' + process.platform + '-' + process.arch
  const binary = join(root, 'node_modules', ...platformPkg.split('/'), 'bin', binaryName)
  if (!existsSync(binary)) return
  const source = readFileSync(installed, 'utf8')
  const result = probe(source, (dir) => {
    // 模拟 Electron 的 asar 布局：模块和平台包都在同一个 .asar 目录里，
    // 所以从模块解析出的二进制路径必然指向归档内部。
    const archive = join(dir, 'app.asar')
    const pkg = join(archive, 'node_modules', ...platformPkg.split('/'))
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: platformPkg, version: '1.18.0', main: 'index.js' }))
    writeFileSync(join(pkg, 'bin', binaryName), readFileSync(binary))
    const module = join(archive, 'node_modules', '@vscode', 'ripgrep', 'lib', 'index.js')
    mkdirSync(join(archive, 'node_modules', '@vscode', 'ripgrep', 'lib'), { recursive: true })
    writeFileSync(join(archive, 'node_modules', '@vscode', 'ripgrep', 'package.json'), JSON.stringify({ name: '@vscode/ripgrep', version: '1.18.0', type: 'module' }))
    writeFileSync(module, source)
    return module
  })
  assert.ok(result.rgPath.includes('dsh-ripgrep'), '应当把二进制复制出归档，实际 ' + result.rgPath)
  assert.ok(!result.rgPath.includes('.asar'), '返回的路径不能还指向归档')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ripgrep /)
})

// 把补丁后的模块落盘并真跑一次 rg。
function probe(source, prepare) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ripgrep-patch-test-'))
  try {
    const module = prepare(dir)
    const script = join(dir, 'probe.mjs')
    writeFileSync(script, [
      'const mod = await import(' + JSON.stringify(pathToFileURL(module).href) + ')',
      'const { spawnSync } = await import("node:child_process")',
      'const run = spawnSync(mod.rgPath, ["--version"], { encoding: "utf8" })',
      'console.log(JSON.stringify({ rgPath: mod.rgPath, status: run.status, stdout: run.stdout, stderr: String(run.error ?? run.stderr ?? "") }))',
    ].join('\n'))
    const exec = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 })
    assert.equal(exec.status, 0, exec.stderr)
    return JSON.parse(exec.stdout.trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

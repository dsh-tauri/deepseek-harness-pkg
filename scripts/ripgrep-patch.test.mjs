import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PATCHES, applyCorePatch, isPatched } from './core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = PATCHES.find(candidate => candidate.name === '@vscode/ripgrep')
assert.ok(entry, 'core-patches.mjs 必须登记 @vscode/ripgrep')

// @vscode/ripgrep 1.18.0 的 lib/index.js（上游原样）。这个包不是构建产物，
// 所以不存在压缩布局，样本即真实源码。
const SAMPLE = [
  "import { createRequire } from 'node:module';",
  '',
  'const require = createRequire(import.meta.url);',
  '',
  'const arch = process.env.npm_config_arch || process.arch;',
  "const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';",
  'const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;',
  '',
  'let resolved;',
  'try {',
  '    resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);',
  '} catch {',
  '    throw new Error(',
  '        `Could not find ${platformPkg}. ` +',
  '        `Ensure optionalDependencies are installed for this platform (${process.platform}-${arch}).`',
  '    );',
  '}',
  '',
  'export const rgPath = resolved;',
  '',
].join('\n')

const patched = applyCorePatch(SAMPLE, entry).source
const installed = join(root, 'node_modules', '@vscode', 'ripgrep', 'lib', 'index.js')
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'

test('the ripgrep patch replaces the CJS-only resolution instead of adding a second path', () => {
  // 上游唯一的解析行必须被替换掉：留着 require.resolve 就等于 asar 路径照旧。
  assert.ok(patched.includes('resolved = resolveBinary('))
  assert.ok(!patched.includes('resolved = require.resolve('))
  // 上游其它内容一行都不能少（二进制名、平台包名、错误文案）。
  for (const line of SAMPLE.split('\n')) {
    if (line !== '' && !line.includes('resolved = require.resolve(')) assert.ok(patched.includes(line), `补丁删掉了上游行: ${line}`)
  }
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
  assert.equal(isPatched(SAMPLE, entry), false, '原始文件不应含任何标记')
  assert.equal(isPatched(patched, entry), true, '打补丁后应含全部标记')
  for (const marker of entry.markers) {
    assert.ok(!SAMPLE.includes(marker), `标记在原文里已存在，缺少区分度: ${marker}`)
  }
})

test('the patched module keeps the plain Node path and really runs rg', { skip: !existsSync(installed) }, () => {
  const patchedSource = patchedInstalled()
  const result = probe(() => installed)
  const expected = join(root, 'node_modules', '@vscode', 'ripgrep-' + process.platform + '-' + process.arch, 'bin', binaryName)
  assert.equal(result.rgPath, expected)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ripgrep /)
  assert.ok(patchedSource.includes('resolveBinary'), '安装的模块必须能被补丁改写')
})

test('a binary that only resolves into an .asar archive is copied out and runs', { skip: !existsSync(installed) }, () => {
  const platformPkg = '@vscode/ripgrep-' + process.platform + '-' + process.arch
  const binary = join(root, 'node_modules', ...platformPkg.split('/'), 'bin', binaryName)
  if (!existsSync(binary)) return
  const patchedSource = patchedInstalled()
  const result = probe((dir) => {
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
    // 这里必须写补丁后的内容：写到模块里的是回调捕获的变量，不是 probe 的入参。
    writeFileSync(module, patchedSource)
    return module
  })
  assert.ok(!result.rgPath.includes('.asar'), '返回的路径不能还指向归档: ' + result.rgPath)
  assert.ok(result.rgPath.includes('dsh-ripgrep'), '应当把二进制复制出归档，实际 ' + result.rgPath)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ripgrep /)
})

// 安装的 @vscode/ripgrep 是上游原样（补丁在 deploy 之后才套），先按锚点补丁改写一遍。
function patchedInstalled() {
  const source = readFileSync(installed, 'utf8')
  return isPatched(source, entry) ? source : applyCorePatch(source, entry).source
}

// 把给定模块落盘并真跑一次 rg。
function probe(prepare) {
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

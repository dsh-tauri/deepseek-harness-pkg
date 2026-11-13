import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PATCHES, applyCorePatch, isPatched } from './core-patches.mjs'
import { apply } from './apply-core-patches.mjs'
import { check } from './check-core-patches.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

// 每个补丁至少两个样本：未压缩（rc.1 那种带缩进的产物）与压缩后的单行产物
// （rc.2 起 tsdown 把 client.js 压成一行）。补丁必须在两种布局上都成立。
const SAMPLES = {
  '@deepseek-ai/dsh-client-ui-renderer': [
    [
      'function SlotOutlet({ slotKey, ownerProps }) { return null; }',
      '\t\texports.SlotRegistry = SlotRegistry;',
      '\t\texports.apply = apply;',
      '\t\texports.inject = inject;',
      '\t\treturn module.exports;',
      '',
    ].join('\n'),
    'function SlotOutlet({slotKey}){return null}exports.SlotRegistry=SlotRegistry;exports.apply=apply;exports.inject=inject;return module.exports}});\n',
  ],
  '@deepseek-ai/dsh-client-ui-plugin-manager': [
    'const listed = state.packages.filter((pkg) => !HIDDEN_BUNDLES.has(pkg.name) && (pkg.listedByDefault !== false || pkg.enabled));\n',
    'const listed=state.packages.filter(pkg=>!HIDDEN_BUNDLES.has(pkg.name)&&(pkg.listedByDefault!==false||pkg.enabled));\n',
  ],
  sharp: [
    [
      'let sharp;',
      'const errors = [];',
      'if (!sharp) {',
      '  try {',
      '    switch (runtimePlatform) {',
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
    ].join('\n'),
  ],
  '@vscode/ripgrep': [
    [
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
    ].join('\n'),
  ],
}

// 锚点消失时的样本：补丁必须抛错，绝不能当成「无事发生」跳过。
const BROKEN = {
  '@deepseek-ai/dsh-client-ui-renderer': 'function SlotOutlet(){return null}\nexports.inject = inject;\n',
  '@deepseek-ai/dsh-client-ui-plugin-manager': 'const installed = state.packages.filter((pkg) => pkg.installed);\n',
  sharp: 'let sharp;\nmodule.exports = sharp;\n',
  '@vscode/ripgrep': "export const rgPath = 'rg';\n",
}

for (const patch of PATCHES) {
  assert.ok(SAMPLES[patch.name], `缺少 ${patch.name} 的上游样本`)
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-core-patches-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function stage(dir, patch, content) {
  const file = join(dir, 'node_modules', ...patch.name.split('/'), patch.file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  writeFileSync(join(dirname(dirname(file)), 'package.json'), JSON.stringify({ name: patch.name, version: '0.0.0-test' }))
  return file
}

test('every patch rewrites both the pretty and the minified upstream layout', () => {
  for (const patch of PATCHES) {
    for (const pristine of SAMPLES[patch.name]) {
      assert.equal(isPatched(pristine, patch), false, `${patch.name}: 样本已含标记，标记缺少区分度`)
      const { source, changed } = applyCorePatch(pristine, patch)
      assert.equal(changed, true, `${patch.name}: 补丁没有改写样本`)
      assert.ok(isPatched(source, patch), `${patch.name}: 应用后仍缺标记`)
      // 幂等：已打过补丁的文件不会再被写一遍。
      assert.deepEqual(applyCorePatch(source, patch), { source, changed: false })
    }
  }
})

test('patches fail loudly when the upstream anchor is gone', () => {
  for (const patch of PATCHES) {
    assert.throws(() => applyCorePatch(BROKEN[patch.name], patch), /锚点|没有|SlotOutlet|命中/u, `${patch.name}: 锚点缺失时必须报错`)
  }
})

test('the renderer patch exports the SlotOutlet that upstream never exported', () => {
  const patch = PATCHES.find(entry => entry.name === '@deepseek-ai/dsh-client-ui-renderer')
  const { source } = applyCorePatch(SAMPLES[patch.name][0], patch)
  assert.match(source, /exports\.apply = apply; exports\.SlotOutlet = SlotOutlet;/u)
  assert.equal(source.split('exports.SlotOutlet = SlotOutlet;').length - 1, 1, '只应补一行导出')
  // 上游原有的导出必须原样保留。
  for (const name of ['SlotRegistry', 'apply', 'inject']) {
    assert.ok(source.includes(`exports.${name} =`), `缺少上游导出 ${name}`)
  }
})

test('the plugin manager patch hides only dsh-tauri bundles in the listed filter', () => {
  const patch = PATCHES.find(entry => entry.name === '@deepseek-ai/dsh-client-ui-plugin-manager')
  const pretty = applyCorePatch(SAMPLES[patch.name][0], patch).source
  assert.match(pretty, /!HIDDEN_BUNDLES\.has\(pkg\.name\) && !pkg\.name\.startsWith\("dsh-tauri"\) && \(pkg\.listedByDefault/u)
  assert.equal(pretty.split('startsWith("dsh-tauri")').length - 1, 1)
  // 过滤只作用于「插件」面板的 listed，不动安装/启用逻辑。
  assert.equal(pretty.includes('installed ='), false)
})

test('apply writes every patch once and the second run is a no-op', () => {
  withTempDir((dir) => {
    for (const patch of PATCHES) stage(dir, patch, SAMPLES[patch.name][0])
    const first = apply(dir)
    assert.deepEqual(first.applied.length, PATCHES.length)
    assert.deepEqual(first.untouched, [])
    assert.deepEqual(check(dir), [])
    const second = apply(dir)
    assert.deepEqual(second.applied, [])
    assert.equal(second.untouched.length, PATCHES.length)
  })
})

test('apply refuses to skip a patch whose package is missing from the deploy', () => {
  withTempDir((dir) => {
    const missing = PATCHES[PATCHES.length - 1]
    for (const patch of PATCHES) {
      if (patch !== missing) stage(dir, patch, SAMPLES[patch.name][0])
    }
    assert.throws(() => apply(dir), error => {
      assert.equal(error.failures.length, 1)
      assert.match(error.failures[0], new RegExp(`${missing.name}@版本未知|${missing.name}@0\\.0\\.0-test`))
      assert.match(error.failures[0], /不允许跳过/u)
      return true
    })
  })
})

test('apply refuses a patch whose anchor no longer matches instead of shipping it', () => {
  withTempDir((dir) => {
    stage(dir, PATCHES[0], BROKEN[PATCHES[0].name])
    assert.throws(() => apply(dir), error => {
      assert.match(error.failures[0], /命中 0 处|SlotOutlet/u)
      return true
    })
  })
})

test('check names every missing package and marker', () => {
  withTempDir((dir) => {
    assert.equal(check(dir).length, PATCHES.length)
    for (const patch of PATCHES) stage(dir, patch, applyCorePatch(SAMPLES[patch.name][0], patch).source)
    assert.deepEqual(check(dir), [])
    stage(dir, PATCHES[0], applyCorePatch(SAMPLES[PATCHES[0].name][0], PATCHES[0]).source.replace(PATCHES[0].markers[0], ''))
    const missing = check(dir)
    assert.equal(missing.length, 1)
    assert.match(missing[0], /dsh-client-ui-renderer/)
  })
})

test('apply refuses a target that is not a deploy output', () => {
  withTempDir((dir) => {
    assert.throws(() => apply(dir), /没有 node_modules/u)
  })
})

// 真实安装的包（本机 pnpm install 之后才有）：rc.1 的 bundle 也能被同一份补丁改写，
// 证明补丁不依赖某个特定版本的逐行上下文。
const installedRenderer = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-renderer', 'lib', 'client.js')
test('the real installed renderer is rewritable by the same anchor patch', { skip: !existsSync(installedRenderer) }, () => {
  const patch = PATCHES.find(entry => entry.name === '@deepseek-ai/dsh-client-ui-renderer')
  const source = readFileSync(installedRenderer, 'utf8')
  const { source: patched, changed } = applyCorePatch(source, patch)
  assert.equal(changed || isPatched(source, patch), true)
  assert.ok(isPatched(patched, patch))
  assert.match(patched, /exports\.SlotOutlet = SlotOutlet;/u)
})

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('local builds deploy upstream production dependencies plus the pinned core patches', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.scripts.build, 'pnpm deploy --filter . --prod build_dir --legacy')
  assert.equal(manifest.pnpm?.patchedDependencies, undefined)
  const workspace = read('pnpm-workspace.yaml')
  assert.match(workspace, /^patchedDependencies:$/m, '核心补丁必须在 pnpm-workspace.yaml 注册')

  // Keep desktop runtime patches on an open-ended lower-bound range so future
  // core releases continue to receive them.
  for (const name of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-llm-pi-ai',
  ]) {
    assert.ok(workspace.includes(`'${name}@>=0.2.2-rc.1':`), `${name} must keep an open-ended patch range`)
  }
})

test('release workflows no longer carry the removed ad-hoc runtime patches', () => {
  const workflowDir = new URL('.github/workflows/', root)
  for (const file of readdirSync(workflowDir).filter(file => file.endsWith('.yml'))) {
    const source = read(`.github/workflows/${file}`)
    assert.doesNotMatch(
      source,
      /apply-(?:dsh-web-app|pi-ai-codex-error)-patch|DSH_PKG_ALLOW_LAN|PI_AI_CODEX_HTML_ERROR_SANITIZED/,
      `${file} still depends on a removed runtime patch`,
    )
  }

  const sourceRelease = read('.github/workflows/release-from-source.yml')
  // 源码路径按上游 tag 原样构建，不套用 main 上的补丁；它只在 ZIP 里放 node_modules + package.json。
  assert.doesNotMatch(sourceRelease, /\bpatches\b/)
  assert.match(sourceRelease, /7z a [^\r\n]+ node_modules package\.json\r?$/m)
  assert.match(sourceRelease, /zip -r [^\r\n]+ node_modules package\.json\r?$/m)
})

test('both release paths build native Linux and Windows ARM64 and require twelve assets', () => {
  for (const file of ['release.yml', 'release-from-source.yml']) {
    const source = read(`.github/workflows/${file}`)
    if (file === 'release.yml') {
      // 补发模式同样跑全矩阵：往已有 tag 上补 asar 需要六个平台的原生内容。
      assert.match(source, /os: \[windows-latest, windows-11-arm, macos-latest, macos-15-intel, ubuntu-latest, ubuntu-24\.04-arm\]/, 'full build matrix missing')
      const assets = JSON.parse(source.match(/ARTIFACT_NAME: \$\{\{ fromJSON\('([^']+)'\)/)[1])
      assert.deepEqual(Object.values(assets), ['deepseek-harness-pkg-windows.zip', 'deepseek-harness-pkg-windows-arm64.zip', 'deepseek-harness-pkg-macos-arm64.zip', 'deepseek-harness-pkg-macos-x64.zip', 'deepseek-harness-pkg-linux.zip', 'deepseek-harness-pkg-linux-arm64.zip'])
      assert.match(source, /\)\[matrix\.os\]/)
      assert.match(source, /expected=12/)
    } else {
      assert.match(source, /os: \[[^\]\r\n]*windows-11-arm[^\]\r\n]*\]/, `${file}: Windows ARM64 runner missing`)
      assert.match(source, /- os: windows-11-arm\r?\n\s+artifact_name: deepseek-harness-pkg-windows-arm64\.zip/, `${file}: Windows ARM64 asset missing`)
      assert.match(source, /- os: windows-latest\r?\n\s+artifact_name: deepseek-harness-pkg-windows\.zip/, `${file}: Windows x64 asset changed`)
      assert.match(source, /os: \[[^\]\r\n]*ubuntu-24\.04-arm[^\]\r\n]*\]/, `${file}: ARM64 runner missing`)
      assert.match(source, /- os: ubuntu-24\.04-arm\r?\n\s+artifact_name: deepseek-harness-pkg-linux-arm64\.zip/, `${file}: ARM64 asset missing`)
      assert.match(source, /- os: ubuntu-latest\r?\n\s+artifact_name: deepseek-harness-pkg-linux\.zip/, `${file}: x64 asset changed`)
      assert.match(source, /expected=12\b/, `${file}: release must require twelve assets`)
      assert.doesNotMatch(source, /expected=(?:5|6)\b/, `${file}: stale asset count`)
    }
    // 每个平台除了 ZIP 还要产出同名 .asar（Electron 单文件资源），并一起上传。
    const asar = source.indexOf('- name: Create Electron asar')
    assert.ok(asar > source.indexOf('- name: Create archive'), `${file}: asar step missing or runs before the ZIP`)
    const asarStep = source.slice(asar, source.indexOf('- name: Upload', asar))
    assert.match(asarStep, /\$\{[A-Za-z_]+\%\.[^}]*\}\.asar"/, `${file}: asar name must be derived from the ZIP name`)
    assert.match(asarStep, /pnpm dlx @electron\/asar@\d+\.\d+\.\d+ pack /, `${file}: asar pack command missing`)
    // grep -q 会提前退出并把 SIGPIPE 传给 tr，pipefail 下整步失败（run 40566367041）。
    assert.ok(asarStep.includes("list \"$asar\" | tr '\\\\' '/' | grep -F '/node_modules/@deepseek-ai/dsh/lib/bin.js' > /dev/null"), `${file}: asar content smoke missing`)
    assert.doesNotMatch(asarStep, /grep -q '\//, `${file}: grep -q sends SIGPIPE to tr under pipefail`)
    // asar 只有 zip 外壳才上传（asar 自身不压缩，约 400 MiB）。
    assert.match(asarStep, /7z a "\$asar\.zip" "\$asar"/, `${file}: Windows asar zip missing`)
    assert.match(asarStep, /zip -q -r "\$asar\.zip" "\$asar"/, `${file}: asar zip missing`)
    assert.match(asarStep, /rm -f "\$asar"\r?\n/, `${file}: raw asar must be removed before upload`)
    assert.match(source.slice(source.indexOf('- name: Upload')), /\*\.asar\.zip/, `${file}: asar zip not uploaded`)
    assert.match(source, /assets=\(\.\/artifacts\/\*\*\/\*\.zip\)/, `${file}: release assets must be zip-only`)
    assert.doesNotMatch(source, /artifacts\/\*\*\/\*\.asar\)/, `${file}: raw asar must not be published`)
    const prune = source.indexOf('- name: Prune node_modules')
    assert.ok(prune >= 0, `${file}: prune step missing`)
    const smoke = source.indexOf('- name: Verify deployed Linux ARM64 runtime')
    assert.ok(smoke > prune, `${file}: smoke must run after pruning`)
    const step = source.slice(smoke, source.indexOf('- name: Create archive', smoke))
    assert.match(step, /if: matrix\.os == 'ubuntu-24\.04-arm'/)
    assert.match(step, /if: matrix\.os == 'windows-11-arm'/)
    assert.match(step, /assert\.equal\(process\.platform, 'win32'\)/)
    assert.match(step, /assert\.equal\(process\.arch, 'arm64'\)/)
    for (const dependency of ['koffi', 'sharp', 'node-pty']) {
      assert.ok(step.includes(`require('${dependency}')`), `${file}: missing ${dependency} smoke`)
    }
    // Electron + Linux 的 sharp 走 wasm（patch sharp@0.35.5），两条分支都要在 Linux 上真解码。
    const sharpSmoke = source.indexOf('- name: Verify patched sharp on Linux')
    assert.ok(sharpSmoke > prune, `${file}: sharp wasm smoke must run after pruning`)
    const sharpStep = source.slice(sharpSmoke, source.indexOf('- name: Verify deployed Linux ARM64 runtime', sharpSmoke))
    assert.match(sharpStep, /if: runner\.os == 'Linux'/, `${file}: sharp smoke must be Linux-only`)
    assert.match(sharpStep, /smoke-sharp-electron-linux\.mjs --dir=\. --expect=native/, `${file}: native branch smoke missing`)
    // npm 路径带着补丁，必须断言 wasm 分支；源码路径按上游 tag 原样构建，只报告实际分支。
    const electronExpect = file === 'release.yml' ? 'wasm' : 'any'
    assert.ok(
      sharpStep.includes(`smoke-sharp-electron-linux.mjs --dir=. --electron --expect=${electronExpect}`),
      `${file}: electron branch smoke must use --expect=${electronExpect}`,
    )
    assert.match(step, /node node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js web --help/)
  }
})

test('backfill validates the tag and never recreates releases or overwrites assets', () => {
  const source = read('.github/workflows/release.yml')
  const guard = source.slice(source.indexOf('- name: Validate existing release'), source.indexOf('- name: Wait for the npm tarball'))
    .split(/\r?\n/).filter(line => /^\s+(set -euo|\[\[)/.test(line)).map(line => line.trim()).join('\n')
  for (const [TAG, VERSION, status] of [['dsh-0.2.0-rc.2-123', '0.2.0-rc.2', 0], ['v0.2.0-rc.2', '0.2.0-rc.2', 1], ['dsh-0.2.0-rc.2-123', '0.2.1-alpha.4', 1]]) {
    const result = spawnSync('bash', ['-c', `${guard}\nprintf validated`], { env: { ...process.env, TAG, VERSION }, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, status, result.stderr)
    assert.equal(result.stdout, status === 0 ? 'validated' : '')
  }
  for (const name of ['Delete stale drafts for this version', 'Create release']) {
    assert.ok(source.replaceAll('\r\n', '\n').includes(`- name: ${name}\n        if: inputs.existing_release == ''`))
  }
  // 补发只上传 tag 上还缺的名字，不 clobber 已有资产。
  assert.match(source, /present="\$\(gh release view "\$TAG" --json assets --jq '\.assets\[\]\.name'\)"/)
  assert.match(source, /grep -qxF "\$\(basename "\$asset"\)" <<< "\$present" \|\| missing\+=\("\$asset"\)/)
  assert.match(source, /if \[ -n "\$EXISTING_RELEASE" \]; then[\s\S]*?upload_flags=\(\)/)
  assert.match(source, /gh release upload "\$TAG" "\$asset" "\$\{upload_flags\[@\]\}"/)
})

test('removed patch scripts and their documentation links stay removed', () => {
  for (const file of [
    'scripts/apply-dsh-web-app-patch.mjs',
    'scripts/apply-pi-ai-codex-error-patch.mjs',
    'scripts/apply-pi-ai-codex-error-patch.test.mjs',
  ]) {
    assert.equal(existsSync(new URL(file, root)), false, `${file} should be removed`)
    for (const doc of ['README.md', 'README.zh.md']) {
      assert.ok(!read(doc).includes(file), `${doc} still links to ${file}`)
    }
  }
})

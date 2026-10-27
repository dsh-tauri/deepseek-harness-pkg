import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('local builds only deploy upstream production dependencies', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.scripts.build, 'pnpm deploy --filter . --prod build_dir --legacy')
  assert.equal(manifest.pnpm?.patchedDependencies, undefined)
  assert.doesNotMatch(read('pnpm-workspace.yaml'), /patchedDependencies|apply-.*patch/)
})

test('release workflows do not apply or require removed runtime patches', () => {
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
    assert.ok(asarStep.includes("list \"$asar\" | tr '\\\\' '/' | grep -q '/node_modules/@deepseek-ai/dsh/lib/bin.js'"), `${file}: asar content smoke missing`)
    assert.match(source.slice(source.indexOf('- name: Upload')), /\*\.asar/, `${file}: asar not uploaded`)
    assert.match(source, /assets=\(\.\/artifacts\/\*\*\/\*\.zip \.\/artifacts\/\*\*\/\*\.asar\)/, `${file}: release assets must include asar`)
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

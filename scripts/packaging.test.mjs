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
  // 只认本仓库的补丁目录与补丁脚本：上游自己的 patchedDependencies 与
  // `--config.allow-unused-patches` 出现在这里并不代表套用了 main 的补丁。
  assert.doesNotMatch(sourceRelease, /\bpatches\/|(?:apply|check)-core-patches/)
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
    // 成品 asar 必须真的带上 Electron+Linux 需要的 wasm 回退：桌面端只在 asar 内存在
    // @img/sharp-wasm32 时才放行 sharp，缺了就等于整份产物没有图片能力。
    // 只约束 npm 发布路径：源码路径按上游 tag 原样构建，既没有补丁也没有 wasm 包。
    if (file === 'release.yml') {
      assert.ok(asarStep.includes('check-asar-sharp-wasm.mjs --asar="$asar"'), `${file}: asar must be checked for the wasm fallback`)
      assert.ok(asarStep.includes('ubuntu-*) wasm_flag=--require-wasm=true'), `${file}: Linux artifacts must require the wasm package`)
      assert.ok(asarStep.includes('*) wasm_flag=--require-wasm=false'), `${file}: non-Linux artifacts must only require the sharp patch`)
    } else {
      assert.ok(!asarStep.includes('check-asar-sharp-wasm.mjs'), `${file}: source artifacts carry no wasm fallback and must not be checked for it`)
    }
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

test('the source build deploys without failing on patches that do not apply', () => {
  const source = read('.github/workflows/release-from-source.yml')
  // 生产闭包不装上游根 workspace 的 devDependencies，它们的 patchedDependencies
  // 匹配不到包；pnpm 11 把未使用的补丁当硬错误（run 43027685338）。
  const deploy = source.slice(source.indexOf('- name: Deploy complete upstream runtime closure'), source.indexOf('- name: Replace deploy-time package links'))
  assert.match(deploy, /pnpm deploy --filter dsh-python-runtime-closure --prod --legacy/, 'closure deploy must stay a prod deploy')
  assert.ok(deploy.includes('--config.allow-unused-patches=true'), 'the deploy must allow unused patches, as upstream does')
  // 例外只给 deploy：克隆下来的 workspace 里不许全局放宽，安装仍要拒绝未使用的补丁。
  const layout = source.slice(source.indexOf('- name: Configure shippable upstream node_modules layout'), source.indexOf('- name: Install upstream dependencies'))
  assert.ok(!layout.includes('allowUnusedPatches'), 'the cloned workspace must keep rejecting unused patches on install')
})

test('the source build replaces deploy-time links before zipping', () => {
  const source = read('.github/workflows/release-from-source.yml')
  // zip -r 会跟随目录链接：循环 workspace 依赖（cordis <-> cordis-plugin-include）
  // 会无限展开（run 43066852450 扫了 88 秒也没产出 zip）。
  const materialize = source.indexOf('- name: Replace deploy-time package links with real files')
  const deploy = source.indexOf('- name: Deploy complete upstream runtime closure')
  const archive = source.indexOf('- name: Create archive')
  assert.ok(materialize > deploy, 'links must be materialized right after the deploy')
  assert.ok(materialize < archive, 'links must be materialized before the ZIP')
  const step = source.slice(materialize, source.indexOf('- name:', materialize + 10))
  // 脚本在本仓库的 scripts/ 下，而这一步的 cwd 是 upstream/build_dir：
  // 写成 ../../scripts/ 之外的形式会找不到模块（run 43073294933）。
  assert.ok(step.includes('working-directory: upstream/build_dir'), 'the materialize step must run from the deployed tree')
  assert.ok(step.includes('node ../../scripts/materialize-deploy-links.mjs --dir=.'), 'materialize must resolve the script from the deployed tree')
  // npm 发布路径同样在打包前清掉可能残留的链接。
  const npmPath = read('.github/workflows/release.yml')
  const npmMaterialize = npmPath.indexOf('- name: Replace deploy-time package links with real files')
  assert.ok(npmMaterialize > npmPath.indexOf('- name: Deploy package'), 'the npm path must materialize links after its deploy')
  assert.ok(npmMaterialize < npmPath.indexOf('- name: Create archive'), 'the npm path must materialize links before zipping')
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

test('the sync workflow rebuilds when packaging content changed even if the npm version did not', () => {
  const source = read('.github/workflows/sync-release.yml')
  // 只认 npm 版本的话，发布之后才合进 main 的核心补丁就再也发不出去。
  assert.ok(source.includes('- name: Detect packaging changes'), 'sync must compare packaging content against the last release')
  assert.ok(source.includes('git log --format='), 'packaging changes must be collected per commit')
  assert.ok(source.includes('patches scripts pnpm-workspace.yaml .github/workflows package.json pnpm-lock.yaml'), 'lockfile changes must count as packaging changes')
  assert.ok(source.includes('chore: sync version to '), 'the post-release version commit must be filtered out, otherwise every run rebuilds')
  assert.ok(source.includes('steps.packaging.outputs.changed') && source.includes('= "true" ]'), 'packaging changes must trigger a rebuild')
  // 比对需要能取到上一次的发布提交。
  assert.match(source, /fetch-depth: 0/)
  // 查不到上一次发布或解析失败时必须失败，不能静默当成没变化。
  assert.ok(source.includes('解析 ${last_tag} 对应的提交失败') && source.includes('exit 1'), 'tag resolution failures must fail the step')
})

test('the release tag points at the commit that was built', () => {
  const source = read('.github/workflows/release.yml')
  const step = source.slice(source.indexOf('- name: Create release'), source.indexOf('- name: Upload assets one by one with retry'))
  // 不指定 --target 时 tag 落在「创建那一刻」的默认分支 HEAD；构建期间 main
  // 前进了的话，tag 会指到没进产物的提交，后续的打包内容比对就失真了。
  assert.ok(step.includes('gh release create "$TAG"'), 'release must be created by the CLI')
  assert.ok(step.includes('--target "$GITHUB_SHA"'), 'the tag must point at the built commit')
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

#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// ponytail: only the pinned npm layout is adapted; revalidate transforms before supporting another core version.
const supportedVersion = '0.2.1-alpha.4'
const runtimeKey = 'globalThis[Symbol.for("dsh.pkg.bun.runtime")]'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const deployRoot = realpathSync(resolve(process.argv[2] ?? 'build_dir'))
const coreRoot = realpathSync(join(deployRoot, 'node_modules/@deepseek-ai/dsh'))
const within = (root, file) => file === root || file.startsWith(root + sep)
if (deployRoot === realpathSync(projectRoot) || !within(deployRoot, coreRoot)) {
  throw new Error('Compile a separate deployed directory, not the working installation or linked dependencies')
}
const coreManifest = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'))
if (coreManifest.name !== '@deepseek-ai/dsh' || coreManifest.version !== supportedVersion) {
  throw new Error(`Bun adaptation requires @deepseek-ai/dsh@${supportedVersion}; received ${coreManifest.name}@${coreManifest.version}`)
}
const bin = join(coreRoot, 'lib/bin.js')
const appBoot = realpathSync(Bun.resolveSync('@deepseek-ai/dsh-app-boot', coreRoot))
const ptcRuntime = realpathSync(Bun.resolveSync('@deepseek-ai/dsh-ptc-runtime-node', coreRoot))
if (![realpathSync(bin), appBoot, ptcRuntime].every(file => within(deployRoot, file)) || lstatSync(bin).isSymbolicLink()) throw new Error('Core files must belong to the deployment')
const executable = join(coreRoot, `dsh-core${process.platform === 'win32' ? '.exe' : ''}`)
if (existsSync(executable)) throw new Error('This deployment is already compiled; deploy a fresh copy before rebuilding')

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Unsupported core layout: ${before}`)
  return source.replace(before, after)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-bun-build-'))
const temporaryExecutable = join(scratch, `dsh-core${process.platform === 'win32' ? '.exe' : ''}`)
const entry = join(scratch, 'entry.mjs')
const libraryEntry = join(scratch, 'library.mjs')
const library = join(scratch, 'core.cjs')
const runtimeSource = fileURLToPath(new URL('./bun-runtime.mjs', import.meta.url))
const nodeModuleSource = fileURLToPath(new URL('./bun-node-module.mjs', import.meta.url))
const loaderFile = Bun.resolveSync('@deepseek-ai/cordis-plugin-loader', coreRoot)
const diskSpecifier = file => `dsh-pkg:${relative(coreRoot, file).split(sep).join('/')}`
const shim = join(coreRoot, 'lib/.bin-bun-launcher.js')
let promoted = false
try {
  writeFileSync(libraryEntry, `export * as appBoot from ${JSON.stringify(appBoot)}; export * as ptcRuntime from ${JSON.stringify(ptcRuntime)}; export { runCli } from ${JSON.stringify(bin)};`)
  writeFileSync(entry, `
import { dirname, isAbsolute, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installBunRuntime } from ${JSON.stringify(runtimeSource)}
const coreRoot = dirname(process.execPath)
const node = process.env.DSH_NODE ?? Bun.which('node')
if (!node || !isAbsolute(node) || !existsSync(node) || realpathSync(node) === realpathSync(process.execPath)) {
  throw new Error('The compiled core requires a real external Node executable in DSH_NODE or PATH')
}
// Upstream runners, PTC and package-manager children still execute Node scripts.
process.execPath = node
process.argv[0] = node
process.argv[1] = join(coreRoot, 'lib/bin.js')
const runtime = installBunRuntime(coreRoot)
const { ModuleLoader } = await runtime.esm.import(runtime.moduleUrl(${JSON.stringify(relative(coreRoot, loaderFile).split(sep).join('/'))}))
ModuleLoader.fromInternal = () => runtime.esm
const { appBoot, ptcRuntime, runCli } = require(${JSON.stringify(library)})
runtime.registerEmbedded(fileURLToPath(runtime.moduleUrl(${JSON.stringify(relative(coreRoot, appBoot).split(sep).join('/'))})), appBoot)
runtime.registerEmbedded(fileURLToPath(runtime.moduleUrl(${JSON.stringify(relative(coreRoot, ptcRuntime).split(sep).join('/'))})), ptcRuntime)
await runCli()
`)
  const bundled = new Set()
  const bundledCore = await Bun.build({
    entrypoints: [libraryEntry], target: 'node', format: 'cjs',
    write: false,
    plugins: [{ name: 'relocatable-dsh-core', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.importer || args.path.startsWith('dsh-pkg:')) return args.path.startsWith('dsh-pkg:') ? { path: args.path, external: true } : undefined
        const resolved = Bun.resolveSync(args.path, dirname(args.importer))
        if (within(coreRoot, resolved) || [appBoot, ptcRuntime, nodeModuleSource].includes(resolved)) return { path: resolved }
        if (!isAbsolute(resolved)) return { path: args.path, external: true }
        if (!within(deployRoot, realpathSync(resolved))) throw new Error(`Dependency escapes deployment: ${resolved}`)
        return { path: diskSpecifier(resolved), external: true }
      })
      build.onLoad({ filter: /\.[cm]?js$/ }, args => {
        if (!within(coreRoot, args.path) && ![appBoot, ptcRuntime].includes(args.path)) return
        let source = readFileSync(args.path, 'utf8')
        bundled.add(relative(coreRoot, args.path))
        if (args.path === appBoot) {
          const start = source.indexOf('function internalModules() {')
          const end = source.indexOf('\n}\n', start) + 3
          if (start < 0 || end <= start) throw new Error('Unsupported core layout: internalModules')
          source = source.slice(0, start) + `function internalModules() { return ${runtimeKey}.internalModules(); }\n` + source.slice(end)
          source = replaceOnce(source,
            'const router = new ResolutionRouter(resolution, (directory) => cjs._nodeModulePaths(directory));',
            `const router = new ResolutionRouter(resolution, (directory) => cjs._nodeModulePaths(directory));\n${runtimeKey}.setRouter(router);`)
          source = replaceOnce(source, '\t\t\trestoreEsm();', `\t\t\trestoreEsm();\n${runtimeKey}.setRouter(undefined);`)
        }
        if (args.path === ptcRuntime) source = replaceOnce(source,
          'import { stripTypeScriptTypes } from "node:module";',
          `import { stripTypeScriptTypes } from ${JSON.stringify(nodeModuleSource)};`)
        if (args.path === bin) source = replaceOnce(source, 'if (import.meta.main) await runCli();', '')
        const diskRelative = relative(coreRoot, args.path).split(sep).join('/')
        source = source.replaceAll('import.meta.url', `${runtimeKey}.moduleUrl(${JSON.stringify(diskRelative)})`)
        return { contents: source, loader: 'js' }
      })
    } }],
  })
  if (!bundledCore.success || bundledCore.outputs.length !== 1) throw new AggregateError(bundledCore.logs, 'Bun core bundling failed')
  writeFileSync(library, await bundledCore.outputs[0].text())
  // A lazy CommonJS boundary lets the runtime register hooks before external imports are linked.
  const result = await Bun.build({
    entrypoints: [entry], target: 'bun', format: 'esm', external: ['dsh-pkg:*'],
    compile: { outfile: temporaryExecutable, autoloadDotenv: false, autoloadBunfig: false, autoloadPackageJson: true },
  })
  if (!result.success) throw new AggregateError(result.logs, 'Bun core compilation failed')
  // Keep the real JS entry intact until both compilation and version execution succeed.
  copyFileSync(temporaryExecutable, executable)
  const smoke = spawnSync(executable, ['--version'], { encoding: 'utf8', env: { ...process.env, DSH_NODE: process.env.DSH_NODE || Bun.which('node') }, timeout: 30000 })
  if (smoke.error || smoke.status !== 0 || smoke.stdout.trim() !== supportedVersion) {
    throw new Error(`Compiled core version check failed: ${smoke.error?.message ?? smoke.stderr ?? smoke.stdout}`)
  }
  copyFileSync(new URL('./bun-launcher.mjs', import.meta.url), shim)
  chmodSync(shim, statSync(bin).mode)
  renameSync(shim, bin)
  promoted = true
  console.log(`Compiled ${bundled.size} core modules; preserved disk plugins, resources, native modules and Node workers: ${executable}`)
} finally {
  if (!promoted) rmSync(executable, { force: true })
  rmSync(shim, { force: true })
  rmSync(scratch, { recursive: true, force: true })
}

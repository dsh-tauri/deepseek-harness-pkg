import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installBunRuntime } from './bun-runtime.mjs'

test('Bun native adapter runs the pinned upstream profile router', { skip: !process.versions.bun }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-bun-runtime-'))
  const originalFilename = Module._resolveFilename
  let interception
  try {
    const put = (name, contents) => {
      const file = join(scratch, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, contents)
      return file
    }
    const dual = (directory, branch) => {
      put(`${directory}/package.json`, JSON.stringify({ name: 'runtime-dual', exports: { import: './esm.mjs', require: './cjs.cjs' } }))
      put(`${directory}/esm.mjs`, `export const branch = '${branch}-import'; export const token = {};`)
      put(`${directory}/cjs.cjs`, `module.exports = { branch: '${branch}-require', token: {} };`)
    }
    const core = join(scratch, 'install/node_modules/@deepseek-ai/dsh')
    put('install/node_modules/@deepseek-ai/dsh/package.json', '{"type":"module"}')
    put('install/package.json', '{}')
    put('profiles/active/package.json', '{}')
    dual('install/node_modules/runtime-dual', 'fallback')
    dual('profiles/active/node_modules/local/node_modules/runtime-dual', 'local')
    const sharedImport = { branch: 'embedded-import', token: {} }
    const sharedRequire = { branch: 'embedded-require', token: {} }
    const importFile = join(scratch, 'install/node_modules/runtime-dual/esm.mjs')
    const requireFile = join(scratch, 'install/node_modules/runtime-dual/cjs.cjs')
    const runtime = installBunRuntime(core, new Map([[importFile, sharedImport]]))
    runtime.registerEmbedded(requireFile, sharedRequire)
    assert.equal(globalThis[Symbol.for('dsh.pkg.bun.runtime')], runtime)
    assert.equal(runtime.esm.version, 'v1')
    assert.equal(runtime.internalModules().cjs, Module)
    assert.equal(runtime.internalModules().modern, false)
    assert.throws(() => runtime.registerEmbedded('runtime-dual', {}), /absolute resolved disk path/)
    const installedEntry = put('install/node_modules/installed/entry.mjs', `export { token } from 'runtime-dual';`)
    assert.equal((await runtime.esm.import(pathToFileURL(installedEntry).href, undefined, {})).token, sharedImport.token)

    // Execute the real pinned resolver/interception body, replacing only its Node-internals provider.
    const appBootFile = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
    assert.equal(JSON.parse(readFileSync(join(dirname(appBootFile), '../package.json'), 'utf8')).version, '0.2.1-alpha.4')
    const upstream = readFileSync(appBootFile, 'utf8')
    const start = upstream.indexOf('const WORKER_RESOLUTION_KEY = ')
    const end = upstream.indexOf('//#endregion', start)
    let resolver = upstream.slice(start, end)
    const internalsStart = resolver.indexOf('function internalModules() {')
    const internalsEnd = resolver.indexOf('\n}\n', internalsStart) + 3
    assert(start > 0 && end > start && internalsStart > 0 && internalsEnd > internalsStart)
    resolver = resolver.slice(0, internalsStart) + 'function internalModules() { return globalThis[Symbol.for("dsh.pkg.bun.runtime")].internalModules(); }\n' + resolver.slice(internalsEnd)
    const exportsFile = fileURLToPath(import.meta.resolve('resolve.exports'))
    const routerFile = put('router.mjs', `
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { imports } from ${JSON.stringify(pathToFileURL(exportsFile).href)};
${resolver}
export { ResolutionRouter, installRuntimeInterception };
`)
    const { ResolutionRouter, installRuntimeInterception } = await import(pathToFileURL(routerFile).href)
    const resolution = {
      entries: [{ name: 'runtime-dual', packageDir: dirname(importFile), declarer: join(scratch, 'install/package.json'), scope: 'installation', version: '1' }],
      profilesDir: join(scratch, 'profiles'), profileDir: join(scratch, 'profiles/active'), linkedRoots: [], localPackageNames: [],
    }
    interception = installRuntimeInterception(resolution)
    runtime.setRouter(new ResolutionRouter(resolution, directory => Module._nodeModulePaths(directory)))

    for (const name of ['fallback', 'local']) {
      const plugin = `profiles/active/node_modules/${name}`
      put(`${plugin}/package.json`, JSON.stringify({ type: 'module', imports: { '#dual': 'runtime-dual', '#relative': './leaf.mjs' } }))
      put(`${plugin}/leaf.mjs`, 'export const token = {}; export const url = import.meta.url;')
      put(`${plugin}/mid.js`, `
import * as selected from 'runtime-dual';
import * as alias from '#dual';
import { token as relativeToken } from '#relative';
import { readFileSync } from 'node:fs';
export { token as reexported } from 'runtime-dual';
export { selected, alias, relativeToken, readFileSync };
export const dynamic = () => import('runtime-dual');
export const required = () => require('runtime-dual');
`)
      const entry = put(`${plugin}/entry.mjs`, `export * from './mid.js';`)
      const actual = await runtime.esm.import(pathToFileURL(entry).href, runtime.moduleUrl('package.json'), {})
      const expected = name === 'fallback' ? sharedImport : await import(pathToFileURL(join(scratch, plugin, 'node_modules/runtime-dual/esm.mjs')).href)
      assert.equal(actual.selected.token, expected.token)
      assert.equal(actual.alias.token, expected.token)
      assert.equal(actual.reexported, expected.token)
      assert.equal((await actual.dynamic()).token, expected.token)
      assert.equal(actual.required().branch, name === 'fallback' ? sharedRequire.branch : 'local-require')
      if (name === 'fallback') assert.equal(actual.required().token, sharedRequire.token)
      assert.equal(typeof actual.readFileSync, 'function')
      const cjs = put(`${plugin}/entry.cjs`, `module.exports = { selected: require('runtime-dual'), alias: require('#dual') };`)
      const required = createRequire(pathToFileURL(cjs))(cjs)
      assert(required.selected, `CommonJS exports changed: ${JSON.stringify(required)}`)
      assert.equal(required.selected.branch, name === 'fallback' ? sharedRequire.branch : 'local-require')
      assert.equal(required.alias.branch, required.selected.branch)
      if (name === 'fallback') assert.equal(required.selected.token, sharedRequire.token)
      const parent = pathToFileURL(entry).href
      const firstUrl = new URL('./leaf.mjs?first#one', parent).href
      const secondUrl = new URL('./leaf.mjs?second#two', parent).href
      assert.equal(runtime.esm.resolveSync('./leaf.mjs?first#one', parent, {}).url, firstUrl)
      const first = await runtime.esm.import(firstUrl, parent, {})
      const second = await runtime.esm.import(secondUrl, parent, {})
      assert.equal(first.url, firstUrl)
      assert.equal(second.url, secondUrl)
      assert.notEqual(first.token, second.token)
    }
    const embeddedRelative = relative(core, importFile).split(sep).join('/')
    assert.equal((await runtime.esm.import(`dsh-pkg:${embeddedRelative}`, undefined, {})).token, sharedImport.token)
    assert.equal(createRequire(import.meta.url)(`dsh-pkg:${relative(core, requireFile).split(sep).join('/')}`).token, sharedRequire.token)
    assert.equal(runtime.moduleUrl(embeddedRelative), pathToFileURL(importFile).href)
    const nativeRequire = createRequire(import.meta.url)
    const koffiFile = nativeRequire.resolve('koffi')
    assert.equal(typeof nativeRequire(koffiFile).load, 'function')
  } finally {
    interception?.dispose()
    Module._resolveFilename = originalFilename
    rmSync(scratch, { recursive: true, force: true })
  }
})

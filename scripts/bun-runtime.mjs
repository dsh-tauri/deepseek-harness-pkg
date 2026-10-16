import { readFileSync } from 'node:fs'
import { createRequire, isBuiltin, Module } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtimeKey = Symbol.for('dsh.pkg.bun.runtime')
const embeddedNamespace = 'dsh-pkg-embedded'
const urlNamespace = 'dsh-pkg-url'
const diskPrefix = 'dsh-pkg:'

function builtin(request) {
  return isBuiltin(request) || request === 'bun' || request.startsWith('bun:')
}

function moduleFormat(filename) {
  switch (extname(filename)) {
    case '.mjs': return 'module'
    case '.cjs': return 'commonjs'
    case '.json': return 'json'
    case '.node': return 'addon'
    case '.js': {
      for (let directory = dirname(filename); ; directory = dirname(directory)) {
        try {
          return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).type === 'module' ? 'module' : 'commonjs'
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        }
        if (basename(directory) === 'node_modules' || dirname(directory) === directory) return 'commonjs'
      }
    }
    default: return undefined
  }
}

/** Bun mechanics for the pinned upstream router; package selection remains upstream's job. */
export function installBunRuntime(installationRoot, embeddedModules = new Map()) {
  if (!globalThis.Bun?.plugin || !Bun.build || !Bun.resolveSync) throw new Error('The compiled DSH runtime requires Bun')
  if (typeof installationRoot !== 'string' || !isAbsolute(installationRoot)) throw new TypeError('installationRoot must be an absolute DSH package directory')
  if (!(embeddedModules instanceof Map)) throw new TypeError('embeddedModules must be a Map of absolute disk paths to exports')
  if (globalThis[runtimeKey]) throw new Error('The compiled DSH runtime is already installed')

  const root = resolve(installationRoot)
  const embedded = new Map()
  const nativeFilename = Module._resolveFilename
  const hookedFiles = new Set()
  let router

  function moduleUrl(relative) {
    return pathToFileURL(resolve(root, relative)).href
  }

  function registerEmbedded(filename, exports) {
    if (typeof filename !== 'string' || !isAbsolute(filename)) throw new TypeError('An embedded module must name an absolute resolved disk path')
    if (exports === null || typeof exports !== 'object') throw new TypeError('An embedded module must provide its exports namespace')
    const resolved = resolve(filename)
    embedded.set(resolved, exports)
    // Bun's require honors Module._cache after upstream selects the final disk path.
    const cached = new Module(resolved)
    cached.filename = resolved
    cached.loaded = true
    cached.exports = exports
    Module._cache[resolved] = cached
    const filter = new RegExp(`^${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    Bun.plugin({ name: 'dsh-embedded-module', setup(build) {
      build.onLoad({ filter, namespace: 'file' }, () => ({ loader: 'object', exports }))
    } })
  }
  for (const [filename, exports] of embeddedModules) registerEmbedded(filename, exports)

  function nativeResolve(request, { parentURL = moduleUrl('package.json'), conditions } = {}) {
    if (builtin(request)) return { url: request === 'bun' || request.includes(':') ? request : `node:${request}`, format: 'builtin' }
    if (request.startsWith('data:')) return { url: new URL(request).href, format: 'module' }
    if (request.startsWith(diskPrefix)) request = moduleUrl(request.slice(diskPrefix.length))

    const directory = dirname(fileURLToPath(parentURL))
    const requestedUrl = request.startsWith('file:') || request.startsWith('./') || request.startsWith('../') ? new URL(request, parentURL) : undefined
    const specifier = requestedUrl ? fileURLToPath(requestedUrl) : request
    let filename
    if (conditions?.includes('require') && !conditions.includes('import')) {
      // defaultResolve is also used by upstream's CommonJS package-#imports path.
      const parent = new Module(fileURLToPath(parentURL))
      parent.filename = fileURLToPath(parentURL)
      parent.paths = Module._nodeModulePaths(directory)
      filename = nativeFilename.call(Module, specifier, parent, false, { conditions: new Set(conditions) })
    } else {
      // Bun ignores import.meta.resolve's second argument; this native API honors the importer.
      filename = Bun.resolveSync(specifier, directory)
    }
    const url = pathToFileURL(filename)
    if (requestedUrl) {
      url.search = requestedUrl.search
      url.hash = requestedUrl.hash
    }
    return { url: url.href, format: moduleFormat(filename) }
  }

  function embeddedId(url) {
    return url.startsWith('file:') && embedded.has(resolve(fileURLToPath(url))) ? encodeURIComponent(url) : undefined
  }

  function externalSpecifier(url) {
    const id = embeddedId(url)
    if (id !== undefined) return `${embeddedNamespace}:${id}`
    if (!url.startsWith('file:')) return url
    const file = new URL(url)
    if ((file.search || file.hash) && moduleFormat(fileURLToPath(file)) === 'module') return `${urlNamespace}:${encodeURIComponent(url)}`
    ensureFileHook(url)
    return fileURLToPath(file).replaceAll('\\', '/')
  }

  const esm = {
    version: 'v1',
    resolveSync(request, parentURL, attributes = {}) {
      return nativeResolve(request, { parentURL, importAttributes: attributes })
    },
    async resolve(request, parentURL, attributes = {}) {
      return nativeResolve(request, { parentURL, importAttributes: attributes })
    },
    async import(request, parentURL, attributes = {}) {
      const { url } = esm.resolveSync(request, parentURL, attributes)
      return import(externalSpecifier(url), { with: attributes })
    },
  }

  async function transform(filename, url = pathToFileURL(filename).href) {
    // ponytail: Bun exposes literal dependency edges here; computed import() needs a native loader hook.
    const result = await Bun.build({
      bundle: true,
      entrypoints: [filename],
      target: 'bun',
      format: 'esm',
      write: false,
      define: { 'import.meta.url': JSON.stringify(url) },
      plugins: [{
        name: 'dsh-profile-imports',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (!args.importer || builtin(args.path)) return
            const url = args.kind === 'require-call' || args.kind === 'require-resolve'
              ? pathToFileURL(createRequire(pathToFileURL(args.importer)).resolve(args.path)).href
              : esm.resolveSync(args.path, pathToFileURL(args.importer).href, args.with ?? {}).url
            return { path: externalSpecifier(url), external: true }
          })
        },
      }],
    })
    if (!result.success) throw new AggregateError(result.logs, `Cannot transform profile module ${filename}`)
    if (result.outputs.length !== 1) throw new Error(`Expected one transformed profile module for ${filename}`)
    return { contents: await result.outputs[0].text(), loader: 'js' }
  }

  function ensureFileHook(url) {
    const filename = resolve(fileURLToPath(url))
    if (embedded.has(filename) || hookedFiles.has(filename) || !router?.hasInterceptionLayerForPath(filename) || moduleFormat(filename) !== 'module') return
    const filter = new RegExp(`^${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    Bun.plugin({
      name: 'dsh-profile-module',
      setup(build) {
        // A broad file hook makes Bun treat CommonJS as ESM, even with untouched bytes.
        build.onLoad({ filter, namespace: 'file' }, () => transform(filename))
      },
    })
    hookedFiles.add(filename)
  }

  Module._resolveFilename = function (request, parent, main, options) {
    const specifier = request.startsWith(diskPrefix) ? fileURLToPath(moduleUrl(request.slice(diskPrefix.length))) : request
    const filename = nativeFilename.call(this, specifier, parent, main, options)
    if (isAbsolute(filename)) ensureFileHook(pathToFileURL(filename).href)
    return filename
  }

  Bun.plugin({
    name: 'dsh-pkg-runtime',
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: urlNamespace }, args => {
        const url = decodeURIComponent(args.path)
        return transform(fileURLToPath(url), url)
      })
      build.onLoad({ filter: /.*/, namespace: embeddedNamespace }, args => {
        const exports = embedded.get(resolve(fileURLToPath(decodeURIComponent(args.path))))
        if (exports === undefined) throw new Error(`Unregistered embedded module ${args.path}`)
        return { loader: 'object', exports }
      })
    },
  })

  const runtime = {
    esm,
    moduleUrl,
    registerEmbedded,
    setRouter(value) { router = value },
    internalModules() {
      return {
        esm,
        esmDefaultResolve: nativeResolve,
        esmConditions: ['node', 'import', 'node-addons'],
        cjs: Module,
        cjsConditions: new Set(['node', 'require', 'node-addons']),
        modern: false,
      }
    },
  }
  globalThis[runtimeKey] = runtime
  return runtime
}

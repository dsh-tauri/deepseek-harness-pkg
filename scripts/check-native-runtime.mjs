import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { inspect } from 'node:util'

const requireRuntime = createRequire(resolve(process.argv[2] || 'build_dir', 'package.json'))
try {
  const addon = requireRuntime('node-addon-require-builtin')
  const loader = addon.requireBuiltin('internal/modules/esm/loader')
  assert.equal(typeof loader.getOrInitializeCascadedLoader, 'function')
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, binding: addon.getBindingInfo() }))
} catch (error) {
  console.error(inspect(error, { depth: null }))
  process.exitCode = 1
}

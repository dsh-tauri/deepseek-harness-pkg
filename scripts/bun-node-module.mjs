import { spawnSync } from 'node:child_process'

const script = `
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
try {
  const { code, options } = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(JSON.stringify({ result: stripTypeScriptTypes(code, options) }))
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { name: error.name, message: error.message, code: error.code } }))
  process.exitCode = 1
}
`

// ponytail: PTC supplies JSON-compatible source/options; extend serialization only for non-JSON callers.
export function stripTypeScriptTypes(code, options) {
  // PTC slices a fixed 35-character wrapper prefix; a transpiler cannot replace Node's whitespace-preserving strip.
  const child = spawnSync(process.env.DSH_NODE || process.execPath, [
    '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script,
  ], {
    input: JSON.stringify({ code, options }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  })
  // Never include stdout, stderr, or input in bridge diagnostics: they can contain program text or secrets.
  const failure = new Error(`External Node TypeScript stripping failed (${child.error?.code ?? child.signal ?? `exit ${child.status}`}); set DSH_NODE to a Node executable with node:module.stripTypeScriptTypes`)
  if (child.error) {
    if (child.error.code !== undefined) failure.code = child.error.code
    throw failure
  }
  let response
  try {
    response = JSON.parse(child.stdout)
  } catch {
    throw failure
  }
  const error = response?.error
  if (child.status !== 0 && error && typeof error.name === 'string' && typeof error.message === 'string'
    && (error.code === undefined || typeof error.code === 'string')) {
    const ErrorType = { __proto__: null, Error, TypeError, SyntaxError, RangeError }[error.name] ?? Error
    const exception = new ErrorType(error.message)
    exception.name = error.name
    if (error.code !== undefined) exception.code = error.code
    throw exception
  }
  if (child.status !== 0 || typeof response?.result !== 'string') throw failure
  return response.result
}

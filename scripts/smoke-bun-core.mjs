#!/usr/bin/env node
// Usage: node scripts/smoke-bun-core.mjs <deployRoot> (original Node entry or optional compiled shim).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const redact = text => String(text).replace(/https?:\/\/[^\s<>"']+/g, '[URL redacted]').replace(/(token["'\s:=]+)[A-Za-z0-9_.-]+/gi, '$1[redacted]')
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
const bounded = async (promise, ms, label) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })])
  } finally { clearTimeout(timer) }
}

async function main() {
  assert.equal(process.argv.length, 3, 'usage: node scripts/smoke-bun-core.mjs <deployRoot>')
  const deploy = resolve(process.argv[2])
  const cli = join(deploy, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const manifest = JSON.parse(await readFile(join(deploy, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  assert.equal(manifest.version, '0.2.1-alpha.4', 'this smoke pins the alpha4 CLI contract')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-core-smoke-'))
  const home = join(temp, 'home')
  const cwd = join(temp, 'cwd')
  const profile = join(home, 'profiles/web')
  const readyFile = join(temp, 'ready.json')
  const pidFile = join(temp, 'pid.json')
  const stopFile = join(temp, 'stop')
  const events = join(temp, 'events')
  const env = { ...process.env }
  // Do not inherit the running GUI's profile, runtime, credentials, proxy, or loader hooks.
  for (const key of Object.keys(env)) if (/^(DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$|NODE_PATH$|BUN_OPTIONS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)) delete env[key]
  Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', HOME: home, USERPROFILE: home, NO_COLOR: '1' })
  const children = []
  const startupDeadline = Date.now() + 55000
  let output = ''
  let origin
  let runtimePid
  let failure
  const launch = args => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    const item = { child, done: false, text: '' }
    item.closed = new Promise(resolve => {
      child.once('error', error => { item.error = error })
      child.once('close', (code, signal) => { item.done = true; resolve({ code, signal }) })
    })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      item.text = (item.text + chunk).slice(-65536)
      output = (output + chunk).slice(-65536)
    })
    children.push(item)
    return item
  }
  const waitFor = async (check, item, label) => {
    while (Date.now() < startupDeadline) {
      if (item.error) throw item.error
      if (item.done) throw new Error(`${label}: CLI exited early (${JSON.stringify(await item.closed)})`)
      const value = await check()
      if (value) return value
      await delay(50)
    }
    throw new Error(`${label}: startup exceeded 55s`)
  }
  const request = (url, options = {}) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(10000, startupDeadline - Date.now()))) })
  const killTree = async pid => {
    if (!alive(pid)) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await bounded(new Promise((resolve, reject) => { killer.once('error', reject); killer.once('close', resolve) }), 10000, 'taskkill')
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error; if (alive(pid)) process.kill(pid, 'SIGKILL') }
    }
  }
  try {
    await mkdir(profile, { recursive: true })
    await mkdir(cwd)
    const version = launch(['--version'])
    assert.deepEqual(await bounded(version.closed, 15000, 'CLI version'), { code: 0, signal: null })
    assert.equal(version.text.trim(), manifest.version, 'actual CLI version')
    console.log(`PASS CLI --version: ${manifest.version}`)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
    const config = { deploy, node: process.execPath, cwd, readyFile, pidFile, stopFile, events, proof: 'profile-composed' }
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'smoke-esm', name: './smoke.mjs', config },
      { id: 'smoke-cjs', name: './smoke.cjs', config },
    ] }]))
    await writeFile(join(profile, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
export const name = 'smoke-esm'
export const inject = ['profileContext']
export function apply(ctx, config) {
  assert.equal(config.proof, 'profile-composed')
  assert.equal(ctx.profileContext.name, 'web')
  ctx.provide('smokeEsm', { proof: config.proof, pid: process.pid })
  ctx.effect(() => () => appendFileSync(config.events, 'esm-disposed\\n'), 'smoke ESM disposal')
}
`)
    await writeFile(join(profile, 'smoke.cjs'), `
const assert = require('node:assert/strict')
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
exports.name = 'smoke-cjs'
exports.inject = ['smokeEsm', 'ptcRuntime', 'appReady', 'profileContext']
exports.apply = async (ctx, config) => {
  assert.equal(ctx.smokeEsm.proof, config.proof)
  assert.equal(ctx.smokeEsm.pid, process.pid)
  writeFileSync(config.pidFile, JSON.stringify({ pid: process.pid }))
  const at = name => createRequire(join(config.deploy, 'node_modules', name, 'package.json'))
  const koffi = at('@deepseek-ai/dsh-fs-local')('koffi')
  const lib = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const pid = process.platform === 'win32' ? lib.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])() : lib.func('int getpid()')()
    assert.equal(pid, process.pid, 'koffi native call')
  } finally { lib.unload() }
  const sharp = at('@deepseek-ai/dsh-attachment-local')('sharp')
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#123456' } }).png().toBuffer()
  const metadata = await sharp(png).metadata()
  assert.equal(metadata.width, 2)
  assert.equal(metadata.height, 3)
  assert.equal(metadata.format, 'png')
  const pty = at('@deepseek-ai/dsh-subprocess-local')('node-pty')
  const terminal = pty.spawn(config.node, ['-e', 'process.stdout.write("DSH_PTY_OK");process.exit(0)'], { name: 'xterm', cols: 80, rows: 24, cwd: config.cwd, env: { ...process.env } })
  let text = '', ptyExited = false
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('node-pty child timed out')), 10000)
      terminal.onData(data => { text += data })
      terminal.onExit(exit => { ptyExited = true; clearTimeout(timeout); setTimeout(() => resolve(exit), 50) })
    })
    assert.equal(result.exitCode, 0, 'node-pty child exit')
    assert.ok(text.includes('DSH_PTY_OK'), 'node-pty output')
  } finally { if (!ptyExited) terminal.kill() }
  const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
    cwd: config.cwd, timeoutMs: 10000,
    program: 'const n: number = await tools.double({n: 21}); console.log("DSH_PTC_OK"); return { n, pid: process.pid, node: process.versions.node, bun: !!process.versions.bun };',
    bindings: [{ global: 'tools', functions: { double: async args => args.n * 2 } }],
  }))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.equal(result.value.n, 42, 'PTC TypeScript + host binding')
  assert.equal(result.value.bun, false, 'PTC remains a real Node worker')
  assert.ok(result.value.node)
  assert.ok(result.logs.includes('DSH_PTC_OK'), 'PTC logs')
  const proof = { pid: process.pid, ptyPid: terminal.pid, ptcPid: result.value.pid, esm: true, cjs: true, koffi: true, sharp: true, pty: true, ptc: true }
  ctx.effect(() => {
    const cancel = ctx.appReady.onReady(() => writeFileSync(config.readyFile, JSON.stringify(proof)))
    // Windows child.kill(SIGTERM) bypasses JS teardown; trigger the real CLI handler in-process.
    const timer = setInterval(() => { if (existsSync(config.stopFile)) { clearInterval(timer); process.emit('SIGTERM') } }, 50)
    return () => { clearInterval(timer); cancel(); appendFileSync(config.events, 'cjs-disposed\\n') }
  }, 'smoke CJS disposal')
}
`)
    const web = launch(['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
    const urlText = await waitFor(() => /dsh web:\s*(http:\/\/[^\s]+)/.exec(web.text)?.[1], web, 'authenticated web startup')
    const url = new URL(urlText)
    assert.equal(url.hostname, '127.0.0.1')
    assert.ok(Number(url.port) > 0 && url.port !== '3080', 'isolated non-GUI port')
    assert.ok(url.searchParams.get('token'), 'startup URL contains authentication token')
    origin = url.origin
    const unauthorized = await request(origin)
    assert.equal(unauthorized.status, 401, 'unauthenticated HTML must be rejected')
    await unauthorized.arrayBuffer()
    const auth = await request(url)
    assert.equal(auth.status, 303, 'launch token must exchange for browser session')
    assert.equal(auth.headers.get('location'), './')
    const setCookie = auth.headers.get('set-cookie')
    assert.ok(setCookie && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'secure session-cookie attributes')
    await auth.arrayBuffer()
    const headers = { cookie: setCookie.split(';')[0] }
    const page = await request(origin, { headers })
    assert.equal(page.status, 200, 'authenticated HTML')
    assert.match(page.headers.get('content-type') ?? '', /text\/html/i)
    const html = await page.text()
    assert.match(html, /__DSH_BOOT__/)
    const assetPath = /<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/i.exec(html)?.[1]
    assert.ok(assetPath, 'real HTML must reference a client JS asset')
    const assetUrl = new URL(assetPath.replaceAll('&amp;', '&'), origin)
    assert.equal(assetUrl.origin, origin, 'client asset is served by this deployment')
    const asset = await request(assetUrl, { headers })
    assert.equal(asset.status, 200, 'referenced client JS asset')
    assert.match(asset.headers.get('content-type') ?? '', /(?:java|ecma)script/i)
    const js = await asset.text()
    assert.ok(js.length > 100 && !/^\s*</.test(js), 'asset is real JS, not SPA HTML fallback')
    console.log(`PASS authenticated HTML + referenced JS asset (${js.length} chars)`)
    const proof = await waitFor(async () => existsSync(readyFile) && JSON.parse(await readFile(readyFile, 'utf8')), web, 'composed ESM/CJS + native/PTC checks')
    runtimePid = proof.pid
    for (const key of ['esm', 'cjs', 'koffi', 'sharp', 'pty', 'ptc']) assert.equal(proof[key], true, key)
    assert.equal(alive(proof.ptyPid), false, 'PTY child exited')
    assert.equal(alive(proof.ptcPid), false, 'PTC Node child exited')
    assert.equal(alive(runtimePid), true, 'runtime alive before requested shutdown')
    console.log('PASS composed disk ESM/CJS plugins; koffi/sharp/node-pty; PTC TypeScript + binding + Node worker exit')
    await writeFile(stopFile, '')
    assert.deepEqual(await bounded(web.closed, 10000, 'CLI SIGTERM handler shutdown'), { code: 0, signal: null })
    assert.equal(alive(runtimePid), false, 'runtime child exited after shutdown')
    const disposed = await readFile(events, 'utf8')
    assert.ok(disposed.includes('esm-disposed\n') && disposed.includes('cjs-disposed\n'), 'both profile plugins disposed')
    const port = createServer()
    try {
      await new Promise((resolve, reject) => { port.once('error', reject); port.listen(Number(url.port), '127.0.0.1', resolve) })
    } finally { if (port.listening) await new Promise((resolve, reject) => port.close(error => error ? reject(error) : resolve())) }
    console.log('PASS graceful CLI/core exit, plugin disposal, child cleanup, and port release')
  } catch (error) {
    failure = new Error(`${error.stack ?? error}\nCLI output (redacted):\n${redact(output)}`)
  } finally {
    const cleanupErrors = []
    try {
      await writeFile(stopFile, '')
      for (const item of children) if (!item.done) {
        try { await bounded(item.closed, 2000, 'cleanup grace') } catch { await killTree(item.child.pid); await bounded(item.closed, 10000, 'forced CLI cleanup') }
      }
      if (!runtimePid && existsSync(pidFile)) runtimePid = JSON.parse(await readFile(pidFile, 'utf8')).pid
      if (runtimePid && alive(runtimePid)) { await killTree(runtimePid); await delay(100); assert.equal(alive(runtimePid), false, 'runtime cleanup') }
    } catch (error) { cleanupErrors.push(error) }
    try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'smoke/cleanup failed')
  }
  if (failure) throw failure
  assert.equal(existsSync(temp), false, 'isolated home and fixtures removed')
  console.log('PASS temp cleanup; not covered: browser/RPC workflows, full terminal service, LLM session, other platforms')
}

main().catch(error => {
  console.error(redact(error.stack ?? error))
  if (error instanceof AggregateError) for (const cause of error.errors) console.error(redact(cause.stack ?? cause))
  process.exitCode = 1
})

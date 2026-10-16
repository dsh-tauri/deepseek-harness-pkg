#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'

const core = fileURLToPath(new URL(`../dsh-core${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
process.env.DSH_NODE ??= process.execPath

function fail(error) {
  console.error(`[dsh] Cannot launch compiled core ${core}: ${error.message}`)
  process.exitCode = 1
}

try {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    accessSync(core, fsConstants.X_OK)
    process.execve(core, [core, ...process.argv.slice(2)], process.env)
  } else {
    // Do not detach: the desktop Windows job owns the child tree and forced kills.
    const child = spawn(core, process.argv.slice(2), { stdio: 'inherit' })
    let escalation
    const handlers = new Map()
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    if (process.platform === 'win32') signals.push('SIGBREAK')
    for (const signal of signals) {
      const forward = () => {
        child.kill(signal === 'SIGBREAK' ? 'SIGTERM' : signal)
        escalation ??= setTimeout(() => child.kill('SIGKILL'), 5000)
      }
      handlers.set(signal, forward)
      process.on(signal, forward)
    }
    const cleanup = () => {
      clearTimeout(escalation)
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    child.once('error', error => {
      cleanup()
      fail(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1)
    })
  }
} catch (error) {
  fail(error)
}

#!/usr/bin/env node
// Linux 上的 Electron 动态链接系统 GLib，把 g_object_* 暴露到进程全局；sharp 预编译的
// libvips 自带静态 GLib 并导出同名符号，于是原生 addon 的 g_object_unref 绑到 Electron
// 那份 glib，在 libuv 工作线程里 SIGSEGV（electron/electron#46323）。产物里的
// dist/sharp.cjs 因此打过补丁：Electron + Linux 先加载 @img/sharp-wasm32，纯 Node 仍走
// 原生二进制。这个脚本在部署目录里真解码一张图，并核对实际加载的是哪一份二进制。
//
// 用法:
//   node scripts/smoke-sharp-electron-linux.mjs --dir=build_dir --expect=native
//     纯 Node：必须命中平台原生包。
//   node scripts/smoke-sharp-electron-linux.mjs --dir=build_dir --electron --expect=wasm
//     伪造 process.versions.electron：必须命中 @img/sharp-wasm32，且不加载原生包。
//   --expect=any 只解码、只报告实际分支，用于源码发布路径（按上游 tag 原样构建，不带补丁）。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const label = '[smoke-sharp-electron-linux]'
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const target = resolve(argValue('dir', 'build_dir'))
const expect = argValue('expect', 'any')
if (!['any', 'native', 'wasm'].includes(expect)) throw new Error(`${label} --expect 只接受 any/native/wasm，收到 ${expect}`)
if (args.includes('--electron')) Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })

// 走产物自己的 node_modules：仓库自身的依赖与部署内容无关。
const requireFromTarget = createRequire(join(target, 'package.json'))
const sharp = requireFromTarget('sharp')

const loaded = Object.keys(requireFromTarget.cache).map(file => file.replaceAll('\\', '/'))
const wasm = loaded.filter(file => file.includes('/@img/sharp-wasm32/'))
const native = loaded.filter(file => /\/@img\/sharp-[a-z0-9-]+\/.*\.node$/.test(file))

const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 12, g: 90, b: 200 } } })
  .png()
  .toBuffer()
const jpeg = await sharp(png).resize(48, 32).jpeg({ quality: 90 }).toBuffer()
const metadata = await sharp(jpeg).metadata()
assert.ok(sharp.versions.vips, `${label} sharp.versions.vips 缺失`)
assert.equal(metadata.format, 'jpeg', `${label} 输出格式异常: ${metadata.format}`)
assert.equal(metadata.width, 48, `${label} 输出宽度异常: ${metadata.width}`)
assert.equal(metadata.height, 32, `${label} 输出高度异常: ${metadata.height}`)

if (expect === 'wasm') {
  assert.ok(wasm.length > 0, `${label} 未加载 @img/sharp-wasm32，加载的是 ${native.join(', ') || '未知二进制'}`)
  assert.equal(native.length, 0, `${label} 仍加载了原生二进制 ${native.join(', ')}`)
} else if (expect === 'native') {
  assert.ok(native.length > 0, `${label} 未加载平台原生二进制`)
  assert.equal(wasm.length, 0, `${label} 意外加载了 @img/sharp-wasm32`)
}

const binary = wasm[0] ?? native[0] ?? '未知'
console.log(`${label} ${expect}: ${binary}, libvips ${sharp.versions.vips}, jpeg ${metadata.width}x${metadata.height} ${jpeg.length}B`)

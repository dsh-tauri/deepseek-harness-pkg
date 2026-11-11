#!/usr/bin/env node
// 校验最终产出的 Electron asar 里带着 Electron+Linux 需要的 sharp WebAssembly 回退。
//
// Linux 上的 Electron 动态链接系统 GLib，把 g_object_* 暴露到进程全局；sharp 预编译的
// libvips 自带静态 GLib 并导出同名符号，原生 addon 的 g_object_unref 绑到 Electron 那份
// glib，在 libuv 工作线程里 SIGSEGV（electron/electron#46323）。产物里的 dist/sharp.cjs
// 因此打过补丁，Electron + Linux 先加载 @img/sharp-wasm32；桌面端的 asar-native.cjs 也
// 只在 asar 内存在 node_modules/@img/sharp-wasm32 时才放行 sharp，否则直接拒绝加载
// （desktop issue #1504 / #1500）。
//
// 只在 build_dir 里跑 smoke 不够：asar pack 是另一步，成品与 build_dir 可能不是同一份
// 内容，历史上就出现过 asar 里少了 wasm 包、而 build_dir 是对的情况。这里直接按 asar
// 的文件头格式读取成品，逐项断言：
//   1. node_modules/sharp 存在，版本与 @img/sharp-wasm32 一致；
//   2. node_modules/sharp/dist/sharp.cjs 带 wasm 短路补丁（分支 + 加载调用都要在）；
//   3. node_modules/@img/sharp-wasm32 的 exports["./sharp.node"] 指向的文件在包里；
//   4. node_modules/@img/sharp-wasm32/lib 下有合法 .wasm（魔数 + 版本号 1）；
//   5. node_modules/@emnapi/runtime 存在（wasm 包的运行时依赖）。
//
// 不依赖 @electron/asar：按文件头格式直接读，零依赖、可离线运行。
//
// 用法:
//   node scripts/check-asar-sharp-wasm.mjs --asar=<产物.asar>
//     要求 asar 内带 wasm 回退（npm 发布路径）。
//   node scripts/check-asar-sharp-wasm.mjs --asar=<产物.asar> --require-wasm=false
//     只检查 sharp 补丁标记，不要求 wasm 包（源码发布路径按上游 tag 原样构建）。
import { closeSync, openSync, readSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATCHES, isPatched } from './core-patches.mjs'

const SHARP_PATCH = PATCHES.find(entry => entry.name === 'sharp')
// 补丁在 dist/sharp.cjs 里插入的那行 wasm 加载调用；只有 if 分支而没有这行调用，
// sharp 仍然拿不到 wasm 副本，等于没打补丁。
const SHARP_WASM_REQUIRE = 'require("@img/sharp-wasm32/sharp.node")'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

export function readArchive(path) {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  readSync(fd, json, 0, jsonSize, 16)
  const header = JSON.parse(json.toString('utf8'))
  const base = 8 + headerSize
  return {
    header,
    read(entry) {
      const buffer = Buffer.alloc(entry.size)
      readSync(fd, buffer, 0, entry.size, base + Number(entry.offset))
      return buffer
    },
    close() {
      closeSync(fd)
    }
  }
}

function resolveExport(exportsField, key) {
  const value = exportsField === undefined || exportsField === null ? undefined : exportsField[key]
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    for (const condition of ['require', 'node', 'default']) {
      if (typeof value[condition] === 'string') return value[condition]
    }
  }
  return undefined
}

function findChild(node, parts) {
  let current = node
  for (const part of parts) {
    if (current === undefined || current === null) return undefined
    const children = current.files !== undefined ? current.files : current
    current = children[part]
  }
  return current
}

function findEntry(node, parts) {
  const current = findChild(node, parts)
  if (current === undefined || current === null) return undefined
  return current.files !== undefined ? undefined : current
}

function findDir(node, parts) {
  const current = findChild(node, parts)
  if (current === undefined || current === null) return undefined
  return current.files !== undefined ? current.files : undefined
}

export function checkAsar(path, { requireWasm = true } = {}) {
  const archive = readArchive(resolve(path))
  const problems = []

  const sharpPackage = findEntry(archive.header, ['node_modules', 'sharp', 'package.json'])
  if (sharpPackage === undefined) {
    problems.push('asar 内缺少 node_modules/sharp/package.json')
  }

  let sharpVersion = null
  if (sharpPackage !== undefined) {
    sharpVersion = JSON.parse(archive.read(sharpPackage).toString('utf8')).version
  }

  const sharpEntry = findEntry(archive.header, ['node_modules', 'sharp', 'dist', 'sharp.cjs'])
  if (sharpEntry === undefined) {
    problems.push('asar 内缺少 node_modules/sharp/dist/sharp.cjs')
  } else {
    const source = archive.read(sharpEntry).toString('utf8')
    // 只查标记不够：标记在、短路分支被删掉或加载调用被改坏，Linux 上照样回退不了。
    if (SHARP_PATCH === undefined || !isPatched(source, SHARP_PATCH)) {
      problems.push('node_modules/sharp/dist/sharp.cjs 没有 Electron+Linux 的 wasm 短路补丁')
    } else if (!source.includes(SHARP_WASM_REQUIRE)) {
      problems.push(`node_modules/sharp/dist/sharp.cjs 的 wasm 短路分支里没有 ${SHARP_WASM_REQUIRE}`)
    }
  }

  let wasmVersion = null
  if (requireWasm) {
    const wasmPackage = findEntry(archive.header, ['node_modules', '@img', 'sharp-wasm32', 'package.json'])
    if (wasmPackage === undefined) {
      problems.push('asar 内缺少 node_modules/@img/sharp-wasm32/package.json')
    } else {
      const manifest = JSON.parse(archive.read(wasmPackage).toString('utf8'))
      wasmVersion = manifest.version
      if (sharpVersion !== null && wasmVersion !== sharpVersion) {
        problems.push(`@img/sharp-wasm32 版本 ${wasmVersion} 与 sharp ${sharpVersion} 不一致`)
      }
      // require("@img/sharp-wasm32/sharp.node") 走 exports，落点是 index.cjs；
      // 打包把 loader 弄丢的话，wasm 包在、二进制在，require 依然失败。
      const loader = resolveExport(manifest.exports, './sharp.node')
      if (loader === undefined) {
        problems.push('@img/sharp-wasm32 的 exports 里没有 "./sharp.node"')
      } else {
        const loaderPath = posix.join('node_modules', '@img', 'sharp-wasm32', loader.replace(/^\.\//, ''))
        if (findEntry(archive.header, loaderPath.split('/')) === undefined) {
          problems.push(`asar 内缺少 @img/sharp-wasm32 的加载入口 ${loaderPath}`)
        }
      }
    }

    const wasmLib = findDir(archive.header, ['node_modules', '@img', 'sharp-wasm32', 'lib'])
    if (wasmLib === undefined) {
      problems.push('asar 内缺少 node_modules/@img/sharp-wasm32/lib')
    } else {
      const binaries = Object.entries(wasmLib).filter(([name]) => name.endsWith('.wasm'))
      if (binaries.length === 0) {
        problems.push('node_modules/@img/sharp-wasm32/lib 下没有 .wasm 文件')
      }
      for (const [name, binary] of binaries) {
        const bytes = archive.read(binary)
        // \0asm 之后 4 字节是版本号，规范目前只有 1。只比值不够：坏的二进制
        // 也能对上魔数，版本号能挡掉明显无效的模块（完整校验要引 validator，不值当）。
        const magic = bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
        const versionOne = magic && bytes.readUInt32LE(4) === 1
        if (!versionOne) {
          problems.push(`node_modules/@img/sharp-wasm32/lib/${name} 不是合法的 wasm 模块`)
        }
      }
    }

    if (findEntry(archive.header, ['node_modules', '@emnapi', 'runtime', 'package.json']) === undefined) {
      problems.push('asar 内缺少 node_modules/@emnapi/runtime（@img/sharp-wasm32 的运行时依赖）')
    }
  }

  archive.close()
  return { problems, sharpVersion, wasmVersion }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const label = '[check-asar-sharp-wasm]'
  const asarPath = argValue('asar', '')
  if (asarPath === '') {
    console.error('用法: node scripts/check-asar-sharp-wasm.mjs --asar=<产物.asar> [--require-wasm=false]')
    process.exit(2)
  }

  const requireWasm = argValue('require-wasm', 'true') !== 'false'
  const { problems, sharpVersion, wasmVersion } = checkAsar(asarPath, { requireWasm })

  if (problems.length > 0) {
    console.error(`${label} ${asarPath} 未通过：`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const wasmNote = requireWasm ? ` + @img/sharp-wasm32 ${wasmVersion}` : ''
  console.log(`${label} ${asarPath} 通过：sharp ${sharpVersion}${wasmNote} 已随包，wasm 短路补丁已生效`)
}

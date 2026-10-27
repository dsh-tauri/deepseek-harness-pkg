#!/usr/bin/env node
// 发布产物的体积报告（只报告，不做任何拦截）。
//
// 历史与理由：0.1.6-alpha.1 -> 0.1.6-alpha.2 的上传体积从 ~156 MiB 涨到
// ~534 MiB，一度把 GitHub Release 资产上传推到 `Headers Timeout Error`
// （undici 5 分钟响应头超时）。膨胀来源已定位为上游的硬依赖：
//
//   @deepseek-ai/dsh-web-app@0.1.6-alpha.2
//     └─ @deepseek-ai/dsh-office-to-pdf
//        └─ @deepseek-ai/libreoffice-kit@0.0.1
//           └─ Windows: libreoffice-kit-win32-x64（解压后 325 MiB 原生引擎）
//              Linux:   libreoffice-kit-wasm    （解压后 185 MiB wasm 引擎）
//
// 而 libreoffice-kit 的 resolveEngine() 在 Windows/macOS 上强制使用原生引擎包
// （拿不到直接 throw，没有 wasm 回退），所以这部分体积无法通过删文件消除。
// 既然躲不掉，就不该用闸门挡住发布 —— 这里只把数字打出来，保持可见性，
// 让膨胀不会被无声吞掉；真要定位来源用 scripts/zip-footprint.mjs。
//
// 用法:
//   node scripts/check-artifact-size.mjs                 # 报告 ./artifacts/**/*.{zip,asar}
//   node scripts/check-artifact-size.mjs --dir=./artifacts
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const dir = resolve(argValue('dir', 'artifacts'))

const MiB = 1024 * 1024
const mib = (bytes) => (bytes / MiB).toFixed(1)

function collectArtifacts(root) {
  const found = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch (err) {
      console.error(`[artifact-size] 无法读取 ${d}: ${err.message}`)
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.(?:zip|asar)$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

const rows = collectArtifacts(dir)
  .map((path) => {
    try {
      return { path, size: statSync(path).size }
    } catch {
      return null
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.size - a.size)

const total = rows.reduce((sum, row) => sum + row.size, 0)

if (rows.length === 0) {
  // 不拦发布，但要让这种情况显式可见：没有产物本身就是异常信号。
  console.log(`[artifact-size] 警告：${dir} 下没有找到任何 .zip / .asar`)
  process.exit(0)
}

console.log(`[artifact-size] ${rows.length} 个产物（上传体积），合计 ${mib(total)} MiB`)
for (const row of rows) {
  console.log(`  ${mib(row.size).padStart(9)} MiB  ${row.path}`)
}
// 基准：alpha.1 单包 ~37 MiB / 合计 ~156 MiB；alpha.2 因上述引擎为
// 93~154 MiB / ~534 MiB。出现数量级跳变时用 zip-footprint.mjs 定位。
console.log('[artifact-size] 仅供参考，不阻断发布；定位来源：node scripts/zip-footprint.mjs <产物.zip>')

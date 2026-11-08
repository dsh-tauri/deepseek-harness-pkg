#!/usr/bin/env node
// 统一 CI 打包瘦身逻辑，并在删除前后打印体积构成报告。
//
// 背景：0.1.6-alpha.2 的 npm 产物比 0.1.6-alpha.1 大了约 3.4 倍
// （39 MiB -> 97~154 MiB，合计 ~534 MiB），直接把 GitHub Release 资产上传
// 推到 `Headers Timeout Error`。原来的两条 `find | -delete` 既不报告删了什么，
// 也无法判断膨胀来自哪里。这里把瘦身收敛成一处，并输出可对比的报告。
//
// 报告分两段，解决「该不该收紧规则」的判断问题：
//   1. 体积构成：总量 / 可回收 / 保留下来的字节，按扩展名和包排名给出；
//   2. 按需展开：--list-dir <目录名> 可以看到哪个包贡献了这些可删文件。
// 若「可回收」很小而总量很大，膨胀就来自保留项（例如原生 .node 二进制或
// 打包后的 .js），需要另找原因，而不是继续加删除规则。
//
// 用法:
//   node scripts/prune-node-modules.mjs                # 报告 -> 删除 -> 报告
//   node scripts/prune-node-modules.mjs --report-only  # 只报告，不删除
//   node scripts/prune-node-modules.mjs --dir <path>   # 根目录（默认 node_modules）
//   node scripts/prune-node-modules.mjs --top <n>      # 排名条目数（默认 15）
//   node scripts/prune-node-modules.mjs --list-dir test --list-dir __tests__
//
// 注意：绝不删除 *.d.ts。类型声明是小文件，且少数包在运行时通过 `types`
// 条件解析它们，删掉的风险大于收益。同理只删真正的测试目录，不用
// `*.test.*` 通配（可能命中运行时代码）。
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const argValues = (name) =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))

const reportOnly = hasFlag('report-only')
const root = resolve(argValue('dir', 'node_modules'))
const topN = Number(argValue('top', '15'))
const listDirs = argValues('list-dir')

// 可删：文件后缀 + 目录名（含 __tests__ 等变体）。
const PRUNE_FILE_SUFFIXES = ['.map', '.ts', '.mts', '.cts']
const PRUNE_DIR_NAMES = new Set([
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  'example',
  'examples',
  'demo',
  'demos',
])

const MiB = 1024 * 1024
const mib = (bytes) => (bytes / MiB).toFixed(1)

// 单个文件是否属于可回收项。目录命中在扫描时整棵子树计入。
const isPrunableFile = (name) => {
  if (name.endsWith('.d.ts')) return false // 安全阀优先于后缀规则
  return PRUNE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// ---------------------------------------------------------------------------
// 扫描：一次遍历同时得到总量、可回收量、按扩展名聚合、按包聚合，以及
// 每类可删目录的逐包明细。
// ---------------------------------------------------------------------------
function scan() {
  const byExtension = new Map()
  const byPackage = new Map()
  const prunableByPackage = new Map()
  const dirBreakdown = new Map()
  const listMatches = new Map(listDirs.map((name) => [name, []]))

  let totalBytes = 0
  let totalFiles = 0
  let totalDirs = 0
  let prunableBytes = 0
  let prunableFiles = 0

  const add = (map, key, bytes) => map.set(key, (map.get(key) ?? 0) + bytes)

  const walk = (dir, packageKey) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue // 链接不计体积，也不跟随
      if (entry.isDirectory()) {
        totalDirs += 1
        if (PRUNE_DIR_NAMES.has(entry.name)) {
          const stats = subtreeStats(full)
          totalBytes += stats.bytes
          totalFiles += stats.files
          prunableBytes += stats.bytes
          prunableFiles += stats.files
          add(byPackage, packageKey, stats.bytes)
          add(prunableByPackage, packageKey, stats.bytes)
          add(dirBreakdown, entry.name, stats.bytes)
          if (listMatches.has(entry.name)) {
            listMatches.get(entry.name).push({ package: packageKey, path: full, bytes: stats.bytes })
          }
          continue // 整棵子树已计入，不再下钻
        }
        walk(full, packageKey)
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      totalBytes += size
      totalFiles += 1
      const dot = entry.name.lastIndexOf('.')
      add(byExtension, dot === -1 ? '<no-ext>' : entry.name.slice(dot), size)
      add(byPackage, packageKey, size)
      if (isPrunableFile(entry.name)) {
        prunableBytes += size
        prunableFiles += 1
        add(prunableByPackage, packageKey, size)
      }
    }
  }

  let topLevel
  try {
    topLevel = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    console.error(`[prune-node-modules] 无法读取 ${root}: ${err.message}`)
    process.exit(1)
  }

  for (const entry of topLevel) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const pkg of scoped) {
        if (!pkg.isDirectory() || pkg.isSymbolicLink()) continue
        walk(join(full, pkg.name), `${entry.name}/${pkg.name}`)
      }
      continue
    }
    walk(full, entry.name)
  }

  return {
    byExtension,
    byPackage,
    prunableByPackage,
    dirBreakdown,
    listMatches,
    totalBytes,
    totalFiles,
    totalDirs,
    prunableBytes,
    prunableFiles,
  }
}

function subtreeStats(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          bytes += statSync(full).size
          files += 1
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function report(label, stats) {
  console.log(
    `[prune-node-modules] ${label}: 总计 ${mib(stats.totalBytes)} MiB / ${stats.totalFiles} files / ` +
      `${stats.totalDirs} dirs；其中可回收 ${mib(stats.prunableBytes)} MiB / ${stats.prunableFiles} files；` +
      `保留 ${mib(stats.totalBytes - stats.prunableBytes)} MiB`,
  )

  const ranked = [...stats.byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  if (ranked.length > 0) {
    console.log(`[prune-node-modules] ${label} 最大的 ${ranked.length} 个包（含可回收 X MiB）:`)
    for (const [name, bytes] of ranked) {
      const reclaimable = stats.prunableByPackage.get(name) ?? 0
      console.log(`  ${mib(bytes).padStart(9)} MiB (${mib(reclaimable).padStart(8)} 可回收)  ${name}`)
    }
  }

  console.log(`[prune-node-modules] ${label} 按扩展名:`)
  for (const [ext, bytes] of [...stats.byExtension.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${mib(bytes).padStart(9)} MiB  ${ext}`)
  }

  if (stats.dirBreakdown.size > 0) {
    console.log(`[prune-node-modules] ${label} 命中目录:`)
    for (const [name, bytes] of [...stats.dirBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${mib(bytes).padStart(9)} MiB  ${name}/`)
    }
  }

  if (listDirs.length > 0) {
    for (const name of listDirs) {
      const matches = (stats.listMatches.get(name) ?? []).sort((a, b) => b.bytes - a.bytes)
      console.log(`[prune-node-modules] ${label} ${name}/ 逐包明细（${matches.length} 处）:`)
      for (const match of matches.slice(0, topN)) {
        console.log(`  ${mib(match.bytes).padStart(9)} MiB  ${match.package}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 删除：只删匹配的普通文件与目录。
// ---------------------------------------------------------------------------
function prune() {
  let files = 0
  let bytes = 0

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name)) {
          const stats = subtreeStats(full)
          try {
            rmSync(full, { recursive: true, force: true })
            bytes += stats.bytes
            files += stats.files
          } catch {
            // 与旧 `|| true` 保持一致：CI 上删不掉不应中断打包
          }
          continue
        }
        walk(full)
        continue
      }
      if (!entry.isFile() || !isPrunableFile(entry.name)) continue
      try {
        const size = statSync(full).size
        rmSync(full, { force: true })
        bytes += size
        files += 1
      } catch {
        // 同上
      }
    }
  }

  walk(root)
  return { files, bytes }
}

// ---------------------------------------------------------------------------
// 平台专属包：@img/sharp-wasm32 只在 Linux 的 Electron 里被用到（sharp 原生
// 二进制与 Electron 的系统 GLib 符号冲突，见 patch sharp@0.35.5）。它随
// package.json 的 dependencies 装进每个平台，非 Linux 产物里是纯负担。
// ---------------------------------------------------------------------------
const PLATFORM_ONLY_PACKAGES = [{ name: '@img/sharp-wasm32', platforms: ['linux'] }]

function prunePlatformOnly() {
  const removed = []
  for (const { name, platforms } of PLATFORM_ONLY_PACKAGES) {
    if (platforms.includes(process.platform)) continue
    const dir = join(root, ...name.split('/'))
    if (!existsSync(dir)) continue
    const stats = subtreeStats(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push({ name, ...stats })
    } catch {
      // 与后缀规则一致：删不掉不中断打包
    }
  }
  return removed
}

const before = scan()
report('before', before)

if (reportOnly) {
  console.log('[prune-node-modules] --report-only：未删除任何文件')
  process.exit(0)
}

const pruned = prune()
console.log(
  `[prune-node-modules] 已删除 ${pruned.files} 个文件，释放 ${mib(pruned.bytes)} MiB ` +
    `(后缀 ${PRUNE_FILE_SUFFIXES.join('/')} + 目录 ${[...PRUNE_DIR_NAMES].join('/')})`,
)

for (const pkg of prunePlatformOnly()) {
  console.log(
    `[prune-node-modules] 已删除平台专属包 ${pkg.name}：${pkg.files} 个文件，释放 ${mib(pkg.bytes)} MiB ` +
      `(当前平台 ${process.platform}，该包只在 ${PLATFORM_ONLY_PACKAGES.find((entry) => entry.name === pkg.name).platforms.join('/')} 上需要)`,
  )
}

const after = scan()
report('after', after)
console.log(
  `[prune-node-modules] 净减少 ${mib(before.totalBytes - after.totalBytes)} MiB ` +
    `(${mib(before.totalBytes)} -> ${mib(after.totalBytes)} MiB)`,
)

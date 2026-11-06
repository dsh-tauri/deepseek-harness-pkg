#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATCHES, isPatched } from './core-patches.mjs'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const label = '[check-core-patches]'

export function check(target) {
  const missing = []
  for (const entry of PATCHES) {
    const file = join(target, 'node_modules', ...entry.name.split('/'), entry.file)
    if (!existsSync(file)) {
      missing.push(`${entry.name}/${entry.file}: 文件不存在（产物未包含该包，或路径不是 deploy 输出）`)
      continue
    }
    if (!isPatched(readFileSync(file, 'utf8'), entry)) {
      missing.push(`${entry.name}/${entry.file}: 缺少补丁标记 ${entry.markers.join(' / ')}`)
    }
  }
  return missing
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = resolve(argValue('dir', 'build_dir'))
  const missing = check(target)
  if (missing.length > 0) {
    console.error(`${label} ${target} 未通过 ${missing.length} 项检查：`)
    for (const line of missing) console.error(`  - ${line}`)
    console.error(`${label} 产物里的核心补丁丢失：pnpm deploy 未应用 patches/，或 npm install 把包重新解包回原版。`)
    process.exit(1)
  }
  console.log(`${label} ${target} 的 ${PATCHES.length} 个核心补丁均已生效`)
}

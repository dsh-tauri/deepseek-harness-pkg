#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATCHES, applyUnifiedDiff, isPatched } from './core-patches.mjs'

const label = '[apply-core-patches]'
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

export function apply(target, patchesDir) {
  if (!existsSync(join(target, 'node_modules')))
    throw new Error(`${label} ${target} 下没有 node_modules，先跑 pnpm deploy`)
  const applied = []
  const skipped = []
  for (const entry of PATCHES) {
    const file = join(target, 'node_modules', ...entry.name.split('/'), entry.file)
    if (!existsSync(file)) {
      skipped.push(`${entry.name}: 产物里没有 ${entry.file}`)
      continue
    }
    const source = readFileSync(file, 'utf8')
    if (isPatched(source, entry)) {
      skipped.push(`${entry.name}: 已是补丁后的内容`)
      continue
    }
    const patchFile = join(patchesDir, entry.patch)
    if (!existsSync(patchFile)) throw new Error(`${label} 缺少补丁文件 ${patchFile}`)
    writeFileSync(file, applyUnifiedDiff(source, readFileSync(patchFile, 'utf8'), entry.patch))
    applied.push(entry.name)
  }
  return { applied, skipped }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = resolve(argValue('dir', 'build_dir'))
  const patchesDir = resolve(argValue('patches', 'patches'))
  if (!existsSync(join(target, 'node_modules'))) {
    console.error(`${label} ${target} 下没有 node_modules，先跑 pnpm deploy`)
    process.exit(1)
  }
  const { applied, skipped } = apply(target, patchesDir)
  for (const name of applied) console.log(`${label} 已应用 ${name}`)
  for (const note of skipped) console.log(`${label} 跳过 ${note}`)
  console.log(`${label} ${applied.length} 个补丁写入 ${target}，${skipped.length} 项跳过`)
}

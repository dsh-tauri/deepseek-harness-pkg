#!/usr/bin/env node
// 把 patches/*.mjs 里的核心补丁套到部署产物（build_dir）上。
//
// 为什么不在 pnpm install 阶段打补丁：pnpm 的 patchedDependencies 要求补丁是严格
// 的逐行 diff，上游一改代码/换压缩方式就 ERR_PNPM_PATCH_FAILED；版本键也只能写成
// 开区间，永远追不上新版本。这里改在 deploy 之后按语义锚点改写，对任意 dsh 版本生效。
//
// 任何一个补丁不能应用（包不在产物里、锚点对不上、打完缺标记）都会让命令以非 0
// 退出，打包直接失败 —— 不跳过、不降级，避免发出没打补丁的内核。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATCHES, applyCorePatch } from './core-patches.mjs'

const label = '[apply-core-patches]'
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const packageDir = (target, name) => join(target, 'node_modules', ...name.split('/'))

function packageVersion(target, name) {
  try {
    return JSON.parse(readFileSync(join(packageDir(target, name), 'package.json'), 'utf8')).version
  } catch {
    return '版本未知'
  }
}

export function apply(target) {
  if (!existsSync(join(target, 'node_modules'))) {
    throw new Error(`${label} ${target} 下没有 node_modules，先跑 pnpm deploy`)
  }
  const applied = []
  const untouched = []
  const failures = []
  for (const patch of PATCHES) {
    const file = join(packageDir(target, patch.name), patch.file)
    const version = packageVersion(target, patch.name)
    if (!existsSync(file)) {
      failures.push(`${patch.name}@${version}: 产物里没有 ${patch.file}（补丁不允许跳过：确认依赖还在部署闭包里）`)
      continue
    }
    try {
      const result = applyCorePatch(readFileSync(file, 'utf8'), patch)
      if (result.changed) {
        writeFileSync(file, result.source)
        applied.push(`${patch.name}@${version}: ${patch.summary}`)
      } else {
        untouched.push(`${patch.name}@${version}: 已是补丁后的内容`)
      }
    } catch (error) {
      failures.push(`${patch.name}@${version}: ${error.message}`)
    }
  }
  if (failures.length > 0) {
    const error = new Error(`${label} ${failures.length} 个补丁无法应用，打包中止`)
    error.failures = failures
    throw error
  }
  return { applied, untouched }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = resolve(argValue('dir', 'build_dir'))
  try {
    const { applied, untouched } = apply(target)
    for (const line of applied) console.log(`${label} 已应用 ${line}`)
    for (const line of untouched) console.log(`${label} 已是最新 ${line}`)
    console.log(`${label} ${applied.length} 个补丁写入 ${target}，${untouched.length} 个此前已生效`)
  } catch (error) {
    console.error(`${label} ${error.message}`)
    for (const line of error.failures ?? []) console.error(`  - ${line}`)
    process.exit(1)
  }
}

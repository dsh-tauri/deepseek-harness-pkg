#!/usr/bin/env node
// pnpm 的 legacy deploy 会在产物里留下符号链接：workspace 包被链接进目标
// node_modules，而 deploy 目标本身位于 workspace 内时，pnpm 还会把这个包链接进
// 它自己的 node_modules。`zip -r` 会跟随目录链接，于是 cordis 与
// cordis-plugin-include 之间那种循环 workspace 依赖被无限展开：run 43066852450
// 的源码构建在 "Scanning files" 里扫了 88 秒、刷出 2460 条 `zip warning: name
// not matched`，始终没有产出 zip（随后被矩阵 fail-fast 取消）。
//
// 这里把每个链接换成真实文件，并丢掉指向产物自身的链接——把它解引用等于把整个
// 产物复制进它自己，而且发布包从来不带项目源码。上游的
// scripts/build-exe-for-python-sdk-staging.ts 对同一个部署做同样的事。
//
// 用法: node scripts/materialize-deploy-links.mjs --dir=build_dir
import { cpSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const label = '[materialize-deploy-links]'
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

/** Return the first symbolic link below a directory, depth first. */
export function findLink(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (lstatSync(path).isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = findLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every package link below `root`/node_modules with real files.
 * @param root - Deployed payload root whose node_modules becomes link-free.
 * @returns counts of replaced links, dropped self-references, and removed .bin directories.
 */
export function materialize(root) {
  const payload = realpathSync(root)
  const report = { replaced: 0, dropped: 0, bins: 0 }
  const walk = (directory) => {
    // .bin 里全是链接，打包不需要它们：启动脚本由调用方自己写。
    if (basename(directory) === '.bin') {
      rmSync(directory, { recursive: true, force: true })
      report.bins += 1
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const source = realpathSync(path)
        if (payload === source || payload.startsWith(source + sep)) {
          unlinkSync(path)
          report.dropped += 1
          continue
        }
        // 复制时不再带上嵌套 node_modules：循环 workspace 依赖因此就地终止。
        const nested = join(source, 'node_modules')
        unlinkSync(path)
        cpSync(source, path, {
          recursive: true,
          dereference: true,
          filter: candidate => candidate !== nested && !candidate.startsWith(nested + sep),
        })
        report.replaced += 1
        continue
      }
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(join(root, 'node_modules'))
  return report
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(argValue('dir', 'build_dir'))
  const report = materialize(root)
  console.log(`${label} ${root}: 解引用 ${report.replaced} 个链接，丢弃 ${report.dropped} 个自引用链接，清掉 ${report.bins} 个 .bin 链接目录`)
  const leftover = findLink(join(root, 'node_modules'))
  if (leftover !== undefined) {
    console.error(`${label} 仍残留符号链接 ${leftover}：zip 会跟随它，先修好再打包`)
    process.exit(1)
  }
}

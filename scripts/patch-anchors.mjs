// 核心补丁的锚点工具。
//
// 上游每次发版都会重排甚至压缩 client bundle：0.2.2-rc.1 的
// `dsh-client-ui-renderer/lib/client.js` 还是 1884 行带制表符缩进的产物，
// 0.2.2-rc.2 直接被 tsdown 压成 23 行，连 `exports.apply = apply;` 都变成了
// `exports.apply=apply;`。逐行 git diff 的上下文因此必然失效（pnpm 侧表现为
// ERR_PNPM_PATCH_FAILED，直接卡死 pnpm install）。
//
// 所以补丁只认「语义锚点」：一小段跨版本、跨压缩都保持原样（或只差空白）的代码。
// 锚点必须**恰好命中一次**；命中 0 次或多次都抛错 —— 补丁绝不允许被悄悄跳过，
// 上游一改这段代码，打包就该失败而不是发出一个没打补丁的内核。

function withGlobal(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return new RegExp(pattern.source, flags)
}

export function countMatches(source, pattern) {
  return [...source.matchAll(withGlobal(pattern))].length
}

// 把唯一命中的锚点替换成 replacement（字符串或 match => string 函数）。
export function replaceOnce(source, pattern, replacement, what) {
  const hits = countMatches(source, pattern)
  if (hits !== 1) {
    throw new Error(`${what}: 锚点 ${pattern} 在目标文件里命中 ${hits} 处，期望恰好 1 处`)
  }
  return source.replace(pattern, replacement)
}

export function insertAfter(source, pattern, text, what) {
  return replaceOnce(source, pattern, match => `${match}${text}`, what)
}

export function insertBefore(source, pattern, text, what) {
  return replaceOnce(source, pattern, match => `${text}${match}`, what)
}

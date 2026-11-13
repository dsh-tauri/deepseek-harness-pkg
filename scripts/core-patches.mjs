import pluginManager from '../patches/dsh-client-ui-plugin-manager.mjs'
import renderer from '../patches/dsh-client-ui-renderer.mjs'
import sharp from '../patches/sharp.mjs'
import ripgrep from '../patches/vscode-ripgrep.mjs'

// 核心补丁清单。
//
// 这些补丁以前写成 patches/*.patch 并由 pnpm 的 patchedDependencies 在 install 阶段
// 套用，版本键写死成 `>=0.2.2-rc.1`，补丁正文又是逐行 git diff 的上下文：上游一发
// 0.2.2-rc.2（client bundle 被压缩成单行）就 ERR_PNPM_PATCH_FAILED，整个安装直接失败。
// 现在改成「部署产物 + 语义锚点」：任何 dsh 版本都按同一份补丁改写，锚点对不上就
// 报错（见 scripts/patch-anchors.mjs），不会静默跳过。
export const PATCHES = [renderer, pluginManager, sharp, ripgrep]

// 每个补丁的 markers 是补丁自己写进去的固定文本，用来判断「已经打过」。
export function isPatched(source, patch) {
  return patch.markers.every(marker => source.includes(marker))
}

// 就地改写一个文件内容：已打过则原样返回，否则执行补丁并复核标记。
export function applyCorePatch(source, patch) {
  if (isPatched(source, patch)) return { source, changed: false }
  const patched = patch.apply(source)
  if (patched === source) {
    throw new Error(`${patch.name}: 补丁执行后文件没有任何变化（${patch.summary}）`)
  }
  const missing = patch.markers.filter(marker => !patched.includes(marker))
  if (missing.length > 0) {
    throw new Error(`${patch.name}: 打完补丁仍缺少标记 ${missing.join(' / ')}`)
  }
  return { source: patched, changed: true }
}

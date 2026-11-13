import { insertAfter } from '../scripts/patch-anchors.mjs'

// 桌面端把 dsh-tauri-* 的 bundle（桌面 UI、壳内扩展）当成外壳的一部分，不应该出现在
// 「插件」面板里让用户禁用/卸载。上游的 listed 只排除 HIDDEN_BUNDLES，这里再按名字
// 前缀过滤一条。
//
// 锚点 `!HIDDEN_BUNDLES.has(pkg.name) && (` 在 rc.1（未压缩）与 rc.2（单行压缩）里
// 都保持原样，只差空白。
export default {
  name: '@deepseek-ai/dsh-client-ui-plugin-manager',
  file: 'lib/client.js',
  summary: '插件面板隐藏 dsh-tauri-* bundle',
  markers: ['!pkg.name.startsWith("dsh-tauri")'],
  apply(source) {
    return insertAfter(
      source,
      /!HIDDEN_BUNDLES\.has\(pkg\.name\)\s*&&/u,
      ' !pkg.name.startsWith("dsh-tauri") &&',
      '插件面板隐藏 dsh-tauri-* bundle',
    )
  },
}

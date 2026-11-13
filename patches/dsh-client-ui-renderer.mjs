import { insertAfter } from '../scripts/patch-anchors.mjs'

// 桌面端要在自己的壳里渲染 slot（设置侧栏、扩展面板都直接用 <SlotOutlet>），
// 必须从 renderer 里拿到 SlotOutlet 组件。上游只导出 SlotRegistry / apply / inject，
// 这里在模块收尾处补一行导出 —— SlotOutlet 本身是同一个模块作用域里的函数声明。
//
// 锚点选 `exports.apply = apply;`：rc.1（未压缩）与 rc.2（单行压缩）都以
// `exports.apply = apply;` → `exports.inject = inject;` 收尾，压缩只影响空白。
export default {
  name: '@deepseek-ai/dsh-client-ui-renderer',
  file: 'lib/client.js',
  summary: '导出 SlotOutlet',
  markers: ['exports.SlotOutlet = SlotOutlet;'],
  apply(source) {
    if (!/function SlotOutlet\s*\(/u.test(source)) {
      throw new Error('导出 SlotOutlet: 上游 lib/client.js 里已经没有 SlotOutlet 定义，补丁需要重写')
    }
    return insertAfter(
      source,
      /exports\.apply\s*=\s*apply;/u,
      ' exports.SlotOutlet = SlotOutlet;',
      '导出 SlotOutlet',
    )
  },
}

import { replaceOnce } from '../scripts/patch-anchors.mjs'

// Linux 上的 Electron 动态链接系统 GLib，把 g_object_* 暴露到进程全局；sharp 预编译的
// libvips 自带静态 GLib 并导出同名符号，原生 addon 的 g_object_unref 绑到 Electron 那份后
// 在 libuv 工作线程里崩溃（electron/electron#46323）。上游确实有一条 @img/sharp-wasm32
// 兜底，但排在原生平台 switch **之后**，永远轮不到。这里把 wasm 尝试提到 switch 之前，
// 且只对 Electron + Linux 生效：纯 Node 仍走原生二进制，其它平台完全不变。
//
// 锚点 `switch (runtimePlatform) {` 是上游加载器的平台分派点；拿掉它说明 sharp 换了
// 加载方式，补丁必须重写（宁可打包失败，也不要发一份 Linux 上会崩的 sharp）。
const BLOCK = `/* dsh-tauri-desktop: Electron for Linux links the system GLib and exposes g_object_*
   globally, while the prebuilt libvips bundles its own static GLib exporting the same
   symbols: the native addon resolves g_object_unref to Electron's copy and crashes in
   a libuv worker thread (electron/electron#46323). Attempt the WebAssembly build first
   on that combination only; plain Node keeps the native binary. */
if (!sharp && Boolean(process.versions.electron) && runtimePlatform.startsWith("linux")) {
  try {
    sharp = require("@img/sharp-wasm32/sharp.node");
  } catch (err) {
    errors.push(err);
  }
}
`

export default {
  name: 'sharp',
  file: 'dist/sharp.cjs',
  summary: 'Electron + Linux 优先加载 WebAssembly 副本',
  markers: [
    '/* dsh-tauri-desktop: Electron for Linux links the system GLib',
    'if (!sharp && Boolean(process.versions.electron) && runtimePlatform.startsWith("linux")) {',
  ],
  apply(source) {
    const indentOf = match => match.slice(0, match.indexOf('switch'))
    const block = match => BLOCK.split('\n').map(line => (line === '' ? line : `${indentOf(match)}${line}`)).join('\n')
    return replaceOnce(
      source,
      /^([ \t]*)switch \(runtimePlatform\) \{/mu,
      match => `${block(match)}${match}`,
      'Electron + Linux 优先加载 wasm',
    )
  },
}

import { insertAfter, replaceOnce } from '../scripts/patch-anchors.mjs'

// Electron 用 asar 虚拟文件系统提供原生包：@vscode/ripgrep 里唯一的
// `require.resolve(...)` 在归档内能解析、existsSync 也报存在，但操作系统无法执行
// 这个路径，spawn 直接 ENOENT —— 桌面端的 grep/glob 因此整体失效（issue #23）。
//
// 补丁把解析换成一条回退链：先用 ESM 解析（宿主可以挂钩子把原生包物化出归档），
// 再试 .asar.unpacked 兄弟路径，最后按内容哈希把二进制复制到临时目录。
// 纯 Node 产物路径里没有 .asar，原样返回，行为完全不变。
//
// 上游 lib/index.js 只有一条解析语句、一个 require 导入；两处锚点都在最早的
// 1.18 以来没变过。
const IMPORTS = `import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';`

const HELPERS = `/**
 * dsh-tauri-desktop: Electron serves a native package stored inside an \`.asar\`
 * archive through a virtual filesystem, so its path resolves and \`existsSync()\`
 * reports it even though the operating system cannot execute it (\`spawn\` fails
 * with ENOENT). That is what broke \`grep\` and \`glob\` in the desktop app.
 *
 * Resolve through the ESM loader first: a host can hook it and materialize the
 * native package outside the archive. Then prefer an unpacked sibling, and
 * finally copy the binary into a per-content cache directory so an archive-aware
 * host without such a hook still gets an executable path. A plain Node install
 * keeps the path it already resolves to.
 */
function resolveBinary(specifier) {
    let modulePath;
    try {
        modulePath = fileURLToPath(import.meta.resolve(specifier));
    } catch {
        modulePath = require.resolve(specifier);
    }
    const archive = modulePath.search(/\\.asar(?=[\\\\/])/u);
    if (archive === -1) return modulePath;
    const unpacked = \`\${modulePath.slice(0, archive)}.asar.unpacked\${modulePath.slice(archive + 5)}\`;
    return existsSync(unpacked) ? unpacked : materialize(modulePath);
}

function materialize(modulePath) {
    const contents = readFileSync(modulePath);
    const directory = join(tmpdir(), 'dsh-ripgrep', createHash('sha256').update(contents).digest('hex').slice(0, 16));
    const executable = join(directory, binaryName);
    if (!existsSync(executable)) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(executable, contents);
        chmodSync(executable, 0o755);
    }
    return executable;
}`

export default {
  name: '@vscode/ripgrep',
  file: 'lib/index.js',
  summary: 'rg 二进制可从 asar 归档里跑起来',
  markers: [
    'dsh-tauri-desktop: Electron serves a native package stored inside an',
    'function resolveBinary(specifier) {',
  ],
  apply(source) {
    let patched = insertAfter(
      source,
      /^import \{ createRequire \} from 'node:module';$/mu,
      `\n${IMPORTS}`,
      '补 node: 导入',
    )
    patched = replaceOnce(
      patched,
      /resolved = require\.resolve\(/u,
      'resolved = resolveBinary(',
      '改用 resolveBinary 解析 rg 二进制',
    )
    return `${patched.endsWith('\n') ? patched : `${patched}\n`}\n${HELPERS}\n`
  },
}

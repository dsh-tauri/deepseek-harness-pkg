<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-pkg">
    <img src="public/favicon.svg" width="112" alt="DeepSeek Harness Pkg" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Pkg</h1>

<p align="center">
  <em><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（<code>dsh</code>）的跨平台生产依赖包 —— 固定版本，由 GitHub Actions 自动同步构建。</em>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/%40deepseek-ai%2Fdsh?style=flat-square&label=dsh" alt="dsh" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.19+" />
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-pkg/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
</p>

> **开发者预览。** 上游迭代较快，可能出现不兼容变更。

## 快速开始

ZIP 包含 `dsh` CLI 与 Web UI 的生产 npm 依赖，不含 Node.js 可执行文件，也不是桌面安装包。`.asar.zip` 里是同一份内容的 Electron 单文件资源：解压得到 `.asar`，供 Electron 应用直接挂载。asar 自身不压缩（每平台约 400 MiB），外面那层 ZIP 只为把下载体积压回 ~140 MiB。

**要求：** 自行安装 Node.js `>=22.19.0` 并加入 `PATH`（CI 使用 `22.22.0`）；使用 ZIP 无需全局安装 pnpm。

从 [Releases](https://github.com/dsh-tauri/deepseek-harness-pkg/releases) 下载对应平台的 ZIP，解压后在解压根目录打开终端。

| 平台 | ZIP（外部 Node） | asar.zip（Electron，先解压） |
| --- | --- | --- |
| Windows（x64） | `deepseek-harness-pkg-windows.zip` | `deepseek-harness-pkg-windows.asar.zip` |
| Windows（ARM64） | `deepseek-harness-pkg-windows-arm64.zip` | `deepseek-harness-pkg-windows-arm64.asar.zip` |
| macOS（Apple Silicon） | `deepseek-harness-pkg-macos-arm64.zip` | `deepseek-harness-pkg-macos-arm64.asar.zip` |
| macOS（Intel） | `deepseek-harness-pkg-macos-x64.zip` | `deepseek-harness-pkg-macos-x64.asar.zip` |
| Linux（x64） | `deepseek-harness-pkg-linux.zip` | `deepseek-harness-pkg-linux.asar.zip` |
| Linux（ARM64 / aarch64） | `deepseek-harness-pkg-linux-arm64.zip` | `deepseek-harness-pkg-linux-arm64.asar.zip` |

`.asar.zip` 解压后是单个 `deepseek-harness-pkg-<平台>.asar`，内部目录结构与 ZIP 相同（`node_modules/` + `package.json`）。但只有 Electron 的 `fs` 能读 asar：普通 Node 需要 ZIP，或先 `npx @electron/asar extract deepseek-harness-pkg-linux.asar out` 解包。asar 里没有 `unpacked` 目录，`node-pty` 的 `spawn-helper` 这类需要真正落在磁盘上的可执行文件同样要先解包后才能 spawn。

Windows（PowerShell）：

```powershell
.\node_modules\.bin\dsh.cmd web
```

macOS / Linux：

```sh
./node_modules/.bin/dsh web
```

默认地址为 `http://127.0.0.1:3080`，请遵循 CLI 输出的认证访问指引。在界面中配置模型提供方/API Key，详见[上游文档](https://github.com/deepseek-ai/deepseek-harness)。

## 本地构建

维护者需要 Node.js `>=22.19.0` 与 pnpm `11.7.0`，版本声明见 [package.json](<package.json>)。当前固定的 `@deepseek-ai/dsh` 版本为 `0.2.1-alpha.1`；桌面应用另按兼容规则选择内核。

```sh
pnpm install
pnpm start              # 使用仓库依赖运行 dsh web
pnpm build              # 将生产依赖部署到 build_dir/
```

`pnpm build` 将上游生产依赖部署到 `build_dir/`，不改写运行时代码；`pnpm start` 并不运行这份部署产物。依赖布局与安装脚本设置见[工作区/构建策略](<pnpm-workspace.yaml>)。

## 发布与同步

两条同步工作流均每 **6 小时**运行，也支持手动输入：可选 `version`（留空自动选择）与 `force`（默认 `false`，用于强制重建）。

| 工作流 | 输入 / 选择规则 | 结果 |
| --- | --- | --- |
| [release.yml](<.github/workflows/release.yml>) | 必填 `dsh_version`：npm 版本或 `latest`；表单默认 `0.1.2-rc.1`，不等于当前固定版本。 | 六个 ZIP + 六个 asar.zip；普通 Release `dsh-<version>-<run_id>`（`<version>` 使用输入原值）。 |
| [sync-release.yml](<.github/workflows/sync-release.yml>) | 取 npm 所有已发布版本中 semver 最高者，覆盖所有 dist-tag，不只看 `latest`。 | 调用 npm 发布工作流；仅在发布成功后更新 `main` 的清单与锁文件。 |
| [release-from-source.yml](<.github/workflows/release-from-source.yml>) | 必填 `dsh_version`，不带 `dsh-v`；克隆准确的 `dsh-v<version>` tag，构建并部署运行时依赖闭包。 | 六个 ZIP + 六个 asar.zip；预发布 `dsh-src-<version>-<run_id>`；不更新 `main`。 |
| [sync-source-release.yml](<.github/workflows/sync-source-release.yml>) | 选择高于 npm 最高版本的上游 GitHub Release 最高版本。 | 调用源码工作流；除非强制重建，否则跳过已有的源码预发布。 |

npm 预检先[等待真实 tarball 可下载](<scripts/wait-for-npm-version.mjs>)，最多 10 分钟。随后以 `pnpm install --ignore-scripts` [实际安装完整依赖闭包](<scripts/check-dsh-installable.mjs>)，有界重试通过后才启动六目标构建矩阵。

两条发布路径均会[裁剪产物](<scripts/prune-node-modules.mjs>)、按平台打包同名 asar（压缩成 `*.asar.zip`），并确认十二个资产已上传。[体积报告](<scripts/check-artifact-size.mjs>)仅供参考，不作为发布门槛。Windows ARM64 在 `windows-11-arm` 上原生安装；x64 的 ZIP 名仍是 `deepseek-harness-pkg-windows.zip`。

## Linux ARM64 兼容性

两条发布路径均在 `ubuntu-24.04-arm`（Ubuntu 24.04、glibc 2.39）上使用 Node.js 22.22.0 原生安装、构建，不把 x64 依赖交叉打包为 ARM64。裁剪后会检查架构，加载 `koffi`、`sharp`、`node-pty`，并在该 runner 上运行部署后的 CLI `web --help`。

**尚未验证或保证 Kylin V10 / glibc 2.28 兼容。** 本机编译的原生模块继承 runner 工具链基线；上游预编译二进制另有 glibc / libstdc++ 要求。仅安装 Node.js 或重编一个模块不能证明整个 ZIP 兼容。请使用较新的受支持系统，或在匹配的 ARM64/glibc 2.28 环境中重建、验证完整依赖闭包（包括预编译依赖）后再部署。ZIP 仍需外部 ARM64 Node.js 运行时。

## 运行时兼容性

本地构建与两条发布路径均保留上游运行时代码，唯一例外是 [patches/](<patches/>) 里的一组固定补丁：renderer 的 `SlotOutlet` 导出、桌面插件页隐藏 `dsh-tauri-*`、OpenCode 会话 ID 请求头、未分组会话（不属于任何工作区但有自己 cwd 的会话）的 composer 可用性。这些原本由桌面端在启动时改写，烘进产物后才能让只读的 asar 核心正常运行。其余行为遵循打包所用的上游版本。Codex 错误因此可能包含原始 HTML 边缘响应正文，请将错误日志视为可能包含敏感信息。

Linux 上在 Electron 里运行时，sharp 走 WebAssembly 副本而非原生 addon。Electron 的 Linux 二进制动态链接系统 GLib，把 `g_object_*` 暴露到进程全局；sharp 预编译的 libvips 自带静态 GLib 并导出同名符号，于是原生 addon 的 `g_object_unref` 绑到 Electron 那份，在 libuv 工作线程里段错误（[electron/electron#46323](https://github.com/electron/electron/issues/46323)，上游仍未修）。因此产物里的 `dist/sharp.cjs` 在 Linux + `process.versions.electron` 时先加载 [`@img/sharp-wasm32`](https://sharp.pixelplumbing.com/install#cross-platform)，加载失败才回落到原生二进制。纯 Node（ZIP 产物、SSH 会话）仍走原生二进制，性能不变；`@img/sharp-wasm32` 会在非 Linux 产物里被裁掉，linux-x64 与 linux-arm64 共用同一套机制，不需要任何架构专属二进制。

在 asar 内核上，`grep` 与 `glob` 曾经全部失败并报 `ripgrep provider failure`：Electron 的归档文件系统会说包里那份 `rg` 二进制"存在"，但操作系统无法执行 `.asar` 文件内部的路径，`spawn` 最终以 `ENOENT` 结束（[issue #23](https://github.com/dsh-tauri/deepseek-harness-pkg/issues/23)）。[`@vscode/ripgrep`](<patches/@vscode__ripgrep@1.18.0.patch>) 原先只用 CJS `require.resolve` 定位该二进制，归档钩子无法介入物化。补丁改为优先走 ESM 解析，宿主若会把原生包物化到磁盘，拿到的就是真实路径；若解析结果仍在归档里，先看同名的 `.asar.unpacked` 目录，最后把二进制复制到系统临时目录下按内容哈希命名的文件夹。纯 Node 安装不受影响：路径里没有 `.asar` 时原样返回解析结果。

WebAssembly 副本的堆上限是 2 GiB（`WebAssembly.Memory` 的 `maximum: 32768` 页），一张完整解码后的位图必须装得下：24,000 × 24,000 的 RGBA 需要 2,197 MiB，会直接报 `vips_image_write_to_memory: out of memory` 而解不出来。默认 `maxImagePixels` 是 64 Mpx（解码后 256 MiB），离这个上限很远；把它调到 500 Mpx 左右以上，Electron + Linux 下的图片准入会明确失败。这条路径上有意不回落原生 addon——加载它正是段错误的原因，所以报错就是预期结果。

需要 LAN 访问时，请查阅所打包 CLI 的帮助，按对应版本的参数配置。较新的上游版本要求绑定一个具体的本机 IPv4 或 IPv6 地址，而不是 `0.0.0.0` 等通配地址；原 LAN 放行环境变量不再覆盖这一策略。

`--trusted-host` 限制主机信任范围，不是认证机制。请妥善保管上游访问凭据，仅在可信网络启用 LAN。

## 安全与使用

- 仅供个人学习、研究与测试，请勿用于商业用途。
- `dsh` 可执行本地代码：请使用可信、隔离的环境，避免导入不可信配置或插件。
- LAN 暴露会增加风险；切勿向不可信网络开放服务或分享访问令牌。
- 开发者不对使用本项目造成的数据丢失或安全问题负责。

## 相关项目与致谢

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是上游 CLI/Web/插件项目；[DeepSeek Harness Desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) 将这些依赖包用于桌面应用。

感谢 [n8n-pkg](https://github.com/hairyf/n8n-pkg) 的打包模式、[pnpm](https://pnpm.io/) 的依赖/部署工具，以及 [GitHub Actions](https://github.com/features/actions) 的跨平台构建支持。

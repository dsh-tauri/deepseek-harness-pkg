<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-pkg">
    <img src="public/favicon.svg" width="112" alt="DeepSeek Harness Pkg" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Pkg</h1>

<p align="center">
  <em>Cross-platform production dependency bundles for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> (<code>dsh</code>) — pinned and auto-synced by GitHub Actions.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/%40deepseek-ai%2Fdsh?style=flat-square&label=dsh" alt="dsh" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.19+" />
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-pkg/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
</p>

> **Developer preview.** Upstream changes rapidly and may break compatibility.

## Quick start

These ZIPs contain production npm dependencies for the `dsh` CLI and web UI, not a Node.js binary or a desktop installer. Each `.asar.zip` wraps the same tree as a single-file Electron resource: unzip it to get the `.asar` an Electron app mounts directly. An asar is stored uncompressed (~400 MiB per platform), so the outer ZIP only brings the download back to ~140 MiB.

**Requirements:** external Node.js `>=22.19.0` on `PATH` (CI uses `22.22.0`); no global pnpm installation is needed to use a ZIP.

Download the matching ZIP from [Releases](https://github.com/dsh-tauri/deepseek-harness-pkg/releases), extract it, and open a terminal in the extracted root.

| Platform | ZIP (external Node) | asar.zip (Electron, unzip first) |
| --- | --- | --- |
| Windows (x64) | `deepseek-harness-pkg-windows.zip` | `deepseek-harness-pkg-windows.asar.zip` |
| Windows (ARM64) | `deepseek-harness-pkg-windows-arm64.zip` | `deepseek-harness-pkg-windows-arm64.asar.zip` |
| macOS (Apple Silicon) | `deepseek-harness-pkg-macos-arm64.zip` | `deepseek-harness-pkg-macos-arm64.asar.zip` |
| macOS (Intel) | `deepseek-harness-pkg-macos-x64.zip` | `deepseek-harness-pkg-macos-x64.asar.zip` |
| Linux (x64) | `deepseek-harness-pkg-linux.zip` | `deepseek-harness-pkg-linux.asar.zip` |
| Linux (ARM64 / aarch64) | `deepseek-harness-pkg-linux-arm64.zip` | `deepseek-harness-pkg-linux-arm64.asar.zip` |

Unzipping `.asar.zip` yields a single `deepseek-harness-pkg-<platform>.asar` whose layout matches the ZIP (`node_modules/` + `package.json`). Only Electron's patched `fs` can read an asar: plain Node needs the ZIP, or `npx @electron/asar extract deepseek-harness-pkg-linux.asar out` first. There is no `unpacked` directory, so executables that must exist on disk — `node-pty`'s `spawn-helper` — also need extracting before they can be spawned.

Windows (PowerShell):

```powershell
.\node_modules\.bin\dsh.cmd web
```

macOS / Linux:

```sh
./node_modules/.bin/dsh web
```

The default address is `http://127.0.0.1:3080`; follow the CLI's authenticated access instructions. Configure a model provider/API key in the UI; see the [upstream docs](https://github.com/deepseek-ai/deepseek-harness).

## Local build

For maintainers: Node.js `>=22.19.0` and pnpm `11.7.0`, as declared in [package.json](<package.json>). The current `@deepseek-ai/dsh` pin is `0.2.1-alpha.1`; the desktop app selects its own compatible core version.

```sh
pnpm install
pnpm start              # Run dsh web using repository dependencies
pnpm build              # Deploy production dependencies to build_dir/
```

`pnpm build` deploys upstream production dependencies to `build_dir/` without rewriting runtime code; `pnpm start` does not run that deployed output. See the [workspace/build policy](<pnpm-workspace.yaml>) for dependency layout and install-script settings.

## Releases and synchronization

Both sync workflows run every **6 hours** and support manual inputs: optional `version` (empty = automatic selection) and `force` (default `false`) to rebuild.

| Workflow | Input / selection | Result |
| --- | --- | --- |
| [release.yml](<.github/workflows/release.yml>) | Required `dsh_version`: an npm version or `latest`; form default `0.1.2-rc.1` is not the current pin. | Six ZIPs + six asar.zips; regular release `dsh-<version>-<run_id>` (`<version>` uses the input verbatim). |
| [sync-release.yml](<.github/workflows/sync-release.yml>) | Highest semver among all published npm versions, covering all dist-tags, not only `latest`. | Calls the npm release workflow; updates `main`'s manifest and lockfile only after successful publication. |
| [release-from-source.yml](<.github/workflows/release-from-source.yml>) | Required `dsh_version` without `dsh-v`; clones the exact `dsh-v<version>` tag and builds/deploys its runtime closure. | Six ZIPs + six asar.zips; pre-release `dsh-src-<version>-<run_id>`; does not update `main`. |
| [sync-source-release.yml](<.github/workflows/sync-source-release.yml>) | Highest upstream GitHub release version newer than the highest npm version. | Calls the source workflow; skips an existing source pre-release unless forced. |

npm preflight [waits for the actual tarball](<scripts/wait-for-npm-version.mjs>) for up to 10 minutes. It then [installs the complete dependency closure](<scripts/check-dsh-installable.mjs>) with `pnpm install --ignore-scripts` and bounded retries before starting the six-target matrix.

Both release paths [prune the output](<scripts/prune-node-modules.mjs>), pack a same-named asar per platform (zipped to `*.asar.zip`), and verify twelve uploaded assets. [Size reports](<scripts/check-artifact-size.mjs>) are informational, not release gates. Windows ARM64 is installed natively on `windows-11-arm`; the x64 ZIP name stays `deepseek-harness-pkg-windows.zip`.

## Linux ARM64 compatibility

Both release paths install and build natively on `ubuntu-24.04-arm` (Ubuntu 24.04, glibc 2.39) with Node.js 22.22.0; they do not cross-compile x64 dependencies. After pruning, they check the architecture, load `koffi`, `sharp`, and `node-pty`, and run the deployed CLI's `web --help` on that runner.

**Kylin V10 / glibc 2.28 is not verified or guaranteed.** Locally compiled native modules inherit the runner's toolchain baseline; upstream prebuilt binaries can have their own glibc / libstdc++ requirements. Installing Node.js alone or rebuilding a single module does not establish compatibility for the whole ZIP. Use a newer supported system, or rebuild and test the complete dependency closure (including prebuilt dependencies) on a matching ARM64/glibc 2.28 environment before deployment. These ZIPs still require an external ARM64 Node.js runtime.

## Runtime compatibility

Local builds and both release paths keep upstream runtime code except for a small patch set in [patches/](<patches/>): the renderer `SlotOutlet` export, the desktop plugin page hiding `dsh-tauri-*` bundles, the sharp WebAssembly shortcut for Electron on Linux, and `@vscode/ripgrep`'s archive-aware binary resolution. These are what the desktop app used to rewrite at launch; baking them in here is what lets a read-only asar core run. Everything else follows the bundled upstream version, so Codex errors may still include raw HTML edge-response bodies; treat error logs as potentially sensitive.

The patches are **not** bound to a dsh version and are not pnpm `patchedDependencies`: each one is an executable module under [patches/](<patches/>) that rewrites the deployed package by anchoring on a short piece of upstream code, and `node scripts/apply-core-patches.mjs --dir=build_dir` runs after the deploy on both release paths. That is deliberate — pnpm patches require a strict line-by-line diff and a `package@version-range` key, so a new upstream release that re-indents or minifies a bundle (0.2.2-rc.2 collapsed `client.js` from 1,884 lines to one) failed the whole install with `ERR_PNPM_PATCH_FAILED`. An anchor that no longer matches now fails the build instead: a patch is never skipped, and a release never ships an unpatched core.

On Linux inside Electron, sharp runs on its WebAssembly build instead of the native addon. Electron's Linux binary links the system GLib and exposes `g_object_*` process-wide, while the prebuilt libvips ships its own static GLib exporting the same symbols; the addon then binds `g_object_unref` to Electron's copy and segfaults in a libuv worker thread ([electron/electron#46323](https://github.com/electron/electron/issues/46323), still open). The shipped `dist/sharp.cjs` therefore loads [`@img/sharp-wasm32`](https://sharp.pixelplumbing.com/install#cross-platform) first when `process.versions.electron` is set on Linux, falling back to the native binary if the WebAssembly build cannot load. Plain Node — the ZIP archives and SSH sessions — keeps the native binary and full performance; `@img/sharp-wasm32` is pruned from the non-Linux artifacts, and the same mechanism covers linux-x64 and linux-arm64 without an architecture-specific binary.

On an asar core, `grep` and `glob` used to fail with `ripgrep provider failure`. Electron's archive filesystem happily reports the packaged `rg` binary as existing, but the operating system cannot execute a path inside a `.asar` file, so `spawn` ended in `ENOENT` ([issue #23](https://github.com/dsh-tauri/deepseek-harness-pkg/issues/23)). [`@vscode/ripgrep`](<patches/vscode-ripgrep.mjs>) only ever resolved that binary through CJS `require.resolve`, which no archive hook can materialize. The patch resolves it through the ESM loader first, so a host that materializes native packages out of the archive hands back a real path; if the resolved path still points into an archive it prefers a `.asar.unpacked` sibling and otherwise copies the binary into a content-addressed directory under the OS temp folder. A plain Node install is untouched: no `.asar` in the path means the resolved path is returned as before.

The WebAssembly build caps its heap at 2 GiB (`WebAssembly.Memory` with `maximum: 32768` pages), so one fully decoded raster has to fit in it: 24,000 × 24,000 RGBA needs 2,197 MiB and fails with `vips_image_write_to_memory: out of memory` instead of decoding. The default `maxImagePixels` of 64 Mpx (256 MiB decoded) stays far below that ceiling; raising it past roughly 500 Mpx makes image admission fail cleanly on Electron for Linux. There is deliberately no fallback to the native addon on that path — loading it is what segfaults, so the error is the intended outcome.

For LAN access, consult the bundled CLI's help for its version-specific flags. Recent upstream releases require one concrete local IPv4 or IPv6 address rather than a wildcard such as `0.0.0.0`; the former LAN opt-in environment variable no longer overrides that policy.

`--trusted-host` limits host trust, not authentication. Keep upstream access credentials private and enable LAN access only on trusted networks.

## Security and use

- For personal learning, research, and testing only; please do not use commercially.
- `dsh` can execute local code: use a trusted, isolated environment and avoid untrusted configurations or plugins.
- LAN exposure increases risk; never expose the service to untrusted networks or share access tokens.
- Developers are not liable for data loss or security issues arising from use.

## Related projects and credits

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream CLI/web/plugin project; [DeepSeek Harness Desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) consumes these bundles as a desktop app.

Thanks to [n8n-pkg](https://github.com/hairyf/n8n-pkg) for the packaging pattern, [pnpm](https://pnpm.io/) for dependency/deploy tooling, and [GitHub Actions](https://github.com/features/actions) for cross-platform builds.

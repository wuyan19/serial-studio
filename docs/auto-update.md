# Serial Studio 在线升级（自动更新）实施方案

> 本方案调研自 `D:\Development\rust\LLM-Switch`（同为 Tauri 2 应用，已落地官方 Updater 插件），并结合 Serial Studio 自身的 workspace 结构、多形态（桌面/Web/远程/headless）与现有发版流程做了适配。
>
> 目标：让**桌面 Tauri 壳**具备「检查更新 → 下载 → 签名校验 → 安装 → 重启」的完整在线升级能力；Web/远程/headless 形态不涉及。

---

## 一、方案选型

| 维度 | 选型 | 说明 |
|---|---|---|
| 更新机制 | `tauri-plugin-updater`（官方） | 不自研，直接用官方插件 |
| 重启能力 | `tauri-plugin-process` | 提供 `relaunch()`，更新安装后重启 |
| 清单托管 | GitHub Releases 的 `latest.json` | 由 `tauri-action` 在 CI 自动生成上传 |
| 安装包托管 | 同一 Release 的各平台安装包 | nsis / appimage / dmg |
| 完整性校验 | minisign 签名（`.sig`） | 插件内置 `minisign-verify`，下载后强制校验 |
| 触发方式 | 手动（关于对话框） | 首期不做启动自检，避免打断用户 |

整体链路（Windows / Linux）：

```
用户点击「检查更新」
   → 前端 check() 请求 endpoints 里的 latest.json
   → 比对 version 与本机 getVersion()
   → 有新版：downloadAndInstall() 下载安装包 + 用 pubkey 校验 .sig
   → 校验通过：替换安装 + relaunch() 重启
```

> macOS 不走自动安装（见下「平台差异化策略」），只到「发现新版」即止，转跳转下载。

### 平台差异化策略（重要：macOS 不自动安装）

经评估，macOS 上要获得顺畅的自动更新，实际需要 Apple Developer 账号（$99/年）做 Developer ID 签名 + 公证；否则未公证 app 被 updater 替换后会被 Gatekeeper 反复拦截（macOS 15 Sequoia 起连右键打开绕过都被移除，到 macOS 26 更严），用户更新完打不开，自动安装形同虚设。

**本项目 macOS 选「不买 Apple Developer」路线**，因此三平台策略不同：

| 平台 | 检查更新 | 自动下载安装 | 发现新版后的入口 |
|---|---|---|---|
| Windows | ✅ | ✅（nsis） | 「下载并重启」 |
| Linux | ✅ | ✅（AppImage） | 「下载并重启」 |
| macOS | ✅ | ❌（跳过） | 「前往下载」（打开 Release 页） |

- macOS 仍保留 `check()`：只请求 `latest.json` 比对版本，不碰文件、不触发 Gatekeeper，让用户知道有新版。
- macOS 发现新版后**不调用** `downloadAndInstall()`，只显示「前往下载」按钮，引导用户到 GitHub Release 手动下 dmg。
- 前端用 `@tauri-apps/plugin-os` 判定平台，决定走哪条路径（见 §5）。

> 后续若改变主意购入 Apple Developer，只需在 CI 加 `APPLE_*` 签名 secret + 把 macOS 的 `supportsAutoInstall` 放开，即可平滑切到自动安装——前端分流逻辑已为此预留。

---

## 二、与 LLM-Switch 的关键差异（迁移必读）

LLM-Switch 是标准 Tauri 脚手架（`src-tauri/` + `src/`）、纯桌面单形态。Serial Studio 不一样，以下差异决定我们不能照抄，必须适配：

| 项 | LLM-Switch | Serial Studio | 影响 |
|---|---|---|---|
| 目录结构 | `src-tauri/` + `src/` | workspace：`crates/tauri-app/`（Rust）+ `ui/`（前端） | 所有配置/依赖路径要改 |
| 版本号同步 | 3 处 + `bump-version.mjs` 脚本 | **4 处，手动同步，无脚本** | 见「发版流程」，必须对齐 CLAUDE.md |
| 形态 | 纯桌面 | 桌面壳 + Web 浏览器 + 远程窗口 + headless | updater **仅桌面本地模式**启用，见「前端改造」 |
| Linux 打包 | `appimage` | **`deb`（不支持自动更新！）** | 必须改 `appimage`，见「CI 改造」 |
| tauri-action | `@v0` | `@v1`（更新） | 保持 v1，行为一致 |
| Release | `releaseDraft: false` 直发 | `releaseDraft: true` + 人工写 note 后发布 | updater 依赖 release 成为「latest」，见「发版时序」 |
| capabilities | 分 `default.json` + `desktop.json` | 单个 `default.json` | Serial Studio 无移动端目标，直接加到 `default.json` |
| 入口位置 | 「全局设置 → 关于」面板 | 已有 `AboutDialog` 组件 | 直接在 `AboutDialog` 内加 UI |

---

## 三、前置：生成签名密钥（一次性）

Tauri 2 的 updater 强制签名校验。先在本机生成一对 minisign 密钥：

```bash
# 生成 minisign 密钥对（tauri CLI 子命令）。设密码、记牢，丢了就无法再给老版本推可校验更新。
cargo tauri signer generate -w ~/.tauri/serial-studio.key
```

> ⚠️ **Windows / PowerShell 坑**：`~` 在 PowerShell **不展开**，上面这条会把密钥落到仓库根的字面量 `~` 目录（有被 `git add .` 误入库的风险！）。Windows 上务必用 `$env:USERPROFILE` 或绝对路径：
> ```powershell
> cargo tauri signer generate -w "$env:USERPROFILE\.tauri\serial-studio.key"
> ```
> 生成后 `.key.pub` 文件内容即 `tauri.conf.json` 的 `pubkey` 值（base64 串，以 `dW50...` 开头），**直接整行复制粘贴**，不要再 base64 编码一次。

产出：

- **公钥**（base64 串）→ 粘进 `tauri.conf.json` 的 `plugins.updater.pubkey`
- **私钥文件内容** + **密码** → 配成 GitHub Repo Secrets：
  - `TAURI_SIGNING_PRIVATE_KEY`（私钥文件全文）
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密码）

> ⚠️ 私钥**绝不入库**。生成后把 `~/.tauri/serial-studio.key` 妥善备份，丢了就无法再给老版本推送可校验的更新。

---

## 四、后端（Rust）改造

### 4.1 加依赖 — `crates/tauri-app/Cargo.toml`

在 `[dependencies]` 段加四个插件：

```toml
[dependencies]
# ... 现有依赖 ...
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tauri-plugin-os = "2"          # 平台判定（macOS 不自动安装，见「平台差异化策略」）
tauri-plugin-opener = "2"      # 打开 Release 页（macOS / 更新失败回退）
```

> LLM-Switch 用 `cfg(not(any(target_os = "android", target_os = "ios")))` 做平台门控。Serial Studio 无移动端目标，可直接无条件引入。

### 4.2 配置 — `crates/tauri-app/tauri.conf.json`

两处改动：

**(1) `bundle` 段加 `createUpdaterArtifacts: true`**（Tauri 2 必选项，否则 `tauri build` 不产出 `.sig`，updater 校验必然失败）：

```jsonc
"bundle": {
  "active": true,
  "targets": ["nsis", "msi", "dmg", "appimage"],   // deb → appimage，见 §六说明
  "createUpdaterArtifacts": true,                  // 新增：产出 .sig 签名文件
  "icon": [ /* ... */ ]
}
```

**(2) 顶层新增 `plugins.updater`**（公钥填上一步生成的；endpoint 用本仓库地址）：

```jsonc
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...(你的公钥 base64)",
    "endpoints": [
      "https://github.com/wuyan19/serial-studio/releases/latest/download/latest.json",
      "https://ghproxy.net/https://github.com/wuyan19/serial-studio/releases/latest/download/latest-mirror.json"
    ]
  }
}
```

> **双清单策略**：endpoints 只作用于「拉清单」，安装包下载地址是清单里每平台唯一的 `url` 字段（无多址回退）——所以让**下载路由随清单走**：`latest.json` 恒为 github 直连 url（endpoints[0] 拉到它的客户端，下载也直连）；`latest-mirror.json` 是 ghproxy 前缀 url 版（endpoints[1] 兜底拉到它的客户端，下载也走镜像）。updater 按数组顺序尝试 endpoint，主站不可达才回落镜像。两份清单由 release.yml 的 `updater-manifests` job 发版时生成上传。镜像故障只影响必须走镜像的用户，能直连/走代理的用户不受牵连（2026-08 ghproxy.net 证书过期曾致全体下载中断——当时单清单统一改写镜像 url 的教训）。
> ⚠️ 注意 endpoints 是**烧进已发布客户端**的：老版本客户端的两条 endpoint 都读 `latest.json` 这一个文件，改清单内容只能惠及其中一个人群。

### 4.3 权限 — `crates/tauri-app/capabilities/default.json`

加 `updater:default`、`process:default`、`os:default`、`opener:default` 四个权限（Serial Studio 单 capabilities 文件，无需像 LLM-Switch 那样拆 `desktop.json`）：

```jsonc
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "默认权限：仅核心能力，无文件系统/Shell 等敏感权限",
  "windows": ["*"],
  "permissions": [
    "core:default",
    "core:event:default",
    "updater:default",
    "process:default",
    "os:default",
    "opener:default"
  ]
}
```

> 权限只作用于 Tauri 壳的 webview。Web 浏览器形态不走 Tauri capabilities，不受影响。

### 4.4 注册插件 — `crates/tauri-app/src/main.rs`

在 `run_gui()` 的 `tauri::Builder::default()` 链上、`.on_window_event(...)` 之前注册四个插件：

```rust
fn run_gui() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())        // 提供 platform()，前端据此判定 macOS
        .plugin(tauri_plugin_opener::init())    // 打开 Release 页（macOS / 失败回退）
        .on_window_event(|window, event| { /* ... 原有 ... */ })
        .setup(|app| { /* ... 原有 ... */ })
        // ...
}
```

> endpoints / pubkey 都来自 `tauri.conf.json`，`Builder::new().build()` 用默认配置即可，无需在此传参。无需新增任何 `#[tauri::command]`——更新逻辑全在前端直连插件 API（与 LLM-Switch 一致）。
>
> **headless 路径（`run_headless`）不注册这两个插件**——headless 是后台服务，没有 GUI 也不需要自更新入口。

---

## 五、前端（UI）改造

### 5.1 加依赖 — `ui/package.json`

```jsonc
"dependencies": {
  // ... 现有 ...
  "@tauri-apps/plugin-updater": "^2.10.0",
  "@tauri-apps/plugin-process": "^2.3.1",
  "@tauri-apps/plugin-os": "^2.2.0",           // 平台判定：macOS 不自动安装
  "@tauri-apps/plugin-opener": "^2.2.0"        // 打开 Release 页（macOS / 失败回退）
}
```

随后 `npm install --prefix ui`（顺带更新 `ui/package-lock.json`，纳入版本号同步范围）。

### 5.2 仅桌面本地模式启用（多形态适配，关键）

Serial Studio 的 Transport 三态见 `ui/src/transport.ts::createTransport`：

- 远程窗口（`?remote=host:port`）→ WS，连的是**远程设备**
- Tauri 且非远程 → IPC（**本地模式**）
- 否则 → Web（浏览器）

**只有「Tauri 且非远程」这一态才有本机 updater 的意义**：

- Web 浏览器形态：没有 Tauri runtime，插件 API 不可用。
- 远程窗口：用户在操作远程设备，本机的 app 版本与之无关，更新入口会误导。

因此更新 UI 的渲染条件要用 `lib.ts` 的现成判定：

```ts
import { isTauri } from "./lib";

/** Tauri 且窗口非远程（URL 无 ?remote=）。Web/远程窗口无本机 updater 意义。 */
export function isLocalDesktop(): boolean {
  if (!isTauri()) return false;
  return !/[?&]remote=/.test(window.location.search);
}
```

`AboutDialog` 只在 `isLocalDesktop()` 为真时渲染「检查更新」区块。

### 5.3 更新逻辑（新建 `ui/src/updater.ts`）

集中封装检查/下载/重启，返回状态供 UI 渲染：

```ts
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | "idle" | "checking" | "upToDate" | "available"
  | "downloading" | "downloadComplete" | "failed";

export interface UpdateStatus {
  state: UpdateState;
  version?: string;   // 新版本号
  notes?: string;     // 更新说明（latest.json 的 notes）
  percent?: number;   // 下载进度
  message?: string;   // 失败时的错误信息
}

/** 手动检查更新。返回 Update 对象供后续下载使用。 */
export async function checkUpdate(): Promise<{ status: UpdateStatus; update: Update | null }> {
  try {
    const update = await check();
    if (update) {
      return {
        status: { state: "available", version: update.version, notes: update.body },
        update,
      };
    }
    return { status: { state: "upToDate" }, update: null };
  } catch (e) {
    return { status: { state: "failed", message: String(e) }, update: null };
  }
}

/** 下载并安装（带进度回调），完成后重启。 */
export async function downloadAndInstall(
  update: Update,
  onProgress: (percent: number) => void,
): Promise<UpdateStatus> {
  try {
    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          onProgress(0);
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            onProgress(Math.round((downloaded / contentLength) * 100));
          }
          break;
        case "Finished":
          break;
      }
    });
    await relaunch();   // 校验通过 + 安装完成 → 重启
    return { state: "downloadComplete" };
  } catch (e) {
    return { state: "failed", message: String(e) };
  }
}
```

进度回调事件为 `"Started" | "Progress" | "Finished"`：`Started` 带 `contentLength`（总字节），`Progress` 带 `chunkLength`（本块字节），累加算百分比。

**平台判定（macOS 不自动安装）**：文件顶部再加一行 import，并导出判定函数：

```ts
import { platform } from "@tauri-apps/plugin-os";

/** 当前平台是否支持自动下载安装。macOS 未公证 → 不自动安装，仅跳转下载。 */
export function supportsAutoInstall(): boolean {
  return platform() !== "macos";
}
```

UI 据此决定：发现新版后 `supportsAutoInstall()` 为真显示「下载并重启」，为假（macOS）显示「前往下载」。

### 5.4 UI — `ui/src/components.tsx` 的 `AboutDialog`（约 2366 行）

`AboutDialog` 已显示「版本 {version}」，在其下方加更新区块。结构示意（样式复用现有 `.about__*` 风格，进度条新增 `.about__progress` / `.about__progress-fill`）：

```tsx
export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [update, setUpdate] = useState<Update | null>(null);
  const localDesktop = isLocalDesktop();   // 仅桌面本地模式渲染

  async function onCheck() {
    setStatus({ state: "checking" });
    const { status, update } = await checkUpdate();
    setStatus(status);
    setUpdate(update);
  }

  async function onInstall() {
    if (!update) return;
    setStatus({ state: "downloading", percent: 0 });
    const s = await downloadAndInstall(update, (p) =>
      setStatus({ state: "downloading", percent: p }));
    setStatus(s);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="about" onClick={(e) => e.stopPropagation()}>
        {/* ... 现有 mark / name / version / tagline ... */}

        {localDesktop && (
          <div className="about__update">
            {status.state === "idle" && (
              <button className="about__btn" onClick={onCheck}>检查更新</button>
            )}
            {status.state === "checking" && <span>检查中…</span>}
            {status.state === "upToDate" && <span>已是最新版本</span>}
            {status.state === "available" && (
              <div>
                <p>发现新版本 {status.version}</p>
                {supportsAutoInstall() ? (
                  <button className="about__btn" onClick={onInstall}>下载并重启</button>
                ) : (
                  /* macOS 未公证：自动安装后 Gatekeeper 拦到打不开 → 只引导手动下载 */
                  <button className="about__btn" onClick={() => openReleasesPage()}>前往下载</button>
                )}
              </div>
            )}
            {status.state === "downloading" && (
              <div>
                <div className="about__progress">
                  <div className="about__progress-fill" style={{ width: `${status.percent ?? 0}%` }} />
                </div>
                <span>下载中 {status.percent ?? 0}%</span>
              </div>
            )}
            {status.state === "failed" && (
              <div>
                <p>更新失败：{status.message}</p>
                <button className="about__btn" onClick={() => openReleasesPage()}>
                  前往下载
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

**失败回退 / macOS 跳转下载**：用 `tauri-plugin-opener` 的 `openUrl()` 打开 Release 页——更新失败（网络/签名）时引导手动下载，macOS 发现新版时也走这个入口（不自动安装）。本项目封装为 `updater.ts::openReleasesPage()`，前端只调它、不直接碰 opener API；后端注册 `tauri_plugin_opener::init()` 即可，**无需自定义 command**。

---

## 六、CI/CD 改造 — `.github/workflows/release.yml`

### 6.1 注入签名密钥

`tauri-apps/tauri-action` 步骤的 `env` 加两行（值来自 §三配的 Secrets）：

```yaml
- uses: tauri-apps/tauri-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  with:
    projectPath: crates/tauri-app
    tagName: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}
    releaseName: "Serial Studio ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}"
    releaseBody: "..."
    releaseDraft: true
    prerelease: false
    args: ${{ matrix.args }}
```

tauri-action 检测到 `TAURI_SIGNING_PRIVATE_KEY` + `createUpdaterArtifacts: true`，会**自动产出各平台 `.sig` 并生成 `latest.json` 上传到该 Release**。

### 6.2 Linux 改 AppImage（deb 不支持自动更新）

**关键**：Tauri updater 在 Linux 上**只支持 AppImage**。Serial Studio 现在 Linux 打 `deb`，用户无法在线更新。需把矩阵里 ubuntu 的 `args` 收窄为 appimage：

```yaml
matrix:
  include:
    - platform: macos-latest
      args: "--target aarch64-apple-darwin"
    - platform: macos-latest
      args: "--target x86_64-apple-darwin"
    - platform: ubuntu-22.04
      args: "--bundles appimage"      # 原 "" → 改为只打 appimage（可更新）
    - platform: windows-latest
      args: ""
```

> 若仍想保留 `deb` 给包管理器用户，可同时打 `--bundles appimage,deb`，但 `latest.json` 的 `linux-x86_64` 条目会指向 appimage（可更新那份）。deb 用户走包管理器手动升级。

### 6.3 Windows 的 nsis/msi 选择（可选优化）

Serial Studio 现打 `["nsis", "msi"]`。`latest.json` 的 `windows-x86_64` 只有一个 `url`，tauri-action 默认会选其一。为确定性地让 updater 走 nsis（体积小、更新体验好），可加 tauri-action 参数：

```yaml
with:
  # ...
  updaterJsonPreferNsisLazyDownload: true   # Windows 更新优先 nsis 懒下载
```

> 不加也能用，默认行为通常取 nsis。加上更确定。msi 仍会作为独立资产上传，供需要 msi 的企业部署场景手动下载。

### 6.4（可选）并发 latest.json 抢写

四平台矩阵并行，各自上传/合并 `latest.json`，偶发互相覆盖导致清单不完整。若线上遇到「检查更新失败、重试又好了」，加：

```yaml
with:
  updaterJsonPreferTagName: true
```

让它按 tag 名写清单，降低并发冲突。LLM-Switch 当前未用此参数、靠默认行为也能跑，属可选项。

---

## 七、版本号与发版流程

### 7.1 版本号四处同步（对齐 CLAUDE.md，无 bump 脚本）

每个版本需手动同步**四处**：

1. `Cargo.toml`（`workspace.package.version`）
2. `crates/tauri-app/tauri.conf.json`（`version`）
3. `ui/package.json`（`version`，顺带 `ui/package-lock.json`）
4. `Cargo.lock`（改 workspace version 后 `cargo check` 自动更新）

> ⚠️ updater 用 `latest.json.version` 与本机 `getVersion()` 比对。**tauri-action 的 `tagName`/`releaseName` 用 `github.ref_name`（即 tag），而 `latest.json.version` 来自 `tauri.conf.json`**。若这几处不一致，会出现「明明发布了新版，app 却说已是最新」的误判。务必四处齐平，且 tag 号与 `tauri.conf.json` 的 version 一致（`v0.7.0` ↔ `0.7.0`）。

### 7.2 发版时序（draft 流程与 updater 的关系）

Serial Studio 的发版流程（见 CLAUDE.md）：构建 → **DRAFT release** → 人工写 release note → `gh release edit --draft=false` 发布。

updater 的 endpoint 是 `releases/latest/download/latest.json`，而 `releases/latest` 指向**最新的非 draft、非 prerelease 的 release**。因此时序为：

```
推 v* tag → CI 构建 + 建 DRAFT release（含 latest.json/.sig/安装包）
         → 此时 releases/latest 仍指向上一个正式版，用户检查不到新版 ✅
人工 gh release edit <tag> --notes-file <file>   # 写 release note
人工 gh release edit <tag> --draft=false          # 发布
         → 此刻该 release 成为 latest，旧版 app 才能检查到更新 ✅
```

**这与现有 draft 流程完全兼容**：只要遵循「先写 note 再发布」的既有节奏，发布瞬间用户即可收到更新。无需为 updater 改流程。

> tag 必须是 annotated 且显式 push（`git tag -a v0.x.y -m "v0.x.y"` + `git push origin v0.x.y`），否则 CI 不触发——这是 CLAUDE.md 已记录的坑，延续即可。

---

## 八、坑与注意事项汇总

1. **Linux deb 不支持自动更新** → 必须改 AppImage（§6.2）。
2. **`createUpdaterArtifacts: true` 必加**（Tauri 2 与 Tauri 1 的差异）→ 不加则无 `.sig`，校验必败。
3. **仅桌面本地模式启用更新 UI**（§5.2）→ Web/远程窗口不渲染，避免误导。
4. **endpoint 可达性与下载路由** → GitHub 在国内不稳定，配 `ghproxy.net` 镜像兜底。下载无多址回退，用**双清单**（`latest.json` 直连 + `latest-mirror.json` 镜像前缀，endpoints[1] 指向后者）让下载地址随清单走——镜像故障只影响必须走镜像的用户，不绑架能直连/走代理的用户（§4.2）。
5. **版本号四处 + tag 必须齐平**（§7.1）→ 不齐会导致检查更新误判。
6. **headless 不注册 updater 插件**（§4.4）→ 后台服务无需自更新入口。
7. **私钥不入库、妥善备份** → 丢失则无法再向老版本推送可校验更新。
8. **macOS 未签名/未公证 → 本方案不做自动安装**。未公证 app 不仅首次安装要 `xattr -cr`，updater 替换 `.app` 后 Gatekeeper 会重新拦截（macOS 15 Sequoia 起右键绕过已移除），用户更新完打不开。故 macOS 只做「检查更新 + 跳转 GitHub 手动下载」，不调 `downloadAndInstall()`（见「平台差异化策略」）。README 仍需注明首次安装的 `xattr -cr`。
9. **首期不做启动自检** → LLM-Switch 的启动自检代码是「就位但未接线」的半成品，本方案只做关于对话框手动检查，避免打断用户；后续如需启动自检，补一个挂载时 `check()` 的 `useEffect` + 跳过版本 localStorage 即可。
10. **更新失败要可回退** → catch 后调 `openReleasesPage()` 打开浏览器引导手动下载（§5.4）。

---

## 九、验收清单

- [ ] 本地 `cargo tauri dev` 正常，关于对话框在本地模式显示「检查更新」
- [ ] 远程窗口（`?remote=`）与 Web 浏览器形态**不显示**更新入口
- [ ] `cargo tauri build` 产出各平台 `.sig` 签名文件
- [ ] CI 发版后，Release 资产含 `latest.json` + 各平台 `.sig` + 安装包
- [ ] `latest.json` 的 `version` 与 tag 一致；`platforms` 各键有 `url` + `signature`
- [ ] 旧版本能检查到新版、显示新版本号与说明、下载（进度条正确）、校验通过、安装、自动重启为新版本
- [ ] 篡改安装包后校验失败、流程中止（验证签名生效）
- [ ] 网络断开/endpoint 不可达时，显示失败 + 「前往下载」回退，不崩溃
- [ ] Linux 产物为 AppImage 且可更新
- [ ] macOS：能检查到新版并显示「前往下载」（**不出现**「下载并重启」），点击打开 Release 页
- [ ] 版本号四处 + Cargo.lock + tag 齐平

---

## 十、分阶段实施建议

- **P0（产出可更新包）**：后端改造（§4）+ CI 改造（§6）+ 密钥（§3）。完成后发版即产出可被校验的安装包与清单。
- **P1（前端手动更新）**：前端改造（§5）。关于对话框可检查/下载/重启。这是面向用户的最小可用版本。
- **P2（可选，体验增强）**：启动后台静默检查 + 发现新版时角标/横幅提示 + 「跳过此版本」。参照 LLM-Switch 已就位但未接线的启动自检代码补全。

---

## 附：改动文件清单

| 文件 | 改动 |
|---|---|
| `crates/tauri-app/Cargo.toml` | + `tauri-plugin-updater`、`process`、`os`、`opener` |
| `crates/tauri-app/tauri.conf.json` | + `bundle.createUpdaterArtifacts`、`plugins.updater`；deb→appimage |
| `crates/tauri-app/capabilities/default.json` | + `updater:default`、`process:default`、`os:default`、`opener:default` |
| `crates/tauri-app/src/main.rs` | `run_gui()` 注册四个插件（无需自定义 command） |
| `ui/package.json` (+lock) | + `plugin-updater`、`process`、`os`、`opener` |
| `ui/src/updater.ts` | 新建：检查/下载/重启 + `supportsAutoInstall`/`isLocalDesktop`/`openReleasesPage` |
| `ui/src/components.tsx` | `AboutDialog` 加更新 UI（仅本地桌面渲染，macOS 分流到「前往下载」） |
| `ui/src/styles.css` | 进度条样式（`.about__progress*`） |
| `.github/workflows/release.yml` | + 签名 env；Linux→appimage；可选 NSIS/manifest 参数 |
| GitHub Repo Secrets | + `TAURI_SIGNING_PRIVATE_KEY`、`..._PASSWORD` |

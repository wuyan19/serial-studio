# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Serial Studio 是一个多形态串口终端——桌面、Web、远程三态共用同一套 Rust 核心。Tauri 2 + Rust(edition 2021) + React 18 + xterm.js。代码注释为中文,回复与新增注释请沿用中文。

## 常用命令

```bash
# 开发(热重载前端 + 编译 Rust)。tauri.conf.json 的 beforeDevCommand 会自动起 vite
cargo tauri dev

# 发布构建(产物 serial-studio.exe / .dmg / .deb)
cargo tauri build

# 仅前端(ui/)——tauri dev 已自动拉起,这里用于单独调试 UI
npm install --prefix ui
npm run dev --prefix ui      # vite dev server (5173)
npm run build --prefix ui    # 产 ui/dist,rust-embed 编译期打入二进制

# Headless(无窗口后台服务):WS 18700 / Telnet 18701
cargo run -p ss-server                          # 独立 server bin
cargo run -p ss-tauri -- --no-gui               # 同一 Tauri 壳的 headless 模式

# 测试——核心逻辑单测集中在 ss-core(注入 FakeOpener/FakePort,不碰真实硬件)
cargo test                       # 全 workspace
cargo test -p ss-core            # 单 crate
cargo test -p ss-core acquire_first_opens    # 单个测试
cargo check                      # 快速类型检查
```

> 注意:`cargo tauri` 命令针对 `crates/tauri-app`(release.yml 用 `projectPath: crates/tauri-app`)。从仓库根目录跑 `cargo tauri dev/build` 依赖 Tauri CLI 自动定位配置;若失败,进 `crates/tauri-app` 再跑。

### 发版

版本号需手动同步**三处**(无 bump 脚本):`Cargo.toml`(workspace.package)、`crates/tauri-app/tauri.conf.json`、`ui/package.json`(顺带 `ui/package-lock.json`)。

推 `v*` tag 触发 `.github/workflows/release.yml`(4 矩阵:mac aarch64/x64、ubuntu、windows),tauri-action 建 **DRAFT** release。绿后用 `gh release edit <tag> --draft=false` 发布。**坑**:`git push --follow-tags` 只推 annotated tag,lightweight tag(`git tag v0.x.y` 不带 `-a`/`-m`)会被静默跳过、CI 不触发。必须 `git tag -a v0.x.y -m "v0.x.y"` 且显式 `git push origin v0.x.y`。发布是 outward 动作,需用户明确授权后再执行。

## 架构

### 控制面 / 数据面分离(最核心的设计原则)

- **控制面**(Tauri IPC,`crates/tauri-app/src/main.rs`):配置、服务生命周期、别名与宏的持久化。
- **数据面**(axum,`crates/server`):WS / MCP / Telnet,全是同一 `SerialManager` + `EventBus` 之上的 adapter。

改数据流向时,三处接入(WS / Tauri IPC / Telnet)应共用 core 接口,不要在某一 adapter 里私藏串口逻辑。

### 三个 crate

| Crate | 职责与边界 |
|---|---|
| `ss-core` (`crates/core`) | 多串口管理引擎。端口占有权、RX 缓冲区、宏执行。**纯运行时——不依赖 axum/clap/tauri,不碰持久化与 UI**,以此保持可测试性。新增此类依赖是回归。 |
| `ss-server` (`crates/server`) | axum WS/MCP/Telnet + 内嵌 SPA(`rust-embed` 打包 `ui/dist`)。lib + headless bin 双形态,被 Tauri 壳与独立 `ss-server` 共用——"一份后端,两种宿主"。持久化 stores(settings/port_meta/macros)在此层。 |
| `serial-studio` (`crates/tauri-app`) | Tauri 壳=控制面。`ServiceSupervisor` 管数据面启停。本地模式下 Tauri IPC 与 axum WS 是同一 core 域的两个出口。 |

### 串口占有权模型(session 引用计数)

`SessionId` = 一条 WS 连接或一个 Tauri 窗口的身份(`crates/core/src/types.rs`,进程内自增)。

- `acquire`:首持有者真正打开端口(其 config 生效);后续持有者**附加**(请求的 config 被忽略)。慢路径打开后有 **TOCTOU 重检**,避免并发 acquire 泄漏 OS 句柄或互相覆盖 handle。
- `release`:非末位保持端口(发 `HoldersChanged`),末位才拆毁。断连/关窗走 `release_all`。
- `force_close_others`:仅本地 UI 特权,踢掉非本地持有者(远程 WS)并经 Kicked 事件断开其连接,本地窗口保留;全远程或末位时拆毁端口。

详见 `manager.rs` 单测(`concurrent_acquire_one_opens_one_attaches_no_leak` 守住"并发不产生重复端口任务"不变量)。

### 每端口一 task(Actor 模式)

`port_task.rs`:每个串口一个独立异步任务。读/写用 `try_clone` 分离 handle(全双工,两把独立 Mutex 不互斥);读循环在 `spawn_blocking` 内持续 blocking read(5ms 匀化节奏降低 IPC 抖动)。读到数据既 `publish` 到 EventBus(前端),又 push 到 `RxBuffer`(MCP/宏)。对外接口只有 `command_tx`(命令模式,同端口天然单写者)。

### EventBus —— 一个数据源,多个出口

`tokio::broadcast`:`DataReceived` 的 data 会 clone 给每个订阅者。**同一 EventBus 有两个出口**——`ws.rs`(转发给 WS 客户端)和 `tauri-app/src/main.rs::spawn_event_emitter`(转发给本地 Tauri 前端)。改事件结构两侧都要同步。另有独立的 `meta_bus` 广播别名等元数据变更(不进 core 的 `SerialEvent`,因为是用户配置变更而非串口硬件事件)。

### 数据帧与快路径

- **WS**:控制消息走 Text(JSON),串口数据走 Binary 帧 `[port_len:u8][port UTF-8][data]`。编码在 `ws.rs::data_frame`,解码在 `ui/src/transport.ts::decodeDataFrame`——**两处必须同步**。
- **Tauri IPC 本地模式**:per-(window,port) `Channel` 二进制直传,跳过合批以降延迟(注释里标为 A/B 对照)。

### 发送/换行逻辑(集中、勿复制)

text 模式自动追加换行的逻辑**只此一处**:`ss-core::macros::encode_send` + `SerialManager::send`。宏与 MCP 共用此入口。**透传的 WS/Telnet 不经过这里**(交互输入不自动加换行)。新增发送路径请复用,不要另写一套换行处理。

### 前端 Transport 抽象(`ui/src/transport.ts`)

`Transport` 接口屏蔽 IPC/WS 协议差异,组件只懂领域(port/bytes/macro)。`LocalTransport`(Tauri invoke + event)与 `RemoteTransport`(WS)两实现,`createTransport()` 按模式选择:远程窗口(`?remote=host:port`)→ WS;Tauri 且非远程 → IPC;否则 Web → WS。模式判定见 `lib.ts::isTauri`/`getRemoteFromUrl`。

### 持久化(三个 JSON,都在 exe 同目录)

| 文件 | 内容 | 归属 |
|---|---|---|
| `settings.json` | 监听地址 / WS 端口 / Telnet 端口 | 端口所在机器 |
| `ports.json` | 端口元数据(别名,强制唯一去重) | 端口所在机器;core 只出 `PortInfo` 运行时事实,别名由 server 层 `PortView`(`serde(flatten)`)组合 |
| `macros.json` | 宏 | 桌面端走 Tauri command;Web 端存浏览器 localStorage(`lib.ts::persistMacros`) |

别名写入的唯一入口是 `set_alias_and_notify`(写 ports.json + 发 meta_bus)。`PortView` 的 `serde(flatten)` 契约要求线上 JSON 扁平为 `{name,opened,holders,alias?}`——改 `PortInfo`/`PortView` 字段要顾全前端 `PortInfo` 接口。

## 关键不变量(改代码时守住)

- **`ss-core` 零 UI/服务依赖**——保可测试性。
- **`AppState` 跨 `ServiceSupervisor` 重启保留**,只换 listener(热重启不丢串口连接/宏)。
- **WS 出站必须经 `RemoteTransport.send()`(await open)**,禁止裸 `ws.send`——CONNECTING 态会抛 `InvalidStateError`。
- **数据帧 layout** 和 **换行逻辑** 各自只有一处定义,改一处要找另一处。
- 服务器默认绑 `0.0.0.0` 且**无认证**——任何人可达即可开/发/读串口。安全相关改动需顾及此默认。

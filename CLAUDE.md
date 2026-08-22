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

# 前端——纯函数/reducer 单测(vitest):pane-tree / lib / shortcuts / store
npm test --prefix ui
npx tsc --noEmit --prefix ui     # 严格类型检查(vite build 会吞部分错误,以此为准)
```

> 注意:`cargo tauri` 命令针对 `crates/tauri-app`(release.yml 用 `projectPath: crates/tauri-app`)。从仓库根目录跑 `cargo tauri dev/build` 依赖 Tauri CLI 自动定位配置;若失败,进 `crates/tauri-app` 再跑。

### 发版

版本号同步**四处**,用仓库根 `bump-version.mjs` 一键完成:`node bump-version.mjs 0.7.1` 改 `Cargo.toml`(workspace.package)、`crates/tauri-app/tauri.conf.json`、`ui/package.json`(+`ui/package-lock.json`),并跑 `cargo check` 更新 `Cargo.lock`(workspace 成员 version 跟着变,需一起提交)。脚本无敏感信息、入库共享。本地签名构建用 `build-signed.mjs`(含密码、gitignore 不入库)。

推 `v*` tag 触发 `.github/workflows/release.yml`(4 矩阵:mac aarch64/x64、ubuntu、windows),tauri-action 建 **DRAFT** release(正文仅占位)。绿后**先写 release note**:`gh release edit <tag> --notes-file <file>`,按主题(✨新功能 / 🔧改进 / 🐛修复)组织 `v<上版本>..v<本版本>` 的改动写给用户看,而非罗列 commit;再 `gh release edit <tag> --draft=false` 发布。**坑**:`git push --follow-tags` 只推 annotated tag,lightweight tag(`git tag v0.x.y` 不带 `-a`/`-m`)会被静默跳过、CI 不触发。必须 `git tag -a v0.x.y -m "v0.x.y"` 且显式 `git push origin v0.x.y`。发布是 outward 动作,需用户明确授权后再执行。

## 架构

### 控制面 / 数据面分离(最核心的设计原则)

- **控制面**(Tauri IPC,`crates/tauri-app/src/main.rs`):配置、服务生命周期、别名与宏的持久化。
- **数据面**(axum,`crates/server`):WS / MCP / Telnet,全是同一 `SerialManager` + `EventBus` 之上的 adapter。

改数据流向时,三处接入(WS / Tauri IPC / Telnet)应共用 core 接口,不要在某一 adapter 里私藏串口逻辑。

### 三个 crate

| Crate | 职责与边界 |
|---|---|
| `ss-core` (`crates/core`) | 多串口管理引擎。端口占有权、RX 缓冲区、宏执行、**PortIo 抽象**(本地串口实现)。**纯运行时——不依赖 axum/clap/tauri,不碰持久化、UI 与网络**(远程端口实现 `RemotePortIo` 在 server 层),以此保持可测试性。新增此类依赖是回归。 |
| `ss-server` (`crates/server`) | axum WS/MCP/Telnet + 内嵌 SPA(`rust-embed` 打包 `ui/dist`)+ **远程设备连接层 `device/`**(DeviceClientManager)。lib + headless bin 双形态,被 Tauri 壳与独立 `ss-server` 共用——"一份后端,两种宿主"。持久化 stores(settings/port_meta/macros/scripts/remotes)在此层。 |
| `serial-studio` (`crates/tauri-app`) | Tauri 壳=控制面。`ServiceSupervisor` 管数据面启停。本地模式下 Tauri IPC 与 axum WS 是同一 core 域的两个出口。 |

### PortIo 与端口复合键(远程串口的根基)

- **`PortIo`**(`core/src/port_io.rs`):全双工字节通道窄 trait(`Read + Write + Send + try_clone`)。read 的 TimedOut=空闲续轮、非 TimedOut=断开(触发 drainer)——语义与 serialport 阻塞读对齐,manager/port_task 不感知传输介质。本地实现 `SerialPortIo`(core);远程实现 `RemotePortIo`(server 层 `device/port_io.rs`,推→拉缓冲 + 命令通道写)。未来 TCP raw / RFC 2217 / BLE 实现同一 trait 即可接入。
- **复合键**:`${devId}::${portName}`(`local::COM3` / `uuidB::local::COM3`)。compose/split/normalize 三函数在 `core/src/types.rs` 单一定义;**split 只剥首段、后缀整体透传**——多级级联(A 注册 B、B 注册 C)逐层路由无特判。manager 所有端口入口 normalize(map 键恒规范单一形态,裸名与复合键指向同一条目)。**事件 `port` 字段恒为 manager map 键**(与 IO 层远端线名解耦)。
- **组装点** `create_state()`(server/src/lib.rs):注入 `CompositeOpener`(local → serial::open;非 local → DeviceClientManager,**阻塞同步,在 acquire 的 spawn_blocking 里调**)。
- **DeviceClientManager**(server/src/device/):每注册设备一条 WS(读 remotes.json,eager 连接,退避重连,协议层 Ping 心跳 10s/20s,断连积压命令在新会话开始时丢弃),挂 AppState 跨热重启保留,`start()` 惰性幂等(supervisor.start 触发)。断连=USB 拔插:RemotePortIo read 返 Err → drainer 标 disconnected 保占有权 → reopen 走新连接。**防环=list 合并的透传深度限 1**:远端桶只收远端自己的口(线名首段 local),丢弃远端的远端桶——否则自连/互注册时列表每轮上报自我复制(回声环,4→8→12…直至消息风暴拖死进程)。自连(把本机地址注册为远程设备)因此成为合法形态:本地口的远程镜像,open 路由回本机(附加到同一端口的占有权)。多级级联的口在所在设备自己的 UI 看(路由仍逐层透传,仅列表不展示)。
- **list 合并**(server/src/lib.rs::list_ports_with_meta):本地桶(manager 枚举 + 本地别名)⊕ 远端桶(DeviceClient 缓存的远端 PortView 透传,**远端别名归端口所在机器**)⊕ 本地占有权快照覆盖(opened/holders/disconnected 以本地为唯一真相)。

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

- **WS**:控制消息走 Text(JSON),串口数据走 Binary 帧 `[port_len:u8][port UTF-8][data]`。消息词典与编解码在 `server/src/protocol.rs`(单一定义,ws.rs 出口与 DeviceClient 设备客户端共用);JS 对侧 `ui/src/transport.ts::decodeDataFrame`——**两处必须同步**。Ok/Error 消息带可选 `port` 字段(设备客户端回执路由用,旧客户端忽略)。
- **Tauri IPC 本地模式**:per-(window,port) `Channel` 二进制直传,跳过合批以降延迟(注释里标为 A/B 对照)。

### 发送/换行逻辑(集中、勿复制)

text 模式自动追加换行的逻辑**只此一处**:`ss-core::macros::encode_send` + `SerialManager::send`。宏与 MCP 共用此入口。**透传的 WS/Telnet 不经过这里**(交互输入不自动加换行)。新增发送路径请复用,不要另写一套换行处理。

### 前端 Transport 抽象(`ui/src/transport.ts`)

`Transport` 接口屏蔽 IPC/WS 协议差异,组件只懂领域(port/bytes/macro)。`LocalTransport`(Tauri invoke + event)与 `RemoteTransport`(WS)两实现,继承 `TransportEventBase` 共用 on* 事件目录(新增事件只改 `TransportEventsMap` + 基类,勿在两实现各抄一份)。运行形态判定唯一入口 `lib.ts::getMode()`("local" | "remote-window" | "web"),勿在别处重组 `isTauri`/`getRemoteFromUrl`。

**端口键模型(P1 后)**:**线名即 pid**——本地 transport 的事件/列表线名是后端复合键(直通);远程 transport 的线名是远端侧键(加设备前缀,两级级联 `uuidA::local::COM3` 自然产生)。事件 ingest 用 `lib.ts::wireToPid(devId, 线名)`;列表桶内条目用 `bucketPidOf(grpDevId, name)`(幂等);展示名 `displayPortName`(rsplit `::` 末段)。**Transport 命令面收完整 pid**:LocalTransport 直传(Rust 规范化),RemoteTransport 内部 `wireName()` 剥首段。

**桌面 local 形态只有 "local" 一个 transport**——远程设备连接在后端(DeviceClientManager),前端经 `onDevices`(devices-changed 事件)观察在线状态、断连中止、上线重放;设备增删走 save_remotes(后端钩子 update_registry),断开/重连走 `device_disconnect`/`device_connect` 命令。RemoteTransport 仅存在于 web/remote-window 形态(前端直连远端 ss)。`store.ts` 的 `ports_listed` 对本地合并列表按键首段自动分桶。

### 前端状态与组件分层

- **`store.ts`(会话 reducer,纯函数可单测)**:transport 事件回调读写的领域状态(portsByDev/devOnline/openPorts/disconnectedPorts/portConfigs/groups/layout/focusedGroupId)全在此。事件回调只 `dispatch`(永不 stale);副作用(终端实例清理、transport 调用)留在 App 回调。焦点自愈、layout 坍缩等不变量在 reducer 内维护。
- **`library.tsx`(`useNamedLibrary<T>`)**:宏/脚本两个命名库的泛型实现(编辑/保存/删除/分组/导入/折叠持久化),差异面由 `LibrarySpec` 注入(App 内 `MACRO_SPEC`/`SCRIPT_SPEC`,模块级常量保引用稳定)。新增第三种命名库复用此 hook,勿再复制。
- **`components/` 目录**:primitives(原语)/ term(终端+分栏)/ dialogs / palettes / editors / sidebar(三个活动面板)/ run-cards,App 只从 barrel `components/index.ts` 导入。
- 宏/脚本运行卡片共用 `RunCards`(hasLogs 区分有无日志展开)。
- **主题**:Linear 风格双主题(`linear` 暗 / `linear-light` 亮),注册表在 `theme.ts::THEMES`——一条 `ThemeDef` 含 term(xterm)/search/cm(CodeMirror) 全部 TS 侧配色;`--accent`(交互强调)与 `--rx`(RX 信号语义)是两个 token,主题只换前者。暗色默认值住 `styles.css` 的 `:root`,亮色是 `linear-light` 覆盖块。新增主题 3 处(组件代码零改动):`theme.ts` 登记一条 → `styles.css` 一块 token 覆盖(浅色家族还需仿 linear-light 块尾部附浮层阴影/hover 叠黑等组件特例)→ `index.html`(id 数组 + 首帧背景 + 旧 id 迁移表,与 theme.ts 同步)。切换 UI 是活动栏主题菜单(按 family 分组),`toggleTheme` 快捷键循环轮换。

### 持久化(五个 JSON,系统 app data 目录)

配置目录由 `ss_server::config::config_dir()` 统一定位:优先 `SERIAL_STUDIO_CONFIG_DIR` 环境变量(测试钩子 + headless 固定位置),否则系统配置目录下的 `serial-studio/`(macOS=`~/Library/Application Support`、Win=`%APPDATA%`、Linux=`~/.config`)。**不写 exe 同目录**——macOS 升级 .app bundle 覆盖会丢配置。store 是模块级自由函数(`load()/save()`),不归 `AppState`。**不做老配置迁移**(新版从默认/空开始;macOS bundle 内旧配置升级时已物理丢失)。

| 文件 | 内容 | 归属 |
|---|---|---|
| `settings.json` | 监听地址 / WS 端口 / Telnet 端口 | 端口所在机器 |
| `ports.json` | 端口元数据(别名,强制唯一去重) | 端口所在机器;core 只出 `PortInfo` 运行时事实,别名由 server 层 `PortView`(`serde(flatten)`)组合 |
| `macros.json` | 宏 | 桌面端走 Tauri command;Web 端存浏览器 localStorage(`lib.ts::persistMacros`) |
| `scripts.json` | 脚本库 | 桌面端走 Tauri command;Web 端 localStorage;MCP 单条 `upsert`/`remove` 经进程内锁 |
| `remotes.json` | 已知远程设备列表 | 仅桌面端走 Tauri command(`load_remotes`/`save_remotes`);Web/远程窗口由 connConfig 派生单设备,不持久化 |

别名写入的唯一入口是 `set_alias_and_notify`(写 ports.json + 发 meta_bus)。`PortView` 的 `serde(flatten)` 契约要求线上 JSON 扁平为 `{name,opened,holders,alias?}`——改 `PortInfo`/`PortView` 字段要顾全前端 `PortInfo` 接口。

## 关键不变量(改代码时守住)

- **`ss-core` 零 UI/服务/网络依赖**——保可测试性(线协议知识只住 `server/src/protocol.rs`)。
- **`AppState` 跨 `ServiceSupervisor` 重启保留**,只换 listener(热重启不丢串口连接/宏/设备连接)。
- **WS 出站必须经 `RemoteTransport.send()`(await open)**,禁止裸 `ws.send`——CONNECTING 态会抛 `InvalidStateError`。
- **数据帧 layout** 和 **换行逻辑** 各自只有一处定义,改一处要找另一处。
- **复合键解析只按首个 `::` 切分、后缀整体透传**(级联根基);**manager 端口入口恒 normalize**(裸名与复合键同一条目,占有权单一事实);**事件 `port` 字段恒为 map 键**。
- **设备连接的写/开/关走同一 unbounded 命令通道**(单写者保序,close 不走旁路);RemotePortIo 的 write 回执用 std mpsc 限时等待(spawn_blocking 线程必返回)。
- **DeviceClient 收到的通知类消息(MetaChanged/事件)不得直接扇出本地 meta_bus**——本地 meta_bus 会把 MetaChanged 推给所有连接(含自连这条),自连时形成回授环(消息风暴,CPU 100%)。变更一律走 RefreshList 重拉 → Ports 缓存 **diff** → 真变了才通知本地,传播一轮即收敛。
- 服务器默认绑 `0.0.0.0` 且**无认证**——任何人可达即可开/发/读串口。安全相关改动需顾及此默认;远程设备下沉后,本机脚本可主动连出任意注册设备(SSRF 面=remotes.json 白名单)。

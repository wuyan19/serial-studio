# serial-studio crate 布局审核

结论先行：依赖方向与核心抽象是对的，问题集中在 ss-server 一个 crate 装了三层职责——属于边界粒度问题，不是方向问题。不建议在 main 上预防性重构；等 topo-hub 作为第二个消费者真实需要时再拆（见文末处置）。

## 现状盘点

| crate | 声明职责 | 实际承载 |
|---|---|---|
| `ss-core` | 串口管理引擎，纯运行时 | 引擎 + 宏执行器 + QuickJS 脚本引擎（含宿主机文件读写函数） |
| `ss-server` | axum 接入层（lib + headless bin） | 接入适配器 + 设备访问域 + 领域组合逻辑 + 五个持久化存储 + 组装根 + 内嵌 SPA |
| `ss-tauri` | Tauri 桌面壳 | 壳（main.rs 1287 行 IPC 命令层 + 托盘/更新器），业务全部委托 ss-server pub API |

## 做对了的（保持不动）

- **依赖单向无环**：ss-tauri → ss-server → ss-core；ss-core 零内部依赖、不依赖 axum/tauri，可测试性声明成立。
- **core 的依赖倒置点**：`PortOpener` trait + `KeyResolver` 注入（`manager.rs:64`）。core 对 SSH/远端设备完全无知，三种端口形态在 server 侧 `CompositeOpener` 汇聚——这是全项目最关键的一条边界，新端点类型（exec/tcp）接入不动 core。
- **一份后端两种宿主**：ss-server 同时是 lib（Tauri 壳复用 `create_state`/`create_router`）与 bin（headless），已验证。
- **线协议单点**：`protocol.rs` 是 WS 词典唯一定义，server 出口与 DeviceClient 共用。
- **壳薄**：ss-tauri 无业务逻辑复制，只做 IPC 适配。

## 问题清单（按影响排序）

### P1：ss-server 五职合一，模块可见性被迫全面 pub

一个 crate 同时是接入适配层（ws/mcp/telnet）、设备访问域（`ssh/`、`device/`、`address.rs`）、领域组合逻辑（`list_ports_with_meta` 三桶合并、别名校验、级联透传环检测——都在 lib.rs）、持久化（ports/macros/scripts/remotes/ssh 五个 store）、组装根（`create_state`/`create_router`/内嵌 SPA）。

后果：`device`/`ssh`/`address`/`protocol`/各 store 本应是内部实现，因 Tauri 壳要用而全部 `pub mod`——server 的内部结构成了事实公共 API，无封装可言；lib.rs 单文件混路由、领域纯函数、静态资源服务三种角色。真正受影响的是未来消费者：任何只要"设备访问能力"的 crate（topo-hub 就是）必须拖进 axum + rust-embed + telnet + tokio-tungstenite 全部依赖。

### P2：设备访问域没有自己的 crate

`ssh/`、`device/`、`address.rs`、`protocol.rs` 合起来是"设备接入与寻址"这个领域，与"HTTP/WS 服务器"是两回事。它们寄居在 server 里，导致上一条的依赖面问题。

### P2：core 的"纯运行时"声明被脚本引擎稀释

QuickJS 引擎与宿主机文件函数（`read_file`/`write_file`/`append_file`/`file_md5` 等，见 `crates/core/Cargo.toml` 注释与 MCP 工具描述）在 core，宏执行器也在。core 实际是"串口引擎 + 脚本引擎"，依赖面（rquickjs/base64/md-5）与测试面随之膨胀。另有文档漂移：README 安全节称沙箱"no file access"，与实际文件函数能力不符，需同步修正。

### P3：UI 单 App 无路由

`App.tsx` 2752 行承担全部界面编排——终端工具形态的自然结果，不算缺陷，但对 topo-hub 不可复用骨架；可复用的是 `transport.ts`（WS 客户端模式）、`term.tsx`（xterm 封装）、`theme.ts`、`primitives.tsx`。

## 处置

- ~~**不在 main 上拆**~~ → **已拆（2026-10-27，提交 09d883f，topo-hub 分支）**
- ~~**topo-hub P0 直接依赖 ss-server lib**~~ → **已依赖；P2.6 边界定型后拆出 `ss-device` crate**：ssh/、device/、address.rs、protocol.rs、remotes_store、port_meta_store、config.rs（config_dir）+ DeviceView/PortView 类型与纯函数。ss-server 瘦身为适配器+组合逻辑+组装根，经 `pub use` 重导出设备域——下游零改动。依赖链：topo-hub → ss-server → ss-device → ss-core。**待合回 main**（main 获得同样瘦身收益）。
- core 的脚本引擎短期不动（波及面大且无第二形态需求）；README 安全描述与实际能力先行对齐（待办）。

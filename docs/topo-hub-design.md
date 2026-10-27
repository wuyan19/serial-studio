# topo-hub 设计：AI 设备调试的拓扑管理平台

读者为本项目研发与评审者；评审通过后据此实施 P0/P1。布局现状评估见 [crate-layout-review.md](crate-layout-review.md)，本文不重复其论证。

## 1. 定位与边界

面向 AI 真实设备调试阶段的拓扑与占用管理平台：AI 通过 MCP 查看拓扑、申请并独占拓扑或设备的控制权、用完释放、创建拓扑；串口/SSH/远端级联的设备访问能力整体复用 serial-studio 已有数据面，不重写。

不是：不做新的串口引擎、不改 core 的端口生命周期、V1 不做排队与通知、不做认证（可信内网前提与 serial-studio 一致，API key 列为 P2 可选项）。

## 2. 布局：两阶段

**P0（不拆）**：新增 `crates/topo-hub`（bin + lib）与 `ui-topo/`（独立 Vite 应用）。topo-hub 依赖 ss-server lib，复用 `create_state` 与 `create_router`（`/ws`、`/api/ports`、`/mcp` 原样可用），新增自己的拓扑/租约路由 nest 进去；SPA 用自己的 `rust-embed`（指向 `ui-topo/dist`）替换默认 fallback。绝不依赖 tauri-app。

**P1（拆）**：按审核报告拆出 `ss-device` crate，topo-hub 与 ss-server 同时改为依赖它，重构一次完成并合回 main。

新模块（P0 落在 topo-hub crate 内）：

| 模块 | 职责 |
|---|---|
| `topology.rs` | 类型 + 成员定型（resolve_member）+ topologies.json 读写（照 remotes_store 模式） |
| `api.rs` | 拓扑 REST（/api/topologies CRUD）+ TopoState 组装状态 + 成员展示视图 |
| `events.rs` | SSE 变更通知流（GET /api/events，topo_bus 扇出） |
| `mcp_topo.rs` | 拓扑 MCP 工具集（McpExtension 实现） |
| `lease.rs`（P1） | LeaseManager：租约表、覆盖判定、TTL 清扫、原子申请 |
| `audit.rs`（P1） | audit.jsonl 追加写 |

路由组装在 `lib.rs::create_router`：ss-server `base_router`（/ws、/api/ports、/mcp，扩展已注入）+ 拓扑路由 + 自嵌 SPA fallback。

## 3. 数据模型

**设备是被测对象的一等实体，通道是接入方式**（2026-10-27 定案，P2.5 重构）：一台交换机 = 一台设备，其串口控制台（COM4）与多条 SSH 登录（admin@ip、support@ip）是它的**通道**。此前模型里的"设备"（本机/SSH 主机/远端实例）实为接入源，不再冒充设备——接入源降级为底层资源；"哪些通道属于同一台被测设备"这层领域知识落进注册表，此前只存在于人的备注里。

```jsonc
// devices.json（新增：被测设备注册表）
{ "id": "uuid", "name": "车间交换机#3（同表唯一）", "model": "", "location": "",
  "channels": [
    { "type": "serial", "port": "COM4" },     // 本机裸名，或级联端口键 devB::COM4（设备插在另一台 ss 主机）
    { "type": "ssh", "ref": "ssh-uuid" }      // 引用 SSH 凭据库（admin@ 与 support@ 是两条凭据、一台设备的两条通道）
  ] }

// topologies.json（成员纯设备引用）
{ "id": "uuid", "name": "唯一名", "description": "",
  "members": [{ "device": "设备id", "note": "被测主板" }],
  "links": [{ "from": "设备id", "to": "设备id", "label": "eth0↔port1" }], ... }

// 租约（纯内存；占用=设备级，grant 即设备）
{ "id": "uuid", "holder": { "token": "uuid", "kind": "mcp|web|local", "label": "claude/agent-1" },
  "grants": [{ "device": "设备id" }],
  "acquired_at": "...", "expires_at": "..." }
```

校验：设备名唯一；串口通道的端口与 SSH 凭据**跨设备不共用**；SSH ref 须存在于凭据库。SSH 凭据库（ssh.json）保留为连接层——管理入口收进设备编辑表单（顺带建/选凭据），未挂设备的凭据收纳在设置里。租约纯内存语义不变。

**一次性迁移**（仅冒烟期数据）：旧成员 `{kind, key}` 每键自动包一台设备（串口端点键→串口通道；SSH 键→SSH 通道；`local`/远端实例整机成员跳过），迁移后重写两份 JSON。

## 4. 租约机制

**占用 = 设备级独占**（用户定案）：占用一台设备即锁定其**全部通道**——串口控制台与 SSH 并发操作会互相干扰（SSH 重启设备即打断控制台），设备级语义最干净；分通道观察需求由"读免闸"兜底（grep/attach 本就不拦）。

**覆盖判定**：`device_of_port(端口键) → 属主设备`（串口通道比对端口键；SSH 通道比对复合键首段 == ref），grant 覆盖 w 当且仅当 `device_of_port(w) == grant.device`。冲突判定退化为设备 id 相等。未注册端口的写操作被闸拦时引导 `device_create`——平台纪律：每个在用端口都归属已知设备。

**原子性/状态机/TTL/排队**：不变（见下文与 §6）。**抢占收口**：强释放时收回该会话在租约设备全部通道端口中经 MCP 开的口。

**写闸**（`enable_lease_gate`，默认开，**仅作用于 MCP 来源**；web 用户与本地 Tauri 免闸——闸的管理对象是 AI，人有人工抢占权兜底）：

| 工具 | 闸 |
|---|---|
| `serial_send` / `serial_read` / `serial_clear` | 需持覆盖该端口（经属主设备）的租约 |
| `serial_debug_script` / `serial_run_script` | 启动时按 `port` 参数检查；脚本内跨端口写不二次拦截（局限，P2 下沉 core 再拦） |
| `port_open` / `port_close`（ss-server 内置，serial-studio 同享） | 同上需租约；占用挂 token 的 MCP 会话（mcp.rs 进程级注册表），只能关自己开的口；强释放顺带收回 |
| `serial_list` / `serial_status` / `serial_grep` | 免闸（非破坏，观察开放） |

被闸拒绝时错误信息引导先 `lease_acquire`（未注册端口引导 `device_create`），并附当前持有者与到期时间。

**失败返回与排队**：每个冲突设备返回 `{device, name, holder_label, expires_at}`。`lease_acquire` 带 `wait_timeout_ms`（上限 10 分钟）时服务端 500ms 轮询排队，持有者释放或过期即自动获得，超时仍冲突才拒绝。

## 5. MCP 会话与工具

**会话**：`initialize` 响应头加 `Mcp-Session-Id`（Streamable HTTP 标准约定），结果体同时带 `session_token` 字段兜底；租约类工具均接受可选 `token` 参数。优先级：参数 > 头 > 匿名（匿名只读）。token → Principal 注册表在内存，`label` 由 AI 在 acquire 时自报。

**新工具**（前 5 个 P0，后 4 个 P1）：

| 工具 | 入参要点 | 出参要点 |
|---|---|---|
| `topo_list` | — | 拓扑数组：id、name、成员数、占用摘要 |
| `topo_get` | `topo`（id 或 name） | 成员端点明细：在线状态、被谁占用 |
| `topo_create` | `name`、`description?`、`members: [{key, note?}]` | 定型后的成员与 id |
| `topo_update` | `topo` + 可变字段 | 同上 |
| `topo_delete` | `topo` | — |
| `lease_acquire` | `topo?` \| `devices?: [id]` \| `endpoints?: [key]` 三选一，`holder?`、`ttl_minutes?`、`token?` | `lease_id`、grants、`expires_at`；冲突则逐端点明细 |
| `lease_renew` | `lease_id`、`ttl_minutes?`、`token?` | 新 `expires_at` |
| `lease_release` | `lease_id`、`token?` | — |
| `lease_status` | `token?` | 本 principal 全部租约与剩余时间 |

设备工具族（P2.5 新增）：

| 工具 | 入参要点 | 出参要点 |
|---|---|---|
| `device_list` | — | 设备行：名称、通道摘要（串口/SSH 各自目标）、占用状态 |
| `device_get` | `device`（id 或 name） | 通道明细（解析凭据标签/端口在线态）、占用 |
| `device_create` | `name`、`model?`、`location?`、`channels: [{type:serial,port} \| {type:ssh,ref}]` | 定型后的设备 |
| `device_update` | `device` + 可变字段（提供才更新） | 同上 |
| `device_delete` | `device`（被拓扑引用时拒绝并列出） | — |

`lease_acquire` 的 scope 主形态为 `devices: [id或名称]`；`endpoints: [端口键]` 保留为糖——经 `device_of_port` 解析到属主设备，未注册端口报错并引导 `device_create`。`topo` 展开为成员设备并集；成员设备已删除的跳过并标注。

## 6. 通知通道：SSE（实现修正）

设计初稿拟增补 ss-server 的 WS 协议（ClientMsg/ServerMsg 加拓扑消息），实施时改为 **SSE**：`GET /api/events` 订阅 `topo_bus`，变更推 `topo_changed` 事件，客户端重拉 REST。理由：

- 不动 `protocol.rs` 与 DeviceClient 的反序列化路径——未知消息类型对远端设备客户端是风险面，拓扑通知与串口终端数据面本就无关；
- 命令面 REST、通知面 SSE，ui-topo 不必为拓扑管理绑进终端 WS 词典（终端视图未来仍走 /ws 拿数据帧）；
- P1 的租约事件（`lease_changed`）走同一条流，机制复用。

代价：需要主动通知的浏览器页面各持一条 EventSource（连接数多一条）；`lease_acquire` 的排队唤醒（P2）若要低延迟推送，届时再评估是否升级 WS。

## 7. UI 信息架构（ui-topo）

独立 Vite + React + TS 应用，上路由（react-router）。**视觉体系与功能面板整体移植自 serial-studio UI**（2026-10-27 起）：styles.css 全量（design tokens + 全部主题覆盖块）、theme.ts 主题注册表（13 主题、localStorage 持久、首帧防闪内联脚本）、primitives（ConfigRow/对话框键盘栈/焦点圈闭/PortLabel/InlineAliasInput）、对话框族（设置/关于/SSH 管理与编辑/认证重试/指纹确认/添加远端/设备与端口详情/串口参数/通用确认）。

数据通道：SSH 管理/别名/版本走既有 WS 协议（与 serial-studio UI 同源同协议）；远端设备与设置走 topo-hub REST（`/api/remotes`、`/api/settings`，原为 Tauri IPC 专属）；终端走 WS 数据面（二进制帧 + Acquired/Error 回执配对），xterm 单终端简化移植（选中复制/fit/PTY resize/主题热切）。

| 页面 | 内容 |
|---|---|
| 总览 | 拓扑卡片：成员设备数、占用徽章（持有者 label + 剩余时间） |
| 拓扑详情 | 成员设备列表（通道/在线/占用）⇄ 拓扑图（@xyflow/react，节点=设备） |
| 设备管理 | 设备卡（名称/型号/通道清单含在线与占用/每通道"开终端"/编辑/删除）；页底折叠"未注册资源"（未归属端口、未挂设备凭据、级联口）——即资源选择器 |
| 占用中心 | 活跃租约表（设备级 grant）+ 人工强释放 |
| 终端 | 设备→通道选择（串口参数对话框/SSH 直开）+ 裸端口兜底 → xterm 标签页；SSH 认证/指纹闭环弹窗 |

侧栏工具区：添加远端 / 设置（服务器+租约+SSH 凭据收纳）/ 关于 / 主题选择。设置中 enable_scripting 热生效，监听与租约参数重启生效。

## 8. 审计与配置

`audit.jsonl`（config 目录）追加 `{ts, event, token, label, lease_id, keys, detail}`；事件：`acquire` / `deny` / `renew` / `release` / `expire` / `preempt` / `write_denied`。V1 不滚动。

租约配置读独立文件 `lease.json`（`ttl_minutes` 默认 30、`max_ttl_minutes` 默认 240、`enable_gate` 默认 true）——不并入 settings.json：settings 的写方是 ss-server 的字段白名单序列化，拓扑域自持配置避免互相覆盖。监听端口走 CLI 参数（默认 18800，错开本机 serial-studio 的 18700/18701）。

## 9. 分期与测试

- **P0**（已完成）：topo-hub bin + ui-topo 壳（复用路由、自嵌 SPA）、拓扑 store 与 CRUD（MCP 5 工具 + REST/SSE + UI 管理页）。
- **P1**（已完成）：session token（initialize 签发，头/参数双通道）、LeaseManager（原子申请/TTL/续租/释放/强释放）、写闸（仅 MCP 来源的 send/read/clear/脚本，拒绝文案附持有者）、审计、占用中心与占用徽章。
- **P1.5**（已完成）：MCP `port_open` / `port_close`（ss-server 内置）——AI 全流程无人值守补齐；强释放顺带收回该会话开的端口。
- **P2 已交付**：拓扑连线（`links` 数据模型 + 成员引用/自环校验 + UI 连线编辑器）与拓扑图视图（@xyflow/react，节点按设备分组、占用高亮、圆形自动布局）；排队等待（`lease_acquire` 的 `wait_timeout_ms`，服务端轮询，无需 transport 升级）。
- **P2.5**（进行中）：设备一等公民重构——devices.json 注册表（设备=身份、通道=串口/SSH 接入）、拓扑成员纯设备化、租约设备级独占（`device_of_port` 映射）、MCP 设备工具族、UI 信息架构归两区（拓扑/设备管理）+ 设置收纳 SSH 凭据；一次性迁移旧成员数据。
- **P2 剩余**：拆 `ss-device` 合回 main、API key、脚本跨端口写拦截下沉、图布局持久化。

测试：device store（CRUD/通道跨设备不共用/拓扑引用删除拦截）、迁移（旧成员→设备包装）、lease 设备级（同设备不同通道不冲突/跨会话同设备冲突/未注册端口闸拒）、token 工具集成；冒烟沿用隔离实例方式（`SERIAL_STUDIO_CONFIG_DIR` + 错峰端口）。

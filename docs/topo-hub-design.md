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

引用键两种粒度，创建时经 `AddressResolver`/端口表校验存在性并**定型**（存类型字段，不靠字符串猜）：

- 设备键：设备 id（`local` / SSH uuid / 远端实例 id），代表该设备全部端点；
- 端点键：端口复合键（`COM3`、`sshUuid::shell`、`remoteId::COM5`），代表单端点及其运行实例（`shell@N`）。

```jsonc
// topologies.json（持久化）
{ "id": "uuid", "name": "唯一名", "description": "",
  "members": [{ "kind": "device|endpoint", "key": "sshUuid", "note": "被测主板" }],
  "created_at": "...", "updated_at": "..." }

// 租约（纯内存，不入盘）
{ "id": "uuid", "holder": { "token": "uuid", "kind": "mcp|web|local", "label": "claude/agent-1" },
  "grants": [{ "kind": "device|endpoint", "key": "..." }],
  "acquired_at": "...", "expires_at": "..." }
```

租约纯内存的语义：hub 重启即全部释放（连接本来就断），持久化的只有拓扑定义。

## 4. 租约机制

**覆盖判定**（grant 是否覆盖一个写入端口键 w）：

| grant | 覆盖 w 当且仅当 |
|---|---|
| device(key=d) | w 的设备段 == d（裸名 w 视为 `local`） |
| endpoint(key=e) | w == e，或 w 同设备段且裸名以 `e 的裸名@` 开头（实例行） |

**冲突**：两 grant 覆盖集合相交即冲突（device 与同设备 endpoint 相交；endpoint 与其实例行相交）。申请 = 请求键集合内先自检（重复即 400），再与全部活跃租约两两判定，任一冲突则整体拒绝。

**原子性**：LeaseManager 单锁内"全量冲突检查 + 插入"一次完成，无中间态；不存在逐个拿锁接口，死锁在 API 形态上不可能。

**状态机**：

```
申请成功 → Held ── renew ──→ Held（顺延 expires_at，受 max_ttl 约束）
Held → Released   显式释放（持 token 或人）
Held → Expired    TTL 到期（每分钟定时清扫 + 读取时惰性判定双保险）
Held → Preempted  仅人（Web 占用中心），顺带 force_close 相关连接
申请冲突 → Denied（不建立，返回冲突明细）
```

**TTL**：默认 30 分钟、上限 240 分钟（settings 可配），申请与续租可传 `ttl_minutes`。MCP 是短连接 POST，无断连信号，租约生命周期不依赖连接状态，TTL 是崩溃客户端的唯一回收手段。

**写闸**（`enable_lease_gate`，默认开，**仅作用于 MCP 来源**；web 用户与本地 Tauri 免闸——闸的管理对象是 AI，人有人工抢占权兜底）：

| 工具 | 闸 |
|---|---|
| `serial_send` / `serial_read` / `serial_clear` | 需持覆盖该端点的租约 |
| `serial_debug_script` / `serial_run_script` | 启动时按 `port` 参数检查；脚本内跨端口写不二次拦截（局限，P2 下沉 core 再拦） |
| `serial_list` / `serial_status` / `serial_grep` | 免闸（非破坏，观察开放） |

被闸拒绝时错误信息引导先 `lease_acquire`，并附当前持有者与到期时间。

**失败返回**：每个冲突端点返回 `{key, holder_label, expires_at}`，AI 自行决策重试或换拓扑。

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

`topo` 展开为成员并集；成员键已失效（设备删除/端点消失）的跳过并在结果标注，不阻塞申请。

## 6. 通知通道：SSE（实现修正）

设计初稿拟增补 ss-server 的 WS 协议（ClientMsg/ServerMsg 加拓扑消息），实施时改为 **SSE**：`GET /api/events` 订阅 `topo_bus`，变更推 `topo_changed` 事件，客户端重拉 REST。理由：

- 不动 `protocol.rs` 与 DeviceClient 的反序列化路径——未知消息类型对远端设备客户端是风险面，拓扑通知与串口终端数据面本就无关；
- 命令面 REST、通知面 SSE，ui-topo 不必为拓扑管理绑进终端 WS 词典（终端视图未来仍走 /ws 拿数据帧）；
- P1 的租约事件（`lease_changed`）走同一条流，机制复用。

代价：需要主动通知的浏览器页面各持一条 EventSource（连接数多一条）；`lease_acquire` 的排队唤醒（P2）若要低延迟推送，届时再评估是否升级 WS。

## 7. UI 信息架构（ui-topo）

独立 Vite + React + TS 应用，上路由（react-router）；复用旧 UI 的 transport 模式、`term.tsx`、`theme.ts`、`primitives.tsx`。

| 页面 | 内容 |
|---|---|
| 总览 | 拓扑卡片：成员数、占用徽章（持有者 label + 剩余时间） |
| 拓扑详情 | 成员列表（在线/占用状态）；V2 加图（@xyflow/react） |
| 设备库 | 本机/SSH/远端三源统一管理，消费 DeviceView |
| 占用中心 | 活跃租约表 + 人工强释放（Preempted 路径） |
| 终端 | 点端点开 xterm，从属视图 |

## 8. 审计与配置

`audit.jsonl`（config 目录）追加 `{ts, event, principal, label, lease_id?, keys, detail}`；事件：`acquire` / `deny` / `renew` / `release` / `expire` / `preempt` / `write_denied`。V1 不滚动。

settings.json 增补：`lease_ttl_minutes`（默认 30）、`lease_max_ttl_minutes`（默认 240）、`enable_lease_gate`（默认 true）、独立监听端口（本机 18700/18701 已被 serial-studio 占用，topo-hub 默认 18800）。

## 9. 分期与测试

- **P0**（已完成）：topo-hub bin + ui-topo 壳（复用路由、自嵌 SPA）、拓扑 store 与 CRUD（MCP 5 工具 + REST/SSE + UI 管理页）。
- **P1**：session token、LeaseManager、写闸、审计、占用中心与占用徽章。
- **P2**：拆 `ss-device` 合回 main、拓扑图、排队通知（需 MCP 上 SSE）、API key、脚本跨端口写拦截下沉。

测试：lease 单元（原子性/冲突矩阵：device×endpoint×实例/TTL 边界/覆盖判定）、token 工具集成、store CRUD；冒烟沿用隔离实例方式（`SERIAL_STUDIO_CONFIG_DIR` + 错峰端口）。

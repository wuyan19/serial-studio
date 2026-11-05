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
// devices.json（被测设备注册表；P2.6 起通道携带完整接入配置——"通道归设备"）
{ "id": "uuid", "name": "车间交换机#3（同表唯一）", "model": "", "location": "",
  "channels": [
    { "type": "serial", "port": "COM4",        // 本机裸名或级联键 devB::COM4
      "config": { "baud_rate": 115200, "data_bits": "eight", /* …与打开串口同构的完整参数 */ } },
    { "type": "ssh", "id": "uuid（稳定，=端口键首段）", "host": "192.168.21.20", "port": 22,
      "username": "root", "nickname": null, "auth": { "type": "password", "password": "…" } }
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

校验：设备名唯一；串口端口跨设备不共用；SSH 通道 id 与 host:port 跨设备不重复；SSH 字段完整性（host/username 非空、认证按类型带 key_path/password）。

**SSH 凭据库降级为实现细节**：连接层（SshManager 会话池、`sshUuid::shell` 端口寻址）仍建立在 ssh.json 之上——设备保存时把 SSH 通道**投影**进凭据库（增删改同步，id 稳定保证端口键不变），用户不再直接管理凭据；设置页的凭据库入口撤销。设备删除即删其凭据；历史孤儿凭据保留（裸端口区仍可开）。终端从设备通道打开**即点即开**（串口用存储参数，不再弹参数框）；参数框仅留给未注册裸端口。MCP `device_create/update` 的 channels 直接收完整配置。

**迁移**（冒烟期一次性）：P2.5 的 `{type:"ssh", ref}` 通道查凭据库展开内联（查无则弃）；串口通道补默认 config；旧拓扑成员包设备逻辑不变。

## 4. 租约机制

**占用 = 设备级独占**（用户定案）：占用一台设备即锁定其**全部通道**——串口控制台与 SSH 并发操作会互相干扰（SSH 重启设备即打断控制台），设备级语义最干净；分通道观察需求由"读免闸"兜底（grep/attach 本就不拦）。

**覆盖判定**：`device_of_port(端口键) → 属主设备`（串口通道比对端口键；SSH 通道比对复合键首段 == ref），grant 覆盖 w 当且仅当 `device_of_port(w) == grant.device`。冲突判定退化为设备 id 相等。未注册端口的写操作被闸拦时引导 `device_create`——平台纪律：每个在用端口都归属已知设备。

**原子性/状态机/TTL/排队**：不变（见下文与 §6）。**抢占收口**：强释放时收回该会话在租约设备全部通道端口中经 MCP 开的口。

**租约即写权**（2026-11-05 设备本体论工具面起）：新 I/O 工具（`exec_command`/`open_session`/`send_input`/`close_session`）在 session 层入口直接检查**设备租约**——不是端口键闸，是工具自身语义。旧写闸（intercept）保留：agent 猜用内置工具名（`serial_send` 等）时仍按端口键闸拦截。

**写闸**（`enable_lease_gate`，默认开，**仅作用于 MCP 来源**；web 用户与本地 Tauri 免闸——闸的管理对象是 AI，人有人工抢占权兜底）：

| 工具 | 闸 |
|---|---|
| `exec_command` / `open_session` / `send_input` / `close_session`（分叉面） | session.io_gate：设备租约检查（无租约拒绝并引导 `acquire_lease`） |
| `read_output`（分叉面） | 免闸（非破坏游标读影子缓冲；会话须已建立） |
| `serial_send` / `serial_read` / `serial_clear`（内置，分叉后 tools/list 隐藏） | intercept：需持覆盖该端口（经属主设备）的租约 |
| `serial_script`（内置，含旧名别名） | 启动时按 `port` 参数检查；脚本内跨端口写逐次拦截（script_gate） |
| `port_open` / `port_close`（内置） | 同上需租约；占用挂 token 的 MCP 会话（mcp.rs 进程级注册表），只能关自己开的口；强释放顺带收回 |
| `serial_list`（含单口详情）/ `serial_grep`（内置） | 免闸（非破坏，观察开放） |

被闸拒绝时错误信息引导先 `acquire_lease`（未注册端口引导 `device_create`），并附当前持有者与到期时间。

**失败返回与排队**：每个冲突设备返回 `{device, name, holder_label, expires_at}`。`acquire_lease` 带 `wait_timeout_ms`（上限 10 分钟）时服务端 500ms 轮询排队，持有者释放或过期即自动获得，超时仍冲突才拒绝。

## 5. MCP 会话与工具

**会话**：`initialize` 响应头加 `Mcp-Session-Id`（Streamable HTTP 标准约定），结果体同时带 `session_token` 字段兜底；租约类工具均接受可选 `token` 参数。优先级：参数 > 头 > 匿名（匿名只读）。token → Principal 注册表在内存，`label` 由 AI 在 acquire 时自报。

**工具面**（2026-11-05 设备本体论重写，`docs/mcp-tools-design.md`；分叉声明：内置 `serial_*`/`port_*` 不进 tools/list——McpExtension `builtin_tools_visible()=false`；管理 6 个经 `is_admin_tool()` 隐藏）：

| 工具 | 入参要点 | 出参要点 |
|---|---|---|
| `get_topology` | `topology?`（省略=列表） | 列表：name/id/成员数；详情：成员通道/占用/备注 + 连线（两端端口标签） |
| `get_device` | `device?`（省略=列表） | 列表：名称/通道摘要/占用；详情：通道带序号（I/O `channel` 参数用） |
| `list_my_leases` | — | 本会话租约与剩余时间 |
| `acquire_lease` | `topology?` \| `devices?: [id]` \| `endpoints?: [key]`（可并集），`holder?`、`ttl_minutes?`、`wait_timeout_ms?` | `lease_id`、`expires_at`；冲突逐设备明细 |
| `renew_lease` / `release_lease` | `lease_id` | release 顺带关闭该会话在租约设备上的 I/O 连接 |
| `exec_command` | `device`、`command`、`channel?`、`wait_ms?`、`idle_ms?` | 一次调用拿完整输出（首字节等 wait_ms，静默 idle_ms 收尾） |
| `open_session` / `send_input` | `device(+channel)`、`data`、`wait_ms?`(0=只发) | 会话即设备通道：同 `device+channel` 寻址；连接/console 状态跨调用保持 |
| `read_output` | `device`、`since?`（游标）、`timeout_ms?` | 非破坏游标读（会话影子缓冲）；截断补读/持续输出轮询/从头读 |
| `close_session` | `device(+channel)` | 退出端口持有（末位才关物理连接） |

管理面（隐藏，tools/call 可用）：`device_create/update/delete`、`topo_create/update/delete`（形态同 P2.5，channels 内联配置）。

`acquire_lease` 的 scope 主形态为 `devices: [id或名称]`；`endpoints: [端口键]` 保留为糖——经 `device_of_port` 解析到属主设备，未注册端口报错并引导 `device_create`。`topo` 展开为成员设备并集。

**会话管理**（`crates/topo-hub/src/session.rs`）：连接即 manager 端口持有（挂 token 的 MCP 会话，与强释放收口同机制）；(token, 端口键) → 影子缓冲（append-only 环形 256KB，读到的字节留存），`read_output` 游标读影子缓冲（非破坏），滚动丢弃用 dropped 标注。租约释放/过期联动收回连接（release_lease/sweep/force_release 三路径）。通道寻址：序号（get_device 的通道[n]）/标签子串（含 SSH username）/缺省（首个串口，无串口取首个 SSH）。

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

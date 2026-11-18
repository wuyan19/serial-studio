# topo-hub

AI 设备调试的拓扑管理平台。设计见 [docs/topo-hub-design.md](../../docs/topo-hub-design.md)。

## 运行

```bash
cargo run -p topo-hub            # http://127.0.0.1:18800/ · MCP: /mcp
```

配置目录默认在系统配置目录的 `topo-hub/` 子目录（与 serial-studio 隔离）；
`SERIAL_STUDIO_CONFIG_DIR` 可覆盖。端口默认 18800，错开 serial-studio 的 18700。

## 前端开发

```bash
npm install --prefix ui-topo
npm run build --prefix ui-topo   # 产物嵌入二进制（未构建时 cargo 用占位页）
npm run dev --prefix ui-topo     # 5175 开发服，/api 代理到 127.0.0.1:18800
```

## 接入 MCP

```
claude mcp add --scope user --transport http TopoHub http://<host>:18800/mcp
```

**设备本体论工具面**（分叉：内置 `serial_*`/`port_*` 不出现在 tools/list；serial-studio 主产品的 MCP 不受影响）：

- 发现：`get_topology`（不传参=列表）/ `get_device`（不传参=列表；详情含通道序号）/ `list_my_leases`
- 租约：`acquire_lease`（支持 `wait_timeout_ms` 排队等待）/ `renew_lease` / `release_lease`——**租约即写权**，I/O 工具入口检查设备租约，无需打开端口
- 通道 I/O（设备+通道寻址，agent 不见端口键）：`exec_command`（无状态命令）/ `open_session` + `send_input`（持久会话）/ `read_output`（游标补读，非破坏）/ `close_session`——发送即等响应（wait/idle 语义），输出经会话影子缓冲支持游标读
- 管理（tools/list 隐藏，tools/call 可用）：`device_create/update/delete`、`topo_create/update/delete`

典型流：`get_topology` 选拓扑 → `acquire_lease` → `exec_command` 跑命令（或 `open_session` 进配置模式）→ `release_lease`（顺带关闭该会话的通道连接）。

控制台含拓扑图视图（详情页"列表 ⇄ 图"切换，节点按设备分组、占用高亮）。

## 控制台（serial-studio UI 同源）

- **主题**：13 套（Linear/Apple/Raycast/Superhuman/Claude/Cursor/Stripe/Sentry 各暗亮），侧栏底部切换，跟随系统首选项；
- **SSH 设备**：管理/编辑/测试/指纹确认，与串口工具同一 WS 协议；
- **添加远端**：远程 Serial Studio 实例级联（其串口与 SSH 设备并入设备库）；
- **设置**：服务器监听（重启生效）+ 远程脚本开关（热生效）+ 租约 TTL/写闸（重启生效）；
- **设备库**：本机/SSH/远端实时清单（WS 推送），右键详情、内联别名、双击进终端；
- **终端**：xterm 标签页，串口参数对话框（波特率/校验/流控/换行符），SSH 认证失败重输与指纹确认闭环。

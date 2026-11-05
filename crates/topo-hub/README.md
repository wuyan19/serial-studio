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

在 serial_studio 10 个串口/脚本工具（含 `port_open`/`port_close`，无人值守流程可全程 MCP）之外新增 12 个平台工具：

- 拓扑：`topo_get`（不传参=列表）/ `topo_create` / `topo_update` / `topo_delete`——成员（设备/端点）+ 连线（`links`，图渲染用）
- 设备：`device_get`（不传参=列表）/ `device_create` / `device_update` / `device_delete`
- 租约：`lease_acquire`（支持 `wait_timeout_ms` 排队等待）/ `lease_renew` / `lease_release` / `lease_status`——排他写权，写类操作（含 port_open）须持租约；强释放时顺带收回该会话开的端口

并入列表粒度的旧名（`topo_list`/`device_list` 等）保留为分发别名，tools/list 不出现。

控制台含拓扑图视图（详情页"列表 ⇄ 图"切换，节点按设备分组、占用高亮）。

## 控制台（serial-studio UI 同源）

- **主题**：13 套（Linear/Apple/Raycast/Superhuman/Claude/Cursor/Stripe/Sentry 各暗亮），侧栏底部切换，跟随系统首选项；
- **SSH 设备**：管理/编辑/测试/指纹确认，与串口工具同一 WS 协议；
- **添加远端**：远程 Serial Studio 实例级联（其串口与 SSH 设备并入设备库）；
- **设置**：服务器监听（重启生效）+ 远程脚本开关（热生效）+ 租约 TTL/写闸（重启生效）；
- **设备库**：本机/SSH/远端实时清单（WS 推送），右键详情、内联别名、双击进终端；
- **终端**：xterm 标签页，串口参数对话框（波特率/校验/流控/换行符），SSH 认证失败重输与指纹确认闭环。

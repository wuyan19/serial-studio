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

在 serial_studio 14 个串口/脚本工具（含 `port_open`/`port_close`，无人值守流程可全程 MCP）之外新增 9 个平台工具：

- 拓扑：`topo_list` / `topo_get` / `topo_create` / `topo_update` / `topo_delete`——成员（设备/端点）+ 连线（`links`，图渲染用）
- 租约：`lease_acquire`（支持 `wait_timeout_ms` 排队等待）/ `lease_renew` / `lease_release` / `lease_status`——排他写权，写类操作（含 port_open）须持租约；强释放时顺带收回该会话开的端口

控制台含拓扑图视图（详情页"列表 ⇄ 图"切换，节点按设备分组、占用高亮）。

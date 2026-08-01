# 统一串口工作区：单窗口多远程设备共存

- **日期**：2026-08-01
- **状态**：已批准（待实现）
- **范围**：仅 Tauri 桌面端（`crates/tauri-app` + `ui/`）

## 1. 背景与动机

当前「打开远程窗口」会调用 Tauri `open_remote_window` command（`crates/tauri-app/src/main.rs:143-161`），用 `WebviewWindowBuilder` 新建一个独立原生窗口，URL 为 `index.html?remote=host:port`。每个窗口只持有一个 `Transport`（`ui/src/transport.ts:426` 的 `createTransport()` 按 URL 决定本地 IPC 或远程 WS）。

这带来三个痛点：

1. 每个远程设备占用一个独立窗口，本地与远程串口分散在不同窗口，无法在同一个终端区混排 Tab。
2. 远程设备连接「无记忆」——`remoteInput` 每次硬编码 `{ host: "", port: 18700 }`（`App.tsx:216`），全仓无任何历史设备存储，下次使用要重新输入。
3. 本地端口列表不可折叠，端口多时拥挤。

终端侧其实已是 VS Code 风格的多 Tab + 布局树（`PaneNode` 递归二叉树 + DOM reparent 保 scrollback），底座已支持多 Tab，只是当前 Tab 只能来自同一 Transport 域。

## 2. 目标

- **单窗口多 Transport 共存**：一个桌面窗口同时持有本地 + N 个远程设备的连接。
- **远程设备持久化**：下次启动能看到之前的远程设备，直接点其串口即用。
- **串口列表分组折叠**：「本地」卡 + 各远程设备卡，均可折叠。
- **Tab 完全混排**：本地与各远程端口可在同一组分栏任意混排。
- **`ss-core` 零改动**：守住「纯运行时、零 UI/服务依赖」回归红线。

## 3. 非目标（YAGNI）

- Web 端多远程（Web 端维持单远程连接现状）。
- 远程设备自动重连（按需连接，断线后由用户手动重试/重连）。
- 远程端口别名的本地化存储（远程端口别名仍存远程服务端 `ports.json`，守住「ports.json 属端口所在机器」原则）。
- 跨设备端口名去重（复合键天然区分）。

## 4. 核心决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 远程 WS 连接时机 | **按需连接**：展开折叠卡或打开其端口时建立，需求归零时断开 |
| 改造范围 | **仅桌面端**，Web 端不变 |
| 设备显示名 | **支持昵称**：折叠卡标题与 Tab 来源标识用昵称，留空回退 `host:port` |
| 设备列表持久化 | **localStorage**（key `serial-studio-remotes`），零后端改动 |

## 5. 架构设计

### 5.1 `devId` 作为统一主轴

引入 **`devId`**（设备域标识）：

- 本地固定 `devId = "local"`。
- 每个远程设备分配一个稳定 UUID（`crypto.randomUUID()`），作为 localStorage 中的主键。

端口、Transport 实例、折叠卡、终端 Tab 全部围绕 `devId` 组织。本地与远程端口可能同名（都叫 `COM3`），靠 `devId` 区分。

### 5.2 Transport 多实例与引用计数式生命周期

`transportsRef` 从单例改为多实例：

```ts
const transportsRef = useRef<Map<string, Transport>>(new Map());
// key = devId
```

- 本地 `LocalTransport`（`devId="local"`）在 App 初始化时常驻，逻辑等价于当前的 `createTransport()` 本地分支。
- 远程 `RemoteTransport` 懒创建，生命周期由**引用计数**驱动：

  > 连接需求 = 折叠卡处于展开态 **OR** 该 devId 存在活跃 Tab（「活跃 Tab」指该 devId 的端口出现在任一 `Group.ports` 中，即已打开过）。

  实现为一个 effect：当某 devId 的需求由 `false → true` 且 Transport 不存在 → 创建 `RemoteTransport(host, port)` 并 `list()`；当需求由 `true → false` 且 Transport 存在 → `dispose()` 断 WS。

  这样：
  - 展开折叠卡 → 建连拉端口列表。
  - 关闭折叠卡但仍有 Tab 活跃 → 连接保持（数据流不中断）。
  - 关闭折叠卡且无 Tab → 断开（彻底按需，省资源）。
  - 删除设备 → 强制 dispose + 关闭该 devId 所有 Tab。

- 每个 devId 维护独立 `online` 状态（来自 `onConnectedChange`），驱动折叠卡标题状态点。

### 5.3 端口复合键

`PortId = \`${devId}::${name}\``，例如 `local::COM3`、`a3f1-...::/dev/ttyUSB0`。

需要迁移的引用点（探索结论）：

- `Group.ports: string[]`（`types.ts:153-171`）→ `PortId[]`
- `Group.activePort`（`types.ts`）→ `PortId | null`
- `terminalsRef: Map<string, TermInstance>`（`App.tsx:289`）→ `Map<PortId, TermInstance>`
- `ports: PortInfo[]` state → 按 devId 分组（见 5.4）

提供两个纯函数集中编解码（DRY）：

```ts
function portIdOf(devId: string, name: string): PortId { return `${devId}::${name}`; }
function parsePortId(id: PortId): { devId: string; name: string } { const [devId, ...rest] = id.split("::"); return { devId, name: rest.join("::") }; }
```

串口名不含 `::`（`COM3`、`/dev/ttyUSB0` 等），分隔符安全。

### 5.4 ports 数据模型

state 从扁平 `PortInfo[]` 改为按设备分组：

```ts
const [portsByDev, setPortsByDev] = useState<Record<string, PortInfo[]>>({});
```

`PortInfo` 增加前端字段 `devId: string`（**不进 core，不进线上 JSON**——devId 是前端根据 Transport 归属组装的）。线上 `PortView` 的 `serde(flatten)` 契约（`{name,opened,holders,alias?}`）保持不变，前端收到后在 `onPorts` 回调里按所属 Transport 打上 `devId`。

折叠卡按 `portsByDev` 的 key（devId）渲染：`local` 一张卡 + 每个 `RemoteDevice.id` 一张卡。

## 6. 持久化（localStorage）

### 6.1 数据结构

```ts
interface RemoteDevice {
  id: string;        // UUID，主键，稳定
  host: string;
  port: number;
  nickname?: string; // 可选，留空则 UI 回退 host:port
}
```

存储 key：`serial-studio-remotes`，值为 `RemoteDevice[]` 的 JSON。

### 6.2 读写入口（仿 `lib.ts` 的 `persistMacrosLocal` 模式）

- `loadRemotesLocal(): RemoteDevice[]`
- `persistRemotesLocal(list: RemoteDevice[]): void`

App 启动时 `loadRemotesLocal()` → 初始化设备卡列表。

### 6.3 CRUD

- **添加**：地球图标 → `RemoteDialog`（扩展昵称字段）→ 确认生成 UUID → `persistRemotesLocal` + 新增折叠卡。
- **编辑**：卡标题区编辑按钮 → 改 host/port/nickname。若改了 host/port 且该 devId Transport 在线，先 dispose（下次需求触发时用新地址重建）；nickname 改动仅刷新 UI。
- **删除**：卡标题区删除按钮 → 强制 dispose 该 Transport + 关闭该 devId 所有活跃 Tab（从 `Group.ports` 移除 + 销毁 `TermInstance`）→ 从 localStorage 移除。

`id` 唯一；`host:port` 不强制唯一（允许同地址多昵称用途），但添加时若已存在相同 `host:port` 给予轻提示。

## 7. UI 改造

### 7.1 活动栏地球图标

`App.tsx:1090` 的按钮语义从「打开远程窗口」改为「**添加远程设备**」：

- `onClick` 改为打开扩展后的 `RemoteDialog`。
- 不再调用 `tauriInvoke("open_remote_window", ...)`（`App.tsx:993-1003` 的 `openRemoteWindow` 移除）。
- 后端 `open_remote_window` command（`main.rs:143-161`）移除，并从 `invoke_handler`（`main.rs:565-585`）摘除。

### 7.2 RemoteDialog 扩展

`components.tsx:2286-2318` 的 `RemoteDialog` 增加一个昵称输入框（可选）。host/port 仍必填。

### 7.3 串口列表分组折叠

复用 macros 的成熟模式（`groupBy` + `Set<string> collapsed` + localStorage，见 `App.tsx:1224-1246`）：

- 新增 state：`portGroupsCollapsed: Set<string>`，持久化 localStorage key `port-groups-collapsed`。
- 渲染 `activity === "ports"` 分支（`App.tsx:1126-1190`）改为：
  - 「本地」卡（`devId="local"`，默认展开）
  - 每个远程设备卡：标题 = 昵称（无则 `host:port`）+ 在线状态点 + 编辑/删除按钮 + ▶/▼ caret；展开时列出 `portsByDev[devId]`。
- 端口项复用现有 `port-item-row` 结构（状态点、`PortLabel`、holders、编辑别名、强制关闭）；强制关闭按钮仅对**本地**已开端口保留——`force_close_others` 是本地 UI 特权（见 CLAUDE.md 不变量），远程 WS 客户端不具备，远程端口默认不显示该按钮。

### 7.4 Tab 来源标识

终端 Tab 标题逻辑：当 `remotes.length > 0` 且 Tab 所属 `devId !== "local"` 时，标题后缀 `· ${nickname ?? host}`。仅本地时无后缀，避免冗余。

## 8. 事件 / 数据流（多源路由）

每个 Transport 实例各自注册回调，回调闭包捕获 `devId`：

- `onPorts((list) => setPortsByDev(prev => ({ ...prev, [devId]: list.map(p => ({ ...p, devId })) }))))` —— 端口列表写入对应 devId 分组。
- `onData((name, bytes) => { const term = terminalsRef.current.get(portIdOf(devId, name)); term?.write(bytes); })` —— 数据路由到复合键对应的 `TermInstance`。
- `onConnectedChange((online) => setDevOnline(prev => ({ ...prev, [devId]: online })))` —— 更新状态点。

每条远程 WS 是独立 EventBus 订阅，数据天然按 Transport 隔离，不串数据。

`openPort` / `closePort` / `write` / `runMacro` / `runScript` 等操作按目标 `devId` 派发到对应 Transport 实例。

## 9. 错误处理

- **远程建连失败**（地址错/设备离线）：该卡显示错误态 + 「重试」按钮，不影响本地与其他远程卡。`onConnectedChange(false)` 驱动状态点变灰。
- **WS 运行中断线**：状态点变灰，`portsByDev[devId]` 保留但端口项标 stale（灰显），提供「重连」按钮（dispose 后重新按需建连）。该 devId 活跃 Tab 保留 scrollback，重连后继续。
- **端口被别会话占用**：远程 server 端 `SerialManager` 的 acquire/attach 模型**完全不变**；前端「已开 → 附加」逻辑接到对应 devId 的 Transport，复用现有 `triggerPort`（`App.tsx:787-798`）三分支。
- **删除有活跃 Tab 的设备**：先关闭该 devId 所有 Tab（销毁 `TermInstance`、从 `Group.ports` 移除、必要时坍缩 `PaneNode`），再 dispose Transport，再从 localStorage 移除。

## 10. 测试策略

- **`ss-core`**：零改动，现有单测（含 `concurrent_acquire_one_opens_one_attaches_no_leak`）全绿。这是回归红线。
- **后端**：仅移除 `open_remote_window` command；无新逻辑需测。
- **前端单测**（集中在纯函数与状态机）：
  - `portIdOf` / `parsePortId` 编解码往返（含 devId 含 `-`、name 含 `/` 等边界）。
  - 引用计数生命周期：`需求 = expanded OR hasActiveTab` 的 true/false 翻转触发 create/dispose，且不重复 create、不漏 dispose。
  - `loadRemotesLocal` / `persistRemotesLocal` 往返。
  - 多源 `onData` 路由：同 name 不同 devId 不串数据。
- **手工验收**：添加/编辑/删除设备、断网重连、本地与远程 Tab 混排拖拽、删除有活跃 Tab 的设备。

## 11. 改动清单（影响文件）

**前端 `ui/src/`**：

- `transport.ts`：无接口改动（`Transport` 接口不变），仅消费方从单例改多实例。
- `App.tsx`：核心改造——`transportsRef` 多实例、`portsByDev` state、复合键迁移、按需连接 effect、活动栏按钮语义、串口列表分组折叠、Tab 标题。
- `types.ts`：`Group.ports`/`activePort` 改 `PortId`；新增 `RemoteDevice` 类型；端口复合键纯函数。
- `lib.ts`：新增 `loadRemotesLocal` / `persistRemotesLocal`。
- `components.tsx`：`RemoteDialog` 加昵称字段。
- 新增（可选）：若 `App.tsx` 过载，抽 `useRemoteDevices` hook 与 `PortSidebar` 组件降复杂度。

**后端 `crates/tauri-app/src/main.rs`**：

- 移除 `open_remote_window` command 及其 invoke_handler 注册。

**`ss-core` / `ss-server`**：不动。

## 12. 风险与权衡

- **`App.tsx` 体量**：该文件已较大，本次改动面广。缓解：必要时抽 `useRemoteDevices`（设备 CRUD + 持久化）与 `useMultiTransport`（多实例生命周期）两个 hook，保持 `App.tsx` 在可维护体量。
- **复合键迁移面广**：触及 `Group`、`terminalsRef`、`ports`、`triggerPort`、DOM reparent 等多处。缓解：集中两个纯函数编解码，类型层面用 `PortId` 别名收口。
- **localStorage 语义**：客户端偏好性质，不可像 `macros.json` 那样随 exe 备份；桌面端单用户场景可接受（YAGNI，不引后端 JSON）。
- **远程默认无认证**：沿用现有安全模型（服务器默认绑 `0.0.0.0` 且无认证），本改造不改变安全姿态。

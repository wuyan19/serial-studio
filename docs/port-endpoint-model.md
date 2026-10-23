# 端口端点模型：设备 + 端点结构化元数据

端口行线格式（`PortView`）此前只携带 `{name, opened, holders, alias}`，端点类别与属主设备两个语义信息不进协议。UI 只能拿 pid 首段字符串 + sshHosts/remotes 两张异步表交叉猜——而 pid 首段在 web/级联形态下是连接桶（`"remote"`），不是设备 id。本文记录结构化改造的设计：两个用户可见 bug（web 模式打开 SSH shell 弹串口参数面板、多台 SSH 设备的端点都叫 `shell` 无法区分）是同一根源的表现。

## 决策：键不动，语义走字段

评估过「结构化寻址」（把 open/write/二进制帧的 port 参数换成 `{deviceId, endpoint}` 结构）：波及 WS 协议全家、manager 键空间、AddressResolver、Tauri 通道注册、脚本/MCP 的 `test::COM5` 寻址语法、device-protocol.md（对外契约，board-bridge 参考实现依赖）。结论：

- `name` 复合键保持扁平字符串，仍是唯一寻址键，但**降级为不透明句柄**；
- 语义（类别/属主/实例序号）全部走端口行新增的结构化字段；
- UI 侧全面停止「解析字符串猜语义」，仅保留老 server 回退路径。

## 线格式：PortView 新增三字段（additive）

```json
{
  "name": "sshUuid::shell", "opened": false, "holders": 0, "alias": null,
  "kind": "ssh",
  "instance": 2,
  "device": { "id": "sshUuid", "label": "测试机", "detail": "wuyan@10.0.0.5:22", "via": "ssh", "online": null }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | string | `"serial"` \| `"ssh"`。字符串枚举而非 Rust enum：与 `SshEndpointRecord.type` 同理，为新端点类型（exec/tcp）留前向兼容空间（新版对端的新值不得让旧版反序列化失败） |
| `instance` | u16? | `Some(n)` = 运行实例行（`shell@N`）；缺省 = 端点定义行/串口行。取代 UI 的 `name.includes("@")` 嗅探 |
| `device` | DeviceView? | 属主设备的原始信息（非连接桶），每行内嵌 |

`DeviceView` 字段：

| 字段 | 说明 |
|---|---|
| `id` | 设备稳定 id（`"local"` / 远端实例 id / SSH host uuid） |
| `label` | 已解析展示名：昵称优先，回退 `user@host` / `host:port` / `"本机"` |
| `detail` | 悬停/详情用完整地址；本机为 None |
| `via` | `"local"` \| `"remote"` \| `"ssh"`——hub 通过什么够到该设备 |
| `online` | 仅 `via="remote"` 有值（hub 知道设备连接状态）；SSH 懒连接、本机恒在，均为 None |

三字段全部 `Option` + `serde(default, skip_serializing_if)`：旧版对端（DeviceClient 解析远端上报）反序列化得 `None`，新版自身输出恒填充。

## 生成规则（server 侧 `list_ports_with_meta`）

| 来源 | kind | instance | device |
|---|---|---|---|
| 本地串口（裸名） | `serial` | — | `{id:"local", label:"本机", via:"local"}` |
| SSH 端点行（注册表） | 端点 `type` 映射：`shell`→`ssh` | — | `{id, label(), detail:user@host:port, via:"ssh"}` |
| SSH 实例行（快照） | 同上 | 名尾 `@N` 解析 | 同上 |
| 远端桶透传 | 原样保留 | 原样保留 | **改写规则见下** |

**透传改写（唯一允许动 device 的位置）**：远端行的 `device` 为 `None`（旧版对端）或 `via=="local"`（对端自己的串口）时，hub 改写为本机 remotes 注册表里该直连设备的记录（id/昵称/地址/在线态，`via:"remote"`）；其余（对端的 SSH 设备、对端的远端）原样透传。由此维持不变量：**每一跳把「对端自称本机」翻译成「对端这台设备」，行上的 device 恒为绝对属主**。多级级联（`devB::devC::COM3`）的 device 因此指 origin 设备 devC——级联口在 UI 归 origin 设备分组，不再归直连中转。

## 兼容策略

- 桌面端 server/UI 同包发布，无版本偏斜；仅 web 模式可能「UI 新、server 旧」。
- UI 回退：条目缺 `kind` → `triggerPort` 沿用旧判定（pid 首段 ∈ 本地 sshHosts）；缺 `device` → 分桶沿用旧字符串解析。回退路径标注遗留，server 全量部署后可删。
- 老对端（DeviceClient）：`None` 字段透传即回退，hub 改写规则同时给老对端的裸名行补上结构化属主（升级 hub 即得收益，不要求对端同步升级）。

## UI 消费改造

**pid 单源化（ingest 一次定型）**：pid 必须恒等于 `wireToPid(transport域, 服务端线名)`——事件回流（onData/onOpened/…）都按此键路由，若按设备桶键另算 pid，web 模式下会与事件键错位（`sshUuid::shell` vs `remote::sshUuid::shell`）丢数据。因此 `ports_listed` 在 reducer 入口即为每行算好 pid 存入桶（`PortInfo & {pid}`），侧栏/palette/查表全部消费该字段，`bucketPidOf` 的散落使用收敛消除。

**分桶规则（reducer）**：行有 `device` 时按 `via=="local" ? transport域 : device.id` 分桶（web 模式 server 自家串口归 `"remote"` 卡、SSH/远端各归各）；无 `device` 沿用旧逻辑（本地按首段、远程整桶）。效果：web 模式 SSH 卡恢复填充，级联口归 origin 设备。

**六个消费点改读字段（回退保留）**：

| 消费点 | 旧（字符串猜测） | 新 |
|---|---|---|
| `triggerPort` 弹不弹串口参数框 | pid 首段 ∈ sshHosts | `kind !== "serial"` 直连不弹 |
| 通道条 PTY 标注 | 同上判定 | `kind==="ssh"` 显 `device.detail · PTY`，否则 `formatConfig` |
| palette 次行设备标注 | `portDeviceLabelOf` 拆首段查表 | `device.label`（via=local 在 web 形态改标所连 server，桌面不标） |
| 侧栏实例行 ✕ | `name.includes("@")` | `instance != null` |
| tab 来源标注 | 首段查 remotes | `device.label`（via!=local 才标） |
| 附加提示/记录文件名设备段 | 首段查表 | `device.label` 兜底旧查表 |

`portInfoOf` 改为扁平 `pid → PortInfo` 映射（ingest pid 单源的派生），不再按桶+parsePortId 反查。

## 展示规范（别名优先，原始名可查）

- 端点：`PortLabel` 现状 `别名(真名)` 保留。
- 设备：卡头/次行用 `label`；悬停出 `detail · id`。
- 原始名/ID 查看入口：palette 条目 tooltip（label · detail · 完整键）、侧栏卡头 tooltip、通道条设备段 tooltip（现状）、通用设备详情弹窗（`RemoteDetailDialog` 泛化为 `DeviceDetailDialog`，remote/ssh/本机三类卡右键均可达，SSH 卡多展示认证方式与端点清单，不含凭据）。

## 随手清理（P2）

- **instance_aliases 惰性回收**：现为进程生命周期驻留，已关实例的别名仍进寻址索引。在 `list_ports_with_meta` 末尾按 manager 快照 `retain`（快照是已开端口全集，实例别名键是其子集）。实现字段注释自述的「关闭即失」语义，不做事件管道。
- **Acquired 回显收敛**：不改协议（`AcquireResult` 也被 device 协议消费，动它要同步对外契约，收益不配）。UI 侧 `kind!=="serial"` 时不显波特率串、附加提示不写「沿用既有配置 115200 波特」。
- 删 App 侧 `aliasableNames` 陈旧注释（实例行铅笔实际支持且工作正常，走内存别名表）。

## 测试

- Rust：PortView 线形状契约（新字段 Some 必现/None 不现）；透传改写纯函数（via=local 改写为直连设备、None 补齐、ssh 原样）；实例序号解析；instance_aliases retain。
- 前端：store 分桶（device 分桶 + 新旧回退两形态）；ingest pid 单源。
- 冒烟：隔离实例（`SERIAL_STUDIO_CONFIG_DIR` + 错峰端口）验证 web 形态 SSH shell 不弹参数面板、palette 可区分、侧栏 SSH 卡填充。

## 落地顺序

P0 = server 三字段 + 透传改写 + UI 六消费点与分桶/pid 单源；P1 = 设备详情泛化 + palette tooltip；P2 = 上节清理。一次交付，独立提交点。

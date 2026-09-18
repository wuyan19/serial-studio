# Serial Studio 远程设备协议（设备端实现指南）

本文面向要在**自己的硬件**上实现 Serial Studio 设备端的外部实现者——不跑完整 serial-studio，只用几十 KB 的自有程序把本机串口接入某个 Serial Studio 实例（下称 **hub**），进而获得 Web UI、脚本引擎与 **MCP 工具**的全套能力（hub 作为 AI agent 的中转）。

参考实现：[`examples/ss-board-bridge.c`](../examples/ss-board-bridge.c)（单文件 C，静态编译约几十 KB，任何 Linux 开发板可用）。Release 页附带六个架构（x86_64 / aarch64 / armv7 / riscv64 / mips / mipsel）的预编译静态二进制与 sha256 清单，零编译直接部署。

> 协议权威定义在 [`crates/server/src/protocol.rs`](../crates/server/src/protocol.rs)；本文是对**设备端所需子集**的人话版。两侧实现都应以此为准做兼容性演进。

## 1. 角色与连接方向

- **hub**：跑 serial-studio 的机器（桌面版或 headless `ss-server`）。用户在 hub 的 UI 里把你的设备注册为「远程设备」（地址 + 昵称）。
- **设备端**（你实现的程序）：在设备上监听一个 TCP 端口，接受 hub 的**主动外连**。hub 的设备客户端是唯一预期连接方，使用**单条持久 WS 连接**，断线后自动重连（1s 起指数退避，上限 30s）。

```
AI agent ──MCP──▶ hub (serial-studio) ──WS──▶ 设备端 (你的程序) ──▶ /dev/ttyS1
```

hub 侧零配置改动：设备注册、昵称寻址（`昵称::端口名`）、在线人数、多级级联、MCP 工具对设备端口的支持——全部复用现有机制。

## 2. 传输层

- WebSocket（RFC 6455），端点路径 **`/ws`**，即 hub 连接 `ws://<设备IP>:<端口>/ws`。设备端实现可只校验 `Upgrade: websocket`，路径宽容处理。
- 无 TLS、无认证（与 serial-studio 自身一致）——**只应监听在可信网络**。
- 两类帧：
  - **Text**：JSON 控制消息（下文全部消息）。
  - **Binary**：串口 RX 数据帧（仅设备端 → hub 方向；见 §5）。

## 3. 消息封装

- 客户端 → 服务器（hub → 设备端）：`{"action": "<snake_case 动作>", ...}`（`action` 标签）。
- 服务器 → 客户端（设备端 → hub）：`{"type": "<snake_case 类型>", ...}`（`type` 标签）。
- 所有名称/字段均为 snake_case。

## 4. 连接生命周期（设备端视角）

1. **建连**：完成 HTTP Upgrade。serial-studio 的 hub 会在建连后立即推 `ports` / `devices` 快照；你的设备端**也可以**在 Upgrade 完成后立即推一份 `ports` 快照（hub 会缓冲处理），也可以完全不推（hub 稍后会主动 `list`）。
2. **握手（必须）**：hub 发 `{"action":"version","instance_id":"<hub 的 uuid>"}`；你必须立即回：
   ```json
   {"type":"version","version":"<你的版本串>","enable_scripting":<bool>,"instance_id":"<设备 uuid>"}
   ```
   - `instance_id` 是**设备永久身份**：hub 用它作复合键前缀（`<设备id>::<端口名>`）对上号。首次生成后必须持久化（文件/nvram），跨重启不变——身份漂移会让 hub 侧端口键失效。
   - 不回此消息 → hub 握手失败、放弃连接。
3. **列表**：hub 发 `{"action":"list"}` → 回 `{"type":"ports","ports":[...]}`（格式见 §6.1）。hub 上线与重连后都会拉一次。
4. **命令循环**：hub 按需发 `open`/`write`/`close`/`set_alias`，你逐条应答（§6）。
5. **断线**：TCP 断开即清理串口句柄；hub 会自动重连并重拉列表。重连后此前打开状态全部失效（hub 侧也会相应重置）。

## 5. 数据帧（Binary，设备端 → hub）

串口 RX 数据以 WS Binary 帧推送，布局：

```
[端口名长度: 1 字节][端口名: UTF-8 裸字节][串口原始字节...]
```

- 端口名 = `open` 请求里的 `port` 原样（也是你 `ports` 列表里的 `name`）。
- 二进制直传，**不做 base64/转义**；长度含端口名前缀，受单个 WS 帧上限约束，建议单帧 ≤ 16 KiB（读到多少推多少即可）。
- hub → 设备端的写入**不走 Binary**，走 JSON `write` 动作（§6.4）。

## 6. 消息参考（设备端需实现的全集）

### 6.1 list → ports

```json
→ {"action":"list"}
← {"type":"ports","ports":[
     {"name":"ttyS1","opened":true,"holders":1,"disconnected":false},
     {"name":"ttyUSB0","opened":false,"holders":0,"disconnected":false}
   ]}
```

- `name`：端口名（自定义，如 `ttyS1`、`gps`；不含 `::`）。
- `holders`：当前持有方数。单连接实现恒为 opened ? 1 : 0 即可。

### 6.2 version → version

见 §4 第 2 步。`enable_scripting` 对设备端无意义（脚本引擎在 hub 侧跑），回 `true`/`false` 均可。

### 6.3 open → acquired / error

```json
→ {"action":"open","port":"ttyS1","req":7,
   "config":{"baud_rate":115200,"data_bits":"eight","stop_bits":"one",
             "parity":"none","flow_control":"none",
             "line_ending":"crlf","timeout_ms":100}}
← {"type":"acquired","port":"ttyS1","opened":true,
   "config":{...实际生效配置...},"holders":1,"resolved":"ttyS1","req":7}
```

或失败：`{"type":"error","message":"open ttyS1: 设备忙","port":"ttyS1","req":7}`

- `config` 各字段可缺省（hub 的默认值即上例值）。`line_ending`/`timeout_ms` 是 hub 侧程序行为语义，设备端**可忽略**。
- **`resolved` 必须回端口真名**（= 请求的 `port`，你没有别名层）：hub 的设备客户端靠它登记 IO，缺失或与数据帧端口名不一致会导致 RX 断流。
- `opened`：本次是首开（true）还是附加到已开口（false）。`req` 原样回带（hub 用于回执配对）。
- 枚举线值（全部小写）：
  - `data_bits`：`five` | `six` | `seven` | `eight`
  - `stop_bits`：`one` | `two`
  - `parity`：`none` | `odd` | `even`
  - `flow_control`：`none` | `software` | `hardware`

### 6.4 write → ok / error

```json
→ {"action":"write","port":"ttyS1","data":"AT\r\n","encoding":"text","req":8}
← {"type":"ok","message":"","port":"ttyS1","req":8}
```

- `encoding`：`"text"`（data 为 UTF-8 原文，按字节写入）或 `"hex"`（data 为十六进制串，如 `"48656C6C6F"`，解码后写入）。
- 成功回 `ok`（message 可空串），失败回 `error`（带 port/req）。

### 6.5 close → ok

```json
→ {"action":"close","port":"ttyS1","req":9}
← {"type":"ok","message":"","port":"ttyS1","req":9}
```

未打开的端口重复 close 回 `ok`（幂等）。

### 6.6 set_alias → ok

```json
→ {"action":"set_alias","port":"ttyS1","alias":"GPS","req":10}
← {"type":"ok","message":"","port":"ttyS1","req":10}
```

别名归属端口所在机器——参考实现仅回 `ok` 不存储（hub 侧重启后列表自然还原）；要持久化自行实现。

### 6.7 可忽略的入站动作

hub 的设备客户端只会发上述 6 种动作。收到其它动作（`run_script` 等）忽略并记日志即可。

## 7. 行为契约（踩坑清单）

1. **instance_id 永固**：跨重启不变是硬约定；持久化失败时宁可拒绝启动，也不要每次换 id。
2. **resolved = 数据帧端口名**：`acquired.resolved`、数据帧里的端口名、`ports[].name` 三者必须同源。
3. **write 的 text 编码即 UTF-8 字节**：注意 JSON 字符串反转义（`\n`、`\uXXXX` 等）后再写串口。
4. **WS 协议细节**：客户端帧必带掩码（需解掩）；收到协议层 Ping 回 Pong；对端发 Close 要回 Close。
5. **单连接假设**：hub 只建一条连接。第二条连接到来时拒绝或排队由你定（参考实现：忙时关闭新连接）。
6. **背压**：WS 发送阻塞时丢弃最旧的 RX 数据比无限缓存安全（参考实现：发送失败直接断连让 hub 重连）。

## 8. 接入与验证

1. hub 上：UI「远程设备」注册你的设备地址（如 `192.168.1.50:18700`）并起昵称（如 `gBoard`）。
2. 设备端口以 `gBoard::ttyS1` 出现在 hub 的端口列表；Web UI 直接打开收发。
3. MCP 侧（hub 开 `enable_scripting` 后）：`serial_list` 可见、`serial_send` / `serial_send(port="gBoard::ttyS1", ...)`、脚本 `send("AT", "gBoard::ttyS1")` 全部可用——AI agent 到开发板串口的链路到此闭环。

下面是完整定义。设计目标：**12 个工具，覆盖“发现 → 租约 → 通道 I/O → 归还”全流程；管理面（设备/拓扑 CRUD）与脚本引擎不在本 server 暴露。**

> **实施定稿（2026-11-05，与本文的差异）**：骨架采纳，以下四点按评审修订落地。
>
> 1. **管理面留在同一 server**（不拆 TopoHub-Admin）：设备/拓扑 CRUD 是本产品核心能力（UI 已有），AI 完整流程"注册→建拓扑→调试→释放"需要同一会话；MCP 无工具分组标准，"单独分组不进默认列表"落不了地。管理 6 个工具经 `is_admin_tool()` 在 tools/list **隐藏**（tools/call 照常分发），后期按需开放。
> 2. **`get_device` 的 device 改可选**：不传=列表。原文案 `acquire_lease(devices=[...])` 支持裸设备存在，仅靠 拓扑→成员 链路发现不了它们——"发现层断链"。`get_topology` 同形（原文 `list_topologies` 与之合并）。
> 3. **砍掉登录自动化**：exec_command 不做"登录、回显剥离、分页处理（--More--）"——设备族差异大（自研 mini-Netmiko 黑洞）。只做 发送+等待+近原始输出；agent 读带噪终端输出无压力。
> 4. **会话标识 = open_session 返回的设备通道本身**：不引入独立 session_id——`send_input`/`read_output`/`close_session` 用相同 `device(+channel)` 寻址（串口通道物理单线，同租约内单连接复用；SSH 同一 PTY）。
>
> 未采纳：`outputSchema` 结构化输出（二期，当前文本面）、`destructiveHint` 之外的 annotation 变体、`device.online`（设备是逻辑实体，在线态在通道层）。
> 落地：`crates/topo-hub/src/session.rs`（会话管理器）+ `mcp_topo.rs`（11 工具面）；分叉声明 `builtin_tools_visible()=false`（内置 serial_* 不进 tools/list）；通道寻址=序号/标签子串/缺省规则。工具实测见 `docs/topo-hub-design.md` §5。

---

## 0. 设计约定

**寻址模型**
- `device` 必填，接受设备 id 或名称。
- `channel` 可选，接受 `channel_id` 或管理员起的别名（如 `console`、`ssh-admin`）。
- 不传 `channel`：设备只有一个通道时直接用；多个通道时用 `is_default` 的通道；没有默认通道则报错，错误信息列出可选通道。
- 所有 I/O 工具返回 `channel_used`，Agent 可据此在后续调用中显式复用。

**租约模型**
- 租约是**设备级排他**声明，覆盖设备的所有通道。拿到租约 = 有写权限，不需要再“打开端口”。
- 通道的物理连接由平台在 I/O 调用时惰性建立/复用，连接池是平台实现细节，不暴露。
- 租约到期自动释放；`renew_lease` 顺延。

**返回结构**
- 所有工具返回 JSON 对象，不用扁平字符串。
- 文本型输出放在 `data` / `stdout` 字段，附带 `cursor`、`truncated`、`timed_out` 等元数据。
- 游标 `cursor` 是不透明字符串，Agent 只需原样回传。

**Annotations**
- 只读工具：`readOnlyHint: true`
- 租约/会话生命周期：`readOnlyHint: false, destructiveHint: false`
- 通道写操作：`readOnlyHint: false, destructiveHint: true`（通道可执行任意命令，安全默认应标记）

---

## 1. 工具清单

| # | 工具 | 层 | 读/写 | 风险 |
|---|---|---|---|---|
| 1 | `list_topologies` | 发现 | R | 低 |
| 2 | `get_topology` | 发现 | R | 低 |
| 3 | `get_device` | 发现 | R | 低 |
| 4 | `list_my_leases` | 发现 | R | 低 |
| 5 | `acquire_lease` | 租约 | W | 低 |
| 6 | `renew_lease` | 租约 | W | 低 |
| 7 | `release_lease` | 租约 | W | 低 |
| 8 | `exec_command` | I/O | W | **高** |
| 9 | `open_session` | I/O | W | 低 |
| 10 | `send_input` | I/O | W | **高** |
| 11 | `read_output` | I/O | R | 低 |
| 12 | `close_session` | I/O | W | 低 |

---

## 2. 发现层

### 2.1 `list_topologies`

```jsonc
{
  "name": "list_topologies",
  "description": "列出全部拓扑（名称、id、成员数、描述）。调试前先看这里选拓扑。",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "topologies": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "topology_id": { "type": "string" },
            "name": { "type": "string" },
            "description": { "type": "string" },
            "member_count": { "type": "integer" },
            "busy": { "type": "boolean", "description": "是否有成员设备被租约占用" }
          },
          "required": ["topology_id", "name", "member_count"]
        }
      }
    },
    "required": ["topologies"]
  }
}
```

### 2.2 `get_topology`

```jsonc
{
  "name": "get_topology",
  "description": "获取拓扑详情：成员设备清单（含通道摘要、在线状态、占用状态）与设备间连线。成员设备 id 或名称可直接用于 acquire_lease / exec_command。",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "topology": { "type": "string", "description": "拓扑 id 或名称" }
    },
    "required": ["topology"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "topology_id": { "type": "string" },
      "name": { "type": "string" },
      "description": { "type": "string" },
      "members": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "device_id": { "type": "string" },
            "name": { "type": "string" },
            "model": { "type": "string" },
            "location": { "type": "string" },
            "note": { "type": "string" },
            "online": { "type": "boolean" },
            "lease_holder": { "type": ["string", "null"] },
            "lease_expires_at": { "type": ["string", "null"] },
            "channels": {
              "type": "array",
              "items": { "$ref": "#/$defs/channel" }
            }
          },
          "required": ["device_id", "name", "online", "channels"]
        }
      },
      "links": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "from": { "type": "string" },
            "from_port": { "type": "string" },
            "to": { "type": "string" },
            "to_port": { "type": "string" },
            "label": { "type": "string" }
          },
          "required": ["from", "to"]
        }
      }
    },
    "required": ["topology_id", "name", "members", "links"],
    "$defs": {
      "channel": {
        "type": "object",
        "properties": {
          "channel_id": { "type": "string" },
          "alias": { "type": "string" },
          "type": { "enum": ["serial", "ssh"] },
          "endpoint": { "type": "string", "description": "serial=端口键；ssh=host:port" },
          "username": { "type": "string" },
          "baud_rate": { "type": "integer" },
          "is_default": { "type": "boolean" },
          "access_hint": { "enum": ["readonly", "readwrite", "unknown"] },
          "status": { "enum": ["idle", "in_use", "offline"] }
        },
        "required": ["channel_id", "type", "is_default", "status"]
      }
    }
  }
}
```

### 2.3 `get_device`

```jsonc
{
  "name": "get_device",
  "description": "获取单台被测设备的详情：通道清单（含寻址信息、默认通道、访问提示）、当前租约占用、在线状态。",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "device": { "type": "string", "description": "设备 id 或名称" }
    },
    "required": ["device"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "device_id": { "type": "string" },
      "name": { "type": "string" },
      "model": { "type": "string" },
      "location": { "type": "string" },
      "online": { "type": "boolean" },
      "channels": { "type": "array", "items": { "$ref": "#/$defs/channel" } },
      "lease": {
        "type": ["object", "null"],
        "properties": {
          "lease_id": { "type": "string" },
          "holder": { "type": "string" },
          "expires_at": { "type": "string" },
          "mine": { "type": "boolean" }
        }
      }
    },
    "required": ["device_id", "name", "online", "channels"],
    "$defs": { "channel": { "...": "同 get_topology 的 channel 定义" } }
  }
}
```

### 2.4 `list_my_leases`

```jsonc
{
  "name": "list_my_leases",
  "description": "列出本会话当前持有的活跃租约（id、覆盖设备、到期时间）。用于会话恢复或确认归还状态。",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "leases": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "lease_id": { "type": "string" },
            "devices": { "type": "array", "items": { "type": "string" } },
            "holder": { "type": "string" },
            "expires_at": { "type": "string" },
            "remaining_seconds": { "type": "integer" }
          },
          "required": ["lease_id", "devices", "expires_at"]
        }
      }
    },
    "required": ["leases"]
  }
}
```

---

## 3. 租约层

### 3.1 `acquire_lease`

```jsonc
{
  "name": "acquire_lease",
  "description": "申请设备租约（设备级排他，all-or-nothing）。可通过 topology 或 devices 指定范围，二选一或并用取并集。冲突时整体拒绝并返回各设备当前持有者与到期时间；给 wait_timeout_ms 则服务端排队等待。默认 30 分钟，长任务用 renew_lease 顺延。持有租约后才可执行 exec_command / open_session。",
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false },
  "inputSchema": {
    "type": "object",
    "properties": {
      "topology": { "type": "string", "description": "拓扑 id 或名称（成员设备并集）" },
      "devices": {
        "type": "array",
        "items": { "type": "string" },
        "description": "设备 id 或名称列表"
      },
      "holder": { "type": "string", "description": "持有者自报名（展示与审计用，如 claude/agent-1）" },
      "ttl_minutes": { "type": "integer", "default": 30, "minimum": 1, "description": "有效分钟数，上限由平台配置" },
      "wait_timeout_ms": { "type": "integer", "default": 0, "maximum": 600000, "description": "冲突时服务端排队等待毫秒数" }
    },
    "anyOf": [
      { "required": ["topology"] },
      { "required": ["devices"] }
    ],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "lease_id": { "type": "string" },
      "holder": { "type": "string" },
      "expires_at": { "type": "string" },
      "devices": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "device_id": { "type": "string" },
            "name": { "type": "string" },
            "channels": { "type": "array", "items": { "$ref": "#/$defs/channel" } }
          },
          "required": ["device_id", "name", "channels"]
        }
      },
      "conflicts": {
        "type": "array",
        "description": "仅失败时返回：冲突设备及当前持有者",
        "items": {
          "type": "object",
          "properties": {
            "device_id": { "type": "string" },
            "holder": { "type": "string" },
            "expires_at": { "type": "string" }
          }
        }
      }
    },
    "required": ["lease_id", "expires_at", "devices"]
  }
}
```

### 3.2 `renew_lease`

```jsonc
{
  "name": "renew_lease",
  "description": "续租：顺延到期时间。仅持有会话可续。",
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "lease_id": { "type": "string" },
      "ttl_minutes": { "type": "integer", "default": 30, "minimum": 1 }
    },
    "required": ["lease_id"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "lease_id": { "type": "string" },
      "expires_at": { "type": "string" }
    },
    "required": ["lease_id", "expires_at"]
  }
}
```

### 3.3 `release_lease`

```jsonc
{
  "name": "release_lease",
  "description": "释放租约（用完即还）。仅持有会话可释放。释放后平台自动关闭该租约下由本会话建立的通道连接。",
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "lease_id": { "type": "string" }
    },
    "required": ["lease_id"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "released": { "type": "boolean" }
    },
    "required": ["released"]
  }
}
```

---

## 4. 通道 I/O 层

### 4.1 `exec_command`

**主路径工具。** 发一条命令，一次调用拿完整输出。适用于不需要跨命令保持 CLI 状态的场景。

```jsonc
{
  "name": "exec_command",
  "description": "在设备通道上执行一条命令并返回输出。平台负责登录、回显剥离、分页处理（--More-- 等）、空闲收尾；不解析命令语义。适用于不需要保持 CLI 状态的单条命令（show/display/ping 等）。连续调用会复用平台连接池，不会重复登录。若需进入配置模式逐行下发或观察持续输出，改用 open_session + send_input。",
  "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false },
  "inputSchema": {
    "type": "object",
    "properties": {
      "device": { "type": "string", "description": "设备 id 或名称" },
      "channel": { "type": "string", "description": "通道 id 或别名；省略时用默认通道，多通道无默认则报错并列出可选通道" },
      "command": { "type": "string", "description": "要执行的命令（单条）" },
      "idle_ms": { "type": "integer", "default": 300, "description": "收到首字节后，无新数据多少毫秒视为输出结束" },
      "prompt_regex": { "type": "string", "description": "可选：匹配到该正则即提前结束等待（如设备提示符）" },
      "max_bytes": { "type": "integer", "default": 262144, "description": "单次返回上限，超出截断并置 truncated=true" }
    },
    "required": ["device", "command"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "stdout": { "type": "string", "description": "命令输出（已剥离回显、已处理分页）" },
      "channel_used": { "type": "string", "description": "实际使用的 channel_id，便于后续显式复用" },
      "truncated": { "type": "boolean" },
      "timed_out": { "type": "boolean", "description": "是否因 idle_ms 超时收尾（正常结束为 false）" },
      "cursor": { "type": "string", "description": "截断时用于续读的游标" }
    },
    "required": ["stdout", "channel_used", "truncated", "timed_out"]
  }
}
```

### 4.2 `open_session`

**持久终端入口。** 需要跨命令保持状态（配置模式、交互式程序）或持续观察输出时使用。

```jsonc
{
  "name": "open_session",
  "description": "在设备通道上打开一个持久终端会话。适用于需要保持 CLI 状态的场景：进入配置模式逐行下发、运行交互式程序、观察 debug/monitor 持续输出。会话绑定具体通道，后续 send_input/read_output 只需传 session_id。使用完必须 close_session。",
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false },
  "inputSchema": {
    "type": "object",
    "properties": {
      "device": { "type": "string", "description": "设备 id 或名称" },
      "channel": { "type": "string", "description": "通道 id 或别名；省略规则同 exec_command" },
      "terminal_type": { "type": "string", "description": "可选：终端类型提示（如 vt100），平台按通道默认值处理" }
    },
    "required": ["device"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "session_id": { "type": "string" },
      "channel_used": { "type": "string" },
      "initial_banner": { "type": "string", "description": "登录后已到达提示符前的初始输出（可能为空）" }
    },
    "required": ["session_id", "channel_used"]
  }
}
```

### 4.3 `send_input`

**主路径工具。** 一次调用 = 发送 + 等待 + 返回本条响应。语义对齐你原来的 `serial_send(timeout_ms)`。

```jsonc
{
  "name": "send_input",
  "description": "向会话发送数据并等待响应，一次调用返回本条命令的输出。wait_ms>0 时：首字节最多等到 wait_ms；收到首字节后 idle_ms 内无新数据即收尾。wait_ms=0 时只发不等（发密码、Ctrl+C、y 确认等）。读取不破坏缓冲区：返回 data 为本次新增增量，cursor 指向已读位置；仅当 truncated=true 时需用 read_output(since=cursor) 补读剩余。",
  "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false },
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": { "type": "string" },
      "data": { "type": "string", "description": "要发送的数据" },
      "wait_ms": { "type": "integer", "default": 2000, "description": "等待首字节的超时；0 表示只发不等" },
      "idle_ms": { "type": "integer", "default": 250, "description": "收到首字节后无新数据多少毫秒视为结束" },
      "max_bytes": { "type": "integer", "default": 65536, "description": "单次返回上限，超出截断并置 truncated=true" },
      "prompt_regex": { "type": "string", "description": "可选：匹配到该正则即提前结束等待" },
      "append_newline": { "type": "boolean", "default": true, "description": "是否自动追加换行（发密码等场景设 false）" }
    },
    "required": ["session_id", "data"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "data": { "type": "string", "description": "本次新增输出" },
      "cursor": { "type": "string" },
      "truncated": { "type": "boolean" },
      "timed_out": { "type": "boolean" }
    },
    "required": ["data", "cursor", "truncated", "timed_out"]
  }
}
```

### 4.4 `read_output`

**辅助工具。** 不再是主路径第二步。只服务三种场景：补读截断部分、异步持续输出、主动轮询。

```jsonc
{
  "name": "read_output",
  "description": "读取会话输出。辅助工具，通常不需要在 send_input 之后调用。三种用途：(1) send_input 返回 truncated=true 时传 since=cursor 补读剩余；(2) 异步持续输出（debug/monitor/tail）时轮询新数据；(3) 主动回看历史（since=\"0\" + tail_bytes 限制）。默认 since=latest：从当前末尾开始等新数据，不重放历史。",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": { "type": "string" },
      "since": { "type": "string", "description": "游标；省略等价于 latest（只读新数据）；\"0\" 表示从头" },
      "tail_bytes": { "type": "integer", "description": "since=\"0\" 时只取末尾 N 字节，避免回看全量历史" },
      "max_bytes": { "type": "integer", "default": 65536, "description": "单次返回上限" },
      "timeout_ms": { "type": "integer", "default": 0, "description": "无新数据时等待毫秒数；0 表示立即返回" }
    },
    "required": ["session_id"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "data": { "type": "string" },
      "cursor": { "type": "string" },
      "dropped_bytes": { "type": "integer", "description": "因缓冲区滚动被丢弃的字节数（>0 表示中间有缺口）" },
      "truncated": { "type": "boolean" },
      "timed_out": { "type": "boolean" }
    },
    "required": ["data", "cursor", "dropped_bytes", "truncated"]
  }
}
```

### 4.5 `close_session`

```jsonc
{
  "name": "close_session",
  "description": "关闭持久终端会话。不释放租约；租约需单独 release_lease。",
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": { "type": "string" }
    },
    "required": ["session_id"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "closed": { "type": "boolean" }
    },
    "required": ["closed"]
  }
}
```

---

## 5. 典型调用序列

**场景 A：跑几条 show 命令**
```
get_topology("lab-1")
acquire_lease(topology="lab-1", holder="claude/agent-1")
exec_command(device="sw1", command="show version")
exec_command(device="sw1", command="show ip route")
release_lease(lease_id)
```

**场景 B：进配置模式逐行下发（每条命令一次调用）**
```
acquire_lease(devices=["sw1"])
open_session(device="sw1", channel="ssh-admin")
send_input(session_id, "configure terminal")
send_input(session_id, "interface Gi0/1")
send_input(session_id, "description uplink")
send_input(session_id, "end")
close_session(session_id)
release_lease(lease_id)
```

**场景 C：观察 debug 持续输出**
```
acquire_lease(devices=["sw1"])
open_session(device="sw1")
send_input(session_id, "debug ip ospf events", wait_ms=0)
read_output(session_id, timeout_ms=5000)   // 轮询增量
read_output(session_id, timeout_ms=5000)
close_session(session_id)
release_lease(lease_id)
```

**场景 D：截断补读**
```
send_input(session_id, "show running-config")  // 返回 truncated=true, cursor="c_7f3"
read_output(session_id, since="c_7f3")          // 拿剩余部分
```

---

## 6. 关键决策说明

**为什么 `exec_command` 和 `open_session` 并存？** 前者不要求 Agent 管理会话生命周期，适合独立命令，平台池化连接；后者要求显式 open/close，换来跨命令保持 CLI 状态的能力。两套入口，底层同一套通道 I/O，复杂度按需递增。`send_input` 的 `wait_ms` 语义保证后者也是“一次调用拿结果”，不会退化成 send/recv 两步。

**为什么没有 `serial_*` 和 `port_*`？** 字节级原语和端口占用模型对 Agent 是多余概念。`exec_command` 覆盖一次性命令，`open_session` + `send_input` 覆盖持久交互，租约合并了端口占用。串口和 SSH 在工具层无差别——差异在 `channel.type` 元数据里，Agent 不需要为此换工具。

**为什么 `exec_command` 标记 `destructiveHint: true`？** 通道可以执行任意命令，平台不解析语义，无法区分 `show` 和 `reload`。安全默认是标记为可能破坏性，由客户端决定是否弹确认。如果你们的客户端希望减少打断，可以在客户端侧配置对 `exec_command` 跳过确认，但服务端不应替 Agent 假设命令安全。

**为什么租约是设备级而不是通道级？** 调试时 Agent 经常需要多通道协作（SSH 跑命令、串口看 boot log）。通道级租约会导致“我持有 ssh-admin 但另一个 Agent 持有 console”的混乱。设备级租约 + 租约内自由切换通道，语义更简单。

**管理面去哪了？** `device_create/update/delete`、`topo_create/update/delete`、脚本库 CRUD 全部移出本 server，放到独立的 `TopoHub-Admin`。Agent 的工作流里没有“创建设备”，只有“发现 → 用 → 还”。如果平台一定要在同一 server 暴露，应放在单独的工具分组并标记 `destructiveHint: true`，且不在默认工具列表中。
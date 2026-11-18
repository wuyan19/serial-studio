//! MCP (Model Context Protocol) JSON-RPC 处理层。
//!
//! 移植自 terminal-serial，适配 serial-studio 的异步 SerialManager + 多串口：
//! - 工具加 `port` 参数（缺省时用唯一打开的串口）
//! - handle_request 与各 tool 函数均为 async（调 manager 的 async 方法）
//! - 暴露 10 工具：list(含单口详情)/send/read/grep/clear + script(执行,code|name)
//!   + save(含 delete)/get(含 list) 脚本库 + port_open/close。
//!   并入的旧粒度(serial_status/debug_script/run_script/list_scripts/delete_script)
//!   保留为分发别名——tools/list 不出现，老调用方不破。

use crate::address::AliasMatch;
use crate::AppState;
use serde_json::{json, Value};
use tokio::sync::broadcast;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// MCP 会话注册表（进程级）：token → manager 会话。port_open 等有状态
/// MCP 操作的持有主体——同 token 的开/关/写共用一个会话，端口占用按会话计；
/// topo-hub 强释放租约时经 [`mcp_session_of`] 找到会话，收回该 AI 开的端口。
/// 进程级 static 而非 AppState 字段：会话是 MCP 层概念，与请求状态无关。
static MCP_SESSIONS: std::sync::Mutex<
    Option<std::collections::HashMap<String, ss_core::SessionId>>,
> = std::sync::Mutex::new(None);

/// 取（或建）token 的 MCP 会话。
pub fn session_for(token: &str) -> ss_core::SessionId {
    let mut g = MCP_SESSIONS.lock().expect("mcp sessions lock poisoned");
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    *map.entry(token.to_string())
        .or_insert_with(ss_core::SessionId::next)
}

/// 查 token 的 MCP 会话（无则 None，不建）。
pub fn mcp_session_of(token: &str) -> Option<ss_core::SessionId> {
    MCP_SESSIONS
        .lock()
        .expect("mcp sessions lock poisoned")
        .as_ref()?
        .get(token)
        .copied()
}
pub async fn handle_request(body: &str, state: &AppState) -> Value {
    handle_request_with(None, body, state).await
}

/// 带入站会话（Mcp-Session-Id 头）的完整处理。二次宿主的集成测试用它
/// 模拟标准客户端的头回传。
pub async fn handle_request_with(session: Option<&str>, body: &str, state: &AppState) -> Value {
    let request: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("Parse error: {}", e) }
            });
        }
    };

    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => {
            return json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32600, "message": "Invalid Request: missing method" }
            });
        }
    };
    let params = request.get("params").cloned().unwrap_or(json!({}));

    let result = match method {
        "initialize" => json!(handle_initialize(&state.mcp_extensions)),
        "notifications/initialized" => return json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!(handle_tools_list(&state.mcp_extensions)),
        "tools/call" => handle_tools_call(&params, session, state).await,
        "prompts/list" => json!(handle_prompts_list()),
        "prompts/get" => json!(handle_prompts_get(&params)),
        "ping" => json!({}),
        _ => {
            return json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {}", method) }
            });
        }
    };

    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn handle_initialize(extensions: &[std::sync::Arc<dyn crate::mcp_ext::McpExtension>]) -> Value {
    // serverInfo.name 默认 serial-studio；分叉产品经扩展声明自己的名字
    // （谁分叉谁声明，同 builtin_tools_visible 范式）
    let server_name = extensions
        .iter()
        .find_map(|e| e.server_name())
        .unwrap_or_else(|| "serial-studio".into());
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": false },
            "prompts": { "listChanged": false }
        },
        "serverInfo": { "name": server_name, "version": env!("CARGO_PKG_VERSION") },
        // 会话令牌：调用方身份的凭据（租约持有/释放等扩展语义绑定它）。
        // 每次 initialize 新签；标准客户端回传 Mcp-Session-Id 头（handler 已回签），
        // 其余客户端可显式传工具的 token 参数。
        "session_token": uuid::Uuid::new_v4().to_string(),
    })
}

fn handle_tools_list(extensions: &[std::sync::Arc<dyn crate::mcp_ext::McpExtension>]) -> Value {
    // 域扩展可声明替代内置工具面（分叉）——任一扩展声明隐藏即隐藏（分叉是全局
    // 决策：宿主要么暴露 serial_* 要么用扩展面，不存在混搭）。无扩展=all(空)=true
    // ——serial-studio 主产品行为不变。内置 serial_*/port_* 不进清单
    // （tools/call 照常分发，仅影响发现）。
    let builtin_visible = extensions.iter().all(|e| e.builtin_tools_visible());
    let mut tools: Vec<Value> = if builtin_visible {
        json!([
            {
                "name": "serial_list",
                "description": "列出所有端口(本机串口/远程设备/SSH 终端):完整键、别名、设备昵称与寻址提示、打开状态,中点分隔的扁平单行。传 port 时改为输出该端口的详细配置(串口=波特率/数据位/校验/流控/占用数;SSH 设备=连接身份与端点)——须已打开。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5）；传了输出该端口详细配置而非清单" }
                    }
                }
            },
            {
                "name": "serial_send",
                "description": "发送数据到串口并可选等待设备响应。timeout_ms>0 时等待并返回响应：首字节最多等到超时，其后 250ms 无新数据即收尾。该读取是破坏性的（清空缓冲），勿再用 grep/read 接力取同一响应。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "data": { "type": "string", "description": "要发送的数据" },
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text", "description": "data 的编码：text 为文本，hex 为十六进制" },
                        "auto_newline": { "type": "boolean", "default": true, "description": "text 模式是否追加换行" },
                        "timeout_ms": { "type": "integer", "default": 0, "description": "发送后等待响应的超时（毫秒），0 不等待" }
                    },
                    "required": ["data"]
                }
            },
            {
                "name": "serial_read",
                "description": "读取串口接收缓冲区数据（破坏性，读后清空）。空时按 timeout_ms 等待。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text", "description": "输出编码：text 为文本，hex 为十六进制" },
                        "timeout_ms": { "type": "integer", "default": 100, "description": "缓冲区空时等待超时（毫秒）" }
                    }
                }
            },
            {
                "name": "serial_grep",
                "description": "在接收缓冲区中搜索匹配模式（非破坏、可反复；返回全部匹配）。text 模式为行正则，hex 模式按字节序列。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "pattern": { "type": "string", "description": "搜索模式" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text", "description": "pattern 的编码：text 为文本（正则），hex 为十六进制字节序列" },
                        "timeout_ms": { "type": "integer", "default": 1000, "description": "等待匹配的超时（毫秒）" }
                    },
                    "required": ["pattern"]
                }
            },
            {
                "name": "serial_clear",
                "description": "清空指定串口的接收缓冲区。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址:完整键/别名/昵称作用域(test::COM5),缺省=唯一打开的串口" }
                    }
                }
            },
            {
                "name": "serial_script",
                "description": "在串口上执行 JS 脚本（QuickJS）：传 code 临时执行一段源码（调通后可经 serial_save_script 落库复用），或传 name 执行脚本库中已保存的脚本——二选一。脚本内可用 send/expect/clear/sleep（均可带 [port] 跨串口，缺省为脚本运行端口）、同步 log（日志随本工具响应返回；服务端开启日志自动落盘时同时写入磁盘并在响应末尾给出文件路径）及读写宿主机文件的 file_stat/file_md5/read_file/read_b64_chunk/write_file/append_file；签名与约束详见 serial_script_guide prompt，调用前先获取。受 enable_scripting 开关限制，默认关闭；运行上限 5 分钟，超时中止。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "JS 源码（临时执行；顶层可直接 await，如 await send(\"AT\")）——与 name 二选一" },
                        "name": { "type": "string", "description": "脚本库中的脚本名（serial_get_script 不传 name 可查）——与 code 二选一" },
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "args": { "type": "object", "description": "运行时参数（注入脚本 args.<name>），键值均 string；按 name 执行时未传的键用脚本声明的 default 填充", "additionalProperties": { "type": "string" } }
                    }
                }
            },
            {
                "name": "serial_save_script",
                "description": "脚本库（scripts.json）写入：保存（或覆盖）一个 JS 脚本供日后经 serial_script 按名执行或在 UI 复用；delete=true 时删除该名脚本（幂等）。name 是唯一存取键，已存在则覆盖。数据管理而非执行代码，不受 enable_scripting 限制。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "脚本唯一名（存取键，如 \"init-modem\"）" },
                        "code": { "type": "string", "description": "JS 源码（顶层可直接 await）；省略且 delete=true 时为删除" },
                        "delete": { "type": "boolean", "description": "true 时删除该名脚本（幂等），与 code 互斥", "default": false },
                        "description": { "type": "string", "description": "用途说明（可选）" },
                        "group": { "type": "string", "description": "分组名（可选，UI 按组折叠）" },
                        "params": {
                            "type": "array",
                            "description": "声明的运行时参数（可选），运行时收集值注入脚本 args.<name>",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string", "description": "args.<name> 取值键名" },
                                    "label": { "type": "string", "description": "UI 显示标签；缺省用 name" },
                                    "type": { "type": "string", "enum": ["string", "select", "file"], "description": "参数类型；file 表示值为宿主机文件路径（配合脚本内 read_b64_chunk/file_md5 等文件函数）" },
                                    "default": { "type": "string", "description": "缺省值（可选）" },
                                    "options": { "type": "array", "items": { "type": "string" }, "description": "select 的可选项；string 类型留空" }
                                },
                                "required": ["name", "type"]
                            }
                        }
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "serial_get_script",
                "description": "查看脚本库（scripts.json）：不传 name 列出所有脚本的元数据（name/description/group/params，不含 code 全文）；传 name 返回该脚本的完整定义（含 code 全文）——覆盖改写前先经此取原文。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "脚本名；省略则列出全部脚本元数据" }
                    }
                }
            },
            {
                "name": "port_open",
                "description": "打开端口：串口按给定配置打开；SSH 端点建立 PTY 会话；端口已开则附加共享（首开配置生效，附加者忽略所传配置）。须会话标识（initialize 取 token，标准客户端自动带头）。端口占用挂在本会话上，port_close / 租约强释放都会按会话收回。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "端口键（本机串口名/SSH 端点键/别名，serial_list 可查）" },
                        "baud_rate": { "type": "integer", "default": 115200, "description": "波特率（仅串口首开生效）" },
                        "line_ending": { "type": "string", "enum": ["lf", "crlf"], "default": "lf", "description": "text 模式发送的换行符（仅串口首开生效；连 Windows/AT 设备选 crlf）" }
                    },
                    "required": ["port"]
                }
            },
            {
                "name": "port_close",
                "description": "关闭本会话持有的端口：是末位持有者则真正关闭，否则仅退出持有（他人继续用）。只能关自己会话开的口。须会话标识。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "端口键（本会话曾 port_open 的）" }
                    },
                    "required": ["port"]
                }
            }
    ])
        .as_array()
        .cloned()
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    for ext in extensions {
        // 管理面工具隐藏（声明方决定；tools/call 照常分发）
        tools.extend(ext.tools().into_iter().filter(|t| {
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("");
            !ext.is_admin_tool(name)
        }));
    }
    json!({ "tools": tools })
}

async fn handle_tools_call(params: &Value, session: Option<&str>, state: &AppState) -> Value {
    let name = match params.get("name").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return error_text("Missing tool name".into()),
    };
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    // 调用方身份：工具参数 token 优先，其次 Mcp-Session-Id 头（initialize 签发）。
    // 皆无 → 匿名。租约/写闸等扩展语义消费；内置串口工具自身不感知。
    let principal = arguments
        .get("token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
        .or(session)
        .map(str::to_string);
    let principal = principal.as_deref();
    // 写类工具的准入钩子（如 topo-hub 写闸）。放行才进正常分发。
    if matches!(
        name,
        "serial_send"
            | "serial_read"
            | "serial_clear"
            | "serial_script"
            | "serial_debug_script"
            | "serial_run_script"
            | "port_open"
            | "port_close"
    ) {
        if let Some(denied) = crate::mcp_ext::intercept(
            &state.mcp_extensions,
            name,
            arguments.clone(),
            principal,
            state,
        )
        .await
        {
            return denied;
        }
    }
    match name {
        "serial_list" => tool_serial_list(arguments, state).await,
        // 旧粒度别名：并入后的同名语义经参数分支还原，老调用方不破
        //（delete 例外——旧调用无 delete 标志，须走原处理器）
        "serial_status" => tool_serial_status(arguments, state).await,
        "serial_send" => tool_serial_send(arguments, state).await,
        "serial_read" => tool_serial_read(arguments, state).await,
        "serial_grep" => tool_serial_grep(arguments, state).await,
        "serial_clear" => tool_serial_clear(arguments, state).await,
        "serial_script" | "serial_debug_script" | "serial_run_script" => {
            tool_serial_script(arguments, principal, state).await
        }
        "serial_save_script" if state.access.config().enabled || state.devices.has_private_devices() =>
            error_text("保护模式下请在本机编辑脚本".into()),
        "serial_save_script" => tool_serial_save_script(arguments, &state.script_bus).await,
        "serial_delete_script" if state.access.config().enabled || state.devices.has_private_devices() =>
            error_text("保护模式下请在本机编辑脚本".into()),
        "serial_delete_script" => tool_serial_delete_script(arguments, &state.script_bus).await,
        "serial_get_script" | "serial_list_scripts" => tool_serial_get_script(arguments).await,
        "port_open" => tool_port_open(arguments, principal, state).await,
        "port_close" => tool_port_close(arguments, principal, state).await,
        other => {
            // 内置未命中 → 委托扩展（topo-hub 等）；扩展也不认得才是真未知。
            match crate::mcp_ext::dispatch(
                &state.mcp_extensions,
                other,
                arguments,
                principal,
                state,
            )
            .await
            {
                Some(result) => result,
                None => error_text(format!("Unknown tool: {}", other)),
            }
        }
    }
}

/// 解析 port 参数为规范键。缺省时用唯一打开的串口。
///
/// 解析交给 manager 边界的 canon_key(别名单点定义):裸名/端口别名/设备昵称作用域
/// (`test::COM5`)统一解析。canon 对"多命中歧义"只能 warn+透传(热路径无错误通道),
/// 这里用同一 AddressResolver 索引把候选讲清楚——单一真相,呈现分化。
async fn resolve_port(args: &Value, state: &AppState) -> Result<String, String> {
    let manager = &state.manager;
    if let Some(p) = args.get("port").and_then(|v| v.as_str()) {
        let key = manager.canon_key(p);
        if crate::access_http::restricted(state, &key) {
            return Err("此连接不允许通过 MCP 访问".into());
        }
        // 输入是裸名且未被解析改写 → 查索引区分"无此别名"与"歧义"
        let norm = ss_core::normalize_port_key(p);
        if norm == key && !norm.contains(ss_core::PORT_KEY_SEP) {
            if let AliasMatch::Ambiguous(cands) = state.addresses.lookup_port(&norm) {
                return Err(format!(
                    "端口别名「{}」匹配多个端口 {:?},请使用完整键或设备昵称作用域(如 设备昵称::端口)",
                    norm, cands.into_iter().filter(|key| !crate::access_http::restricted(state, key)).collect::<Vec<_>>()
                ));
            }
        }
        return Ok(key);
    }
    let open: Vec<_> = manager.list_open_ports().await.into_iter()
        .filter(|key| !crate::access_http::restricted(state, key)).collect();
    match open.len() {
        1 => Ok(open[0].clone()),
        0 => Err("未打开任何串口，请先在 UI 打开或通过 WS 的 open 命令".into()),
        _ => Err(format!("打开了多个串口 {:?}，必须指定 port 参数", open)),
    }
}

/// port_open：打开端口（占用挂 token 对应的 MCP 会话上）。已开则附加共享。
async fn tool_port_open(args: Value, principal: Option<&str>, state: &AppState) -> Value {
    let Some(port) = args.get("port").and_then(|v| v.as_str()) else {
        return error_text("缺少参数 port（要打开的端口键，serial_list 可查）".into());
    };
    let Some(token) = principal else {
        return error_text(
            "打开端口须会话标识：initialize 取 token（标准客户端自动带头），或在工具参数传 token"
                .into(),
        );
    };
    let line_ending = match args.get("line_ending").and_then(|v| v.as_str()) {
        Some("crlf") => ss_core::LineEnding::CRLF,
        Some("lf") | None => ss_core::LineEnding::LF,
        Some(other) => return error_text(format!("line_ending 仅支持 lf/crlf: {other}")),
    };
    let config = ss_core::SerialConfig {
        baud_rate: args
            .get("baud_rate")
            .and_then(|b| b.as_u64())
            .unwrap_or(115_200) as u32,
        line_ending,
        ..ss_core::SerialConfig::default()
    };
    let session = session_for(token);
    match state
        .manager
        .acquire(port.to_string(), config, session)
        .await
    {
        Ok(ss_core::AcquireResult::Opened {
            config,
            holders,
            resolved,
        }) => ok_text(format!(
            "已打开 {resolved}（{} 波特，{} 人持有，首开配置已生效）",
            config.baud_rate, holders
        )),
        Ok(ss_core::AcquireResult::Attached {
            config,
            holders,
            resolved,
        }) => ok_text(format!(
            "已附加 {resolved}（端口已开，{} 人持有，现行配置 {} 波特——附加不改配置）",
            config.baud_rate, holders
        )),
        Err(e) => error_text(format!("打开失败: {e}")),
    }
}

/// port_close：仅释放本会话的持有（末位才真正关闭）。
async fn tool_port_close(args: Value, principal: Option<&str>, state: &AppState) -> Value {
    let Some(port) = args.get("port").and_then(|v| v.as_str()) else {
        return error_text("缺少参数 port".into());
    };
    let Some(token) = principal else {
        return error_text("关闭端口须会话标识（token 参数或 Mcp-Session-Id 头）".into());
    };
    let Some(session) = mcp_session_of(token) else {
        return error_text("本会话未曾打开过端口（只能关自己开的口）".into());
    };
    match state.manager.release(port, session).await {
        Ok(ss_core::ReleaseOutcome::Closed) => {
            ok_text(format!("已关闭 {port}（本会话是末位持有者）"))
        }
        Ok(ss_core::ReleaseOutcome::Released { remaining }) => ok_text(format!(
            "已退出持有 {port}（还有 {remaining} 人，端口保持打开）"
        )),
        Ok(ss_core::ReleaseOutcome::NotHeld) => {
            error_text(format!("本会话未持有 {port}（端口未开或不是你开的）"))
        }
        Err(e) => error_text(format!("关闭失败: {e}")),
    }
}

async fn tool_serial_list(args: Value, state: &AppState) -> Value {
    // 传 port → 该端口详细配置（原 serial_status 并入）；不传列全部端口
    if args.get("port").and_then(|v| v.as_str()).is_some() {
        return tool_serial_status(args, state).await;
    }
    // 合并视图(本地 + 远端设备桶 + 别名 + 本地占有权覆盖)——与 UI/REST/WS 同一数据源,
    // 远程设备的端口对 MCP 可见且带远端别名(下沉后 MCP 免费获得远程能力的落点)
    let mut views = crate::list_ports_with_meta(state).await;
    views.retain(|v| !crate::access_http::restricted(state, &v.info.name));
    if views.is_empty() {
        return ok_text("未发现任何串口".into());
    }
    let mut out = Vec::with_capacity(views.len());
    for v in views {
        // 扁平单行:键 · 别名 · [SSH ]设备 昵称 · 寻址 提示 · 状态 [· N 人]。
        // 消费者是 agent——中点分隔的一层结构最易解析(此前三层嵌套括号)。
        // 键保留完整复合键:open 需要机器可用的精确名。
        let mut parts = vec![v.info.name.clone()];
        let dev_id = ss_core::split_port_key(&v.info.name).0;
        let is_ssh = dev_id != ss_core::LOCAL_DEVICE_ID && state.ssh.has_host(dev_id);
        if let Some(a) = &v.alias {
            // SSH 行标"端点别名"——与设备昵称说破两个身份(裸名=端点别名,前缀=设备昵称)
            let label = if is_ssh { "端点别名" } else { "别名" };
            parts.push(format!("{label} {a}"));
        }
        if dev_id != ss_core::LOCAL_DEVICE_ID {
            // 提示用裸后缀(目标机上的端口名),拼出的 昵称::<后缀> 才是可解析寻址;
            // SSH 标记让 agent 一眼区分终端会话与串口(交互方式不同)
            let suffix = ss_core::split_port_key(&v.info.name).1;
            let kind = if is_ssh { "SSH 设备" } else { "设备" };
            match state.addresses.nickname_of(dev_id) {
                Some(nick) => {
                    parts.push(format!("{kind} {nick}"));
                    parts.push(format!("寻址 {nick}::{suffix}"));
                }
                None => parts.push(format!("{kind} {dev_id}")),
            }
        }
        if v.info.opened {
            parts.push("open".into());
            if v.info.holders > 0 {
                parts.push(format!("{} 人", v.info.holders));
            }
        } else {
            parts.push("closed".into());
        }
        out.push(parts.join(" · "));
    }
    ok_text(out.join("\n"))
}

async fn tool_serial_send(args: Value, state: &AppState) -> Value {
    let manager = &state.manager;
    let port = match resolve_port(&args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let data_str = match args.get("data").and_then(|d| d.as_str()) {
        Some(d) => d,
        None => return error_text("Missing required parameter: data".into()),
    };
    let format = args
        .get("format")
        .and_then(|f| f.as_str())
        .unwrap_or("text");
    let auto_newline = args
        .get("auto_newline")
        .and_then(|a| a.as_bool())
        .unwrap_or(true);

    // 换行由端口 line_ending 决定（open 时配），这里只声明是否追加
    match manager.send_canonical(&port, data_str, format, auto_newline).await {
        Ok(0) => error_text("No data to send".into()),
        Ok(n) => {
            let timeout_ms = args.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(0);
            if timeout_ms > 0 {
                // 带静默期读取：首字节等到 timeout_ms，之后连续无新数据即视为响应完整，
                // 避免 drain() 取首片即返回导致多分片响应被截断。
                // 静默期 250ms：交互式 CLI「立即回显→执行停顿→输出」两段式间隔常大于
                // 40ms；代价是每次调用尾延约 +210ms,换完整响应值得
                let resp = manager
                    .drain_buffer_quiet_canonical(&port, timeout_ms, 250)
                    .await
                    .unwrap_or_default();
                if resp.is_empty() {
                    ok_text(format!("Sent {} bytes, no response", n))
                } else {
                    ok_text(String::from_utf8_lossy(&resp).into_owned())
                }
            } else {
                ok_text(format!("Sent {} bytes", n))
            }
        }
        Err(e) => error_text(format!("Send failed: {}", e)),
    }
}

async fn tool_serial_read(args: Value, state: &AppState) -> Value {
    let manager = &state.manager;
    let port = match resolve_port(&args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(|t| t.as_u64())
        .unwrap_or(100);
    let format = args
        .get("format")
        .and_then(|f| f.as_str())
        .unwrap_or("text");

    let data = match manager.drain_buffer_canonical(&port, timeout_ms).await {
        Ok(d) => d,
        Err(e) => return error_text(e.to_string()),
    };
    let output = match format {
        "hex" => data
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::from_utf8_lossy(&data).to_string(),
    };
    ok_text(output)
}

async fn tool_serial_status(args: Value, state: &AppState) -> Value {
    let manager = &state.manager;
    let port = match resolve_port(&args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    match manager.status_canonical(&port).await {
        Some(cfg) => {
            let holders = manager.holder_count_canonical(&port).await.unwrap_or(0);
            // 别名从合并视图取(本地 ports.json + 远端缓存透传),远端口的别名也能展示
            let alias = crate::list_ports_with_meta(state)
                .await
                .into_iter()
                .find(|v| v.info.name == port)
                .and_then(|v| v.alias);
            let alias_line = match alias {
                Some(a) => format!("Alias: {}\n", a),
                None => String::new(),
            };
            // SSH 端点:串口参数无意义,显示连接身份(设备/认证/端点)——与通道条同语义
            let (dev, _rest) = ss_core::split_port_key(&port);
            let body = if dev != ss_core::LOCAL_DEVICE_ID && state.ssh.has_host(dev) {
                let rec = state
                    .ssh
                    .registry_snapshot()
                    .into_iter()
                    .find(|r| r.id == dev);
                match rec {
                    Some(r) => format!(
                        "SSH device: {} ({}@{}:{})\nAuth: {}\nEndpoint: {}\nHolders: {}",
                        r.label(),
                        r.username,
                        r.host,
                        r.port,
                        crate::ssh::auth_label_of(&r.auth),
                        _rest,
                        holders
                    ),
                    None => format!("Holders: {}", holders),
                }
            } else {
                format!(
                    "Baud rate: {}\nData bits: {:?}\nParity: {:?}\nStop bits: {:?}\nFlow control: {:?}\nLine ending: {:?}\nHolders: {}",
                    cfg.baud_rate, cfg.data_bits, cfg.parity, cfg.stop_bits, cfg.flow_control, cfg.line_ending, holders
                )
            };
            ok_text(format!("Port: {}\n{alias_line}{body}", port))
        }
        None => error_text(format!("Port {} not open", port)),
    }
}

async fn tool_serial_grep(args: Value, state: &AppState) -> Value {
    let manager = &state.manager;
    let port = match resolve_port(&args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return error_text("Missing required parameter: pattern".into()),
    };
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(|t| t.as_u64())
        .unwrap_or(1000);
    let format = args
        .get("format")
        .and_then(|f| f.as_str())
        .unwrap_or("text");

    if format == "hex" {
        let pat = match hex_to_bytes(pattern) {
            Ok(b) => b,
            Err(e) => return error_text(format!("Invalid hex pattern: {}", e)),
        };
        if pat.is_empty() {
            return error_text("Pattern is empty".into());
        }
        let matches = match manager.grep_buffer_bytes_canonical(&port, pat, timeout_ms).await {
            Ok(m) => m,
            Err(e) => return error_text(e.to_string()),
        };
        if matches.is_empty() {
            return ok_text("No match found (timeout)".into());
        }
        let out: Vec<String> = matches
            .iter()
            .map(|(pos, ctx)| {
                let hex: String = ctx
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("offset {}: {}", pos, hex)
            })
            .collect();
        ok_text(out.join("\n"))
    } else {
        match manager.grep_buffer_canonical(&port, pattern, timeout_ms).await {
            Ok(lines) => {
                if lines.is_empty() {
                    ok_text("No match found (timeout)".into())
                } else {
                    ok_text(lines.join("\n"))
                }
            }
            Err(e) => error_text(format!("Grep failed: {}", e)),
        }
    }
}

async fn tool_serial_clear(args: Value, state: &AppState) -> Value {
    let manager = &state.manager;
    let port = match resolve_port(&args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    match manager.clear_buffer_canonical(&port).await {
        Ok(()) => ok_text("Buffer cleared".into()),
        Err(e) => error_text(e.to_string()),
    }
}

/// 执行 JS 脚本(serial_script):code=临时执行调用方提供的源码(调通后可 save 落库),
/// name=执行脚本库(scripts.json)中已保存的脚本——二选一。旧名 serial_debug_script /
/// serial_run_script 为分发别名,同一分支语义。读到即快照——run 期间 save/delete
/// 覆盖同名脚本不影响本次执行(scripts_store 的 LOCK 只保证读不与写交错)。
async fn tool_serial_script(args: Value, principal: Option<&str>, state: &AppState) -> Value {
    let code = args.get("code").and_then(|c| c.as_str());
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty());
    match (code, name) {
        (Some(_), Some(_)) => {
            error_text("code 与 name 二选一：code=临时执行源码，name=执行脚本库中的脚本".into())
        }
        (Some(code), None) => {
            // 运行时参数 args(注入脚本 args.<name>);缺省空。值非 string 的条目跳过。
            let run_args = supplied_run_args(args.get("args"));
            let script = ss_core::Script {
                description: None,
                group: None,
                params: Vec::new(),
                code: code.to_string(),
            };
            execute_script(state, &args, principal, script, run_args, None).await
        }
        (None, Some(name)) => {
            // name 查找先于 execute_script 内的闸门:属只读元数据访问(list 工具本可见),无害;
            // 执行能力仍统一由闸门拦截。
            let script = match crate::scripts_store::load().get(name) {
                Some(s) => s.clone(),
                None => {
                    return error_text(format!(
                        "无脚本「{name}」,用 serial_get_script(不传 name)查看可用脚本"
                    ))
                }
            };
            let run_args = merge_run_args(&script.params, args.get("args"));
            execute_script(state, &args, principal, script, run_args, Some(name)).await
        }
        (None, None) => {
            error_text("缺少 code(临时执行源码)或 name(脚本库中的脚本名),二选一".into())
        }
    }
}

/// 脚本执行统一路径(enable_scripting 闸门 → 扩展写闸 → resolve_port → 端口预检 →
/// 并发上限 → run_script → 日志随响应返回)。serial_script 的 code/name 两分支共用,
/// 执行 JS 的工具必经此路——闸门语义单一真相,新增执行类工具不会漏拦。
/// `script_name` 用于落盘日志文件命名(debug 临时执行为 None)。
/// `principal`：调用方身份（token），用于扩展的逐次写闸（脚本内 send/clear 逐次检查）。
async fn execute_script(
    state: &AppState,
    args: &Value,
    principal: Option<&str>,
    script: ss_core::Script,
    run_args: std::collections::HashMap<String, String>,
    script_name: Option<&str>,
) -> Value {
    let manager = &state.manager;
    if state.access.config().enabled || state.devices.has_private_devices() {
        return error_text("保护模式下请在本机执行脚本".into());
    }
    // 远程 MCP 路径强制闸门:服务器无认证,脚本执行须显式开启
    if !state
        .enable_scripting
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return error_text("脚本执行未启用(settings.json 的 enable_scripting=false)".into());
    }
    let port = match resolve_port(args, state).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    // 端口预检:未打开则脚本内 send 静默失败却显示"完成",误导。
    if !manager.is_open_canonical(&port).await || manager.is_disconnected_canonical(&port).await {
        return error_text(format!("端口 {} 未打开或已断开", port));
    }
    // 并发上限(同 WS):防 DoS。permit 借用 semaphore,持到 run_script 完成(函数返回即释放)。
    let _permit = match state.script_semaphore.try_acquire() {
        Ok(p) => p,
        Err(_) => return error_text("脚本执行并发已满,稍后再试".into()),
    };
    // 落盘策略唯一在 script_logs(开关开才 Some)。MCP 响应内日志有 200 条/16KiB 上限,
    // 落盘是找回超限日志的手段——outcome 带回实际写过的路径,拼进响应供 read_file 读回。
    let log_file = crate::script_logs::log_file_for(&port, script_name);
    // 逐次写闸：从扩展获取 gate 函数（topo-hub 租约闸注入），脚本内每次 send/clear 检查。
    let write_gate = crate::mcp_ext::script_gate(&state.mcp_extensions, principal, state);
    let ss_core::ScriptRunOutcome {
        result,
        logs,
        log_file,
    } = ss_core::run_script(
        &port,
        &script,
        manager.clone(),
        run_args,
        log_file,
        write_gate,
    )
    .await;
    // 日志随结果返回(MCP 无实时推送出口):成功/失败/超时均拼上 log() 收集的输出,AI 才能调试脚本。
    // 空日志省略该段,避免噪音。
    let (mut text, ok) = match result {
        Ok(()) => (with_logs("脚本执行完成", &logs), true),
        Err(ref e) => (
            with_logs(&format!("脚本失败: {}", e.display_message()), &logs),
            false,
        ),
    };
    if let Some(p) = log_file {
        text.push_str(&format!(
            "\n完整日志已落盘: {}(超响应上限被截的日志可用 read_file 读回)",
            p.display()
        ));
    }
    if ok {
        ok_text(text)
    } else {
        error_text(text)
    }
}

/// 调用方显式提供的运行时参数(值非 string 的条目跳过,与 serial_script 的 code 分支一致)。
fn supplied_run_args(supplied: Option<&Value>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Some(Value::Object(m)) = supplied {
        for (k, v) in m {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// 运行时参数合并:显式 args 优先;**key 缺失**才用脚本 params 声明的 default 填充。
/// 显式空串视为已提供、不覆盖 default(与 UI 表单语义一致);key 存在但值非 string
/// 也视为已提供(跳过值、不填 default,别把"值非 string"当"缺 key")。
/// select 的 default 不在 options 中也宽容填入——save 侧不校验 options,run 侧校验
/// 会造成"能存不能跑"的坑。
fn merge_run_args(
    params: &[ss_core::ScriptParam],
    supplied: Option<&Value>,
) -> std::collections::HashMap<String, String> {
    let mut out = supplied_run_args(supplied);
    let present: std::collections::HashSet<&String> = match supplied {
        Some(Value::Object(m)) => m.keys().collect(),
        _ => std::collections::HashSet::new(),
    };
    for p in params {
        if !present.contains(&p.name) {
            if let Some(d) = &p.default {
                out.entry(p.name.clone()).or_insert_with(|| d.clone());
            }
        }
    }
    out
}

/// 拼接脚本日志到工具响应文本:有日志才附"脚本日志:"段,无日志原样返回(省噪音)。
fn with_logs(message: &str, logs: &[String]) -> String {
    if logs.is_empty() {
        message.to_string()
    } else {
        format!("{}\n\n脚本日志:\n{}", message, logs.join("\n"))
    }
}

// ===== 脚本库管理(纯数据,不碰串口、不受 enable_scripting 限制)=====
//
// save(含 delete)/get(含 list) 操作 scripts.json 配置文件,不执行任何 JS——故不经
// enable_scripting 闸门(该闸门语义是"是否允许远程执行 JS",防 RCE)。AI 调试好脚本后
// 经此落盘供日后复用。持久化的原子性/并发由 scripts_store 的进程内锁保证。

/// 脚本库写入:code=保存(或覆盖),delete=true=删除(幂等)——互斥。
/// 旧名 serial_delete_script 为分发别名,走原删除处理器。
async fn tool_serial_save_script(args: Value, script_bus: &broadcast::Sender<()>) -> Value {
    let name = match args.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return error_text("Missing required parameter: name".into()),
    };
    let delete = args
        .get("delete")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let code = match args.get("code").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => {
            return if delete {
                tool_serial_delete_script(args, script_bus).await
            } else {
                error_text("缺少 code(要保存的 JS 源码);删除该名脚本请传 delete=true".into())
            };
        }
    };
    if delete {
        return error_text("code 与 delete 互斥:保存传 code,删除只传 delete=true".into());
    }
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);
    let group = args.get("group").and_then(|v| v.as_str()).map(String::from);
    // params 反序列化为 ScriptParam;格式不符则当空(宽松,不因 params 误填阻断保存)。
    let params: Vec<ss_core::ScriptParam> = args
        .get("params")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .unwrap_or_default();
    let script = ss_core::Script {
        description,
        group,
        params,
        code,
    };
    match crate::scripts_store::upsert(&name, script) {
        Ok(Some(_)) => {
            let _ = script_bus.send(());
            ok_text(format!("已覆盖脚本「{}」", name))
        }
        Ok(None) => {
            let _ = script_bus.send(());
            ok_text(format!("已保存新脚本「{}」", name))
        }
        Err(e) => error_text(format!("保存失败: {}", e)),
    }
}

/// 查看脚本库:不传 name 列出全部脚本元数据(原 serial_list_scripts 并入,膨胀防护
/// 不含 code 全文);传 name 返回单个脚本完整定义(含 code)——AI 改写库脚本(save
/// 覆盖)前经此取原文。旧名 serial_list_scripts 为分发别名。
async fn tool_serial_get_script(args: Value) -> Value {
    let map = crate::scripts_store::load();
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty());
    let Some(name) = name else {
        // 只回元数据,不含 code 全文(list 膨胀防护;code 在 save 时已由调用方掌握)。
        let entries: Vec<Value> = map
            .iter()
            .map(|(name, s)| {
                json!({
                    "name": name,
                    "description": s.description,
                    "group": s.group,
                    "params": s.params,
                })
            })
            .collect();
        return ok_text(serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into()));
    };
    match map.get(name) {
        Some(s) => ok_text(
            serde_json::to_string_pretty(&json!({
                "name": name,
                "description": s.description,
                "group": s.group,
                "params": s.params,
                "code": s.code,
            }))
            .unwrap_or_else(|_| "{}".into()),
        ),
        None => error_text(format!("无脚本「{name}」,不传 name 可列出全部脚本")),
    }
}

async fn tool_serial_delete_script(args: Value, script_bus: &broadcast::Sender<()>) -> Value {
    let name = match args.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return error_text("Missing required parameter: name".into()),
    };
    match crate::scripts_store::remove(&name) {
        Ok(Some(_)) => {
            let _ = script_bus.send(());
            ok_text(format!("已删除脚本「{}」", name))
        }
        Ok(None) => ok_text(format!("无脚本「{}」(无需删除)", name)),
        Err(e) => error_text(format!("删除失败: {}", e)),
    }
}

// ===== helpers =====

fn ok_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_text(text: String) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = hex.replace(" ", "").replace("0x", "").replace(",", "");
    if !cleaned.len().is_multiple_of(2) {
        return Err("odd length".into());
    }
    (0..cleaned.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

// ===== prompts =====

fn handle_prompts_list() -> Value {
    json!({
        "prompts": [
            {
                "name": "serial_usage_guide",
                "description": "串口工具工作流指南：核心概念、推荐模式和常见陷阱",
                "arguments": []
            },
            {
                "name": "serial_script_guide",
                "description": "脚本编写指南：serial_script（code 临时执行 / name 调脚本库）的可用函数、约束（expect 返回空串、无 console、正则字符串等）与重试模式",
                "arguments": []
            }
        ]
    })
}

fn handle_prompts_get(params: &Value) -> Value {
    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    match name {
        "serial_usage_guide" => json!({
            "description": "串口工具工作流指南",
            "messages": [
                { "role": "user", "content": { "type": "text", "text": SERIAL_USAGE_GUIDE } }
            ]
        }),
        "serial_script_guide" => json!({
            "description": "脚本编写指南",
            "messages": [
                { "role": "user", "content": { "type": "text", "text": SERIAL_SCRIPT_GUIDE } }
            ]
        }),
        _ => error_text(format!("Unknown prompt: {}", name)),
    }
}

const SERIAL_USAGE_GUIDE: &str = r#"# 串口工具工作流指南

## 核心概念

**接收缓冲区**是 64KB FIFO，持续累积设备输出，满则丢弃最旧。

- `serial_read`：**破坏性**读取（读后清空）。
- `serial_grep`：**非破坏**搜索（可反复）。

## port 参数

除脚本库管理工具（`serial_save_script` / `serial_get_script`）外，各工具接受可选 `port` 参数。`serial_list` 传 port 时输出该端口的详细配置；其余工具不传时，若只打开了一个串口则自动选用；打开多个时必须显式指定。

## 寻址形式

- 裸端口名：本机串口（如 `COM5`、`/dev/ttyUSB0`）。
- 完整键：远端设备端口 `设备id::COM5`,多级级联逐段透传。
- 端口别名:UI 里设置的别名(如 `GPS`),本机优先,跨设备同名歧义时报候选。
- 设备昵称作用域:设备注册时设置的昵称(如 `test::COM5`)。末段叶别名在该设备
  作用域内唯一命中时本地即解析(`test::GPS` → 该设备的 GPS 别名端口);多级
  级联后缀逐段透传,由下一跳解析。昵称在设备列表唯一。

serial_list 输出为扁平单行(键 · 别名 · 设备 · 寻址 · 状态),SSH 终端带 SSH 设备标记。

## 推荐工作流

- 简单命令-响应：`serial_send(data="AT", timeout_ms=1000)`（一步拿响应；该读取破坏性清空缓冲）。
- 等待特定输出：`serial_send`（不设 timeout_ms）→ `serial_grep(pattern="OK", timeout_ms=3000)` → `serial_clear`。send 设了 timeout_ms 时响应已被其读走，勿再 grep/read 接力。
- 不要用 `serial_read` 轮询等待——每次读都会清空缓冲区，目标未到时数据会丢。

## 陷阱

- text 模式默认追加换行(按端口配置的 line_ending)，设 `auto_newline=false` 才发原始数据。
- `serial_grep` 等待期间新数据正常进缓冲区，不阻塞数据流。"#;

/// serial_script 的编写指南。与 skills/serial-studio-script/SKILL.md、
/// ss_server::SCRIPT_SKILL 三处同源(include_str! 同一文件)——改约束只改 SKILL.md。
const SERIAL_SCRIPT_GUIDE: &str = include_str!("../../../skills/serial-studio-script/SKILL.md");

#[cfg(test)]
mod tests {
    use super::*;
    use ss_core::{EventBus, RealPortOpener, SerialManager};
    use std::sync::Arc;

    /// 测试用 AppState(RealPortOpener + 空设备表;script_bus receiver 丢弃——
    /// 验证广播的测试自建 channel 保留 rx)。
    pub(super) fn make_state() -> AppState {
        let (tx, _) = broadcast::channel::<()>(16);
        make_state_with_script_bus(tx)
    }

    fn make_state_with_script_bus(script_tx: broadcast::Sender<()>) -> AppState {
        let event_bus = Arc::new(EventBus::new(16));
        let (meta_tx, _) = broadcast::channel(16);
        let devices = Arc::new(crate::device::DeviceClientManager::empty(
            script_tx.clone(),
            "inst-mcp-test",
        ));
        AppState {
            access: Default::default(),
            port_groups: Arc::new(crate::port_groups::PortGroupsStore::memory("inst-mcp-test")),
            manager: Arc::new(SerialManager::new(
                event_bus.clone(),
                Arc::new(RealPortOpener),
            )),
            event_bus,
            meta_bus: Arc::new(meta_tx.clone()),
            script_bus: Arc::new(script_tx.clone()),
            enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
            closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            addresses: Arc::new(crate::address::AddressResolver::new(
                Arc::clone(&devices),
                Arc::new(crate::ssh::SshManager::empty()),
                meta_tx,
                "inst-mcp-test".into(),
            )),
            devices,
            ssh: Arc::new(crate::ssh::SshManager::empty()),
            instance_id: "inst-mcp-test".into(),
            mcp_extensions: Vec::new(),
        }
    }

    #[tokio::test]
    async fn parse_error() {
        let resp = handle_request("not json", &make_state()).await;
        assert_eq!(resp["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn initialize() {
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            &make_state(),
        )
        .await;
        assert_eq!(resp["result"]["serverInfo"]["name"], "serial-studio");
    }

    #[tokio::test]
    async fn tools_list_contains_expected_tools() {
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            &make_state(),
        )
        .await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(
            tools.len(),
            10,
            "list/send/read/grep/clear + script + save/get + port_open/close"
        );
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"serial_script"));
        assert!(names.contains(&"serial_save_script"));
        assert!(names.contains(&"serial_get_script"));
        // 并入的旧粒度只剩分发别名,tools/list 不出现
        for old in [
            "serial_status",
            "serial_debug_script",
            "serial_run_script",
            "serial_list_scripts",
            "serial_delete_script",
        ] {
            assert!(!names.contains(&old), "旧名 {old} 不应出现在 tools/list");
        }
    }

    /// MCP 扩展点：注入的工具进 tools/list，tools/call 内置未命中时委托扩展，
    /// 扩展也不认得才报 Unknown tool。echo_principal 回显收到的 principal——
    /// 锁定"参数 token > 头 > 匿名"的解析契约。
    struct EchoExt;
    impl crate::mcp_ext::McpExtension for EchoExt {
        fn tools(&self) -> Vec<Value> {
            vec![json!({
                "name": "echo_test",
                "description": "测试扩展工具",
                "inputSchema": { "type": "object", "properties": {} }
            })]
        }
        fn call<'a>(
            &'a self,
            name: &'a str,
            args: Value,
            principal: Option<&'a str>,
            _state: &'a AppState,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>>
        {
            Box::pin(async move {
                match name {
                    "echo_test" => {
                        let msg = args
                            .get("msg")
                            .and_then(|m| m.as_str())
                            .unwrap_or("echo")
                            .to_string();
                        Some(ok_text(msg))
                    }
                    "echo_principal" => Some(ok_text(principal.unwrap_or("anonymous").to_string())),
                    _ => None,
                }
            })
        }
    }

    #[tokio::test]
    async fn mcp_extension_listed_and_dispatched() {
        let mut state = make_state();
        state.mcp_extensions = vec![std::sync::Arc::new(EchoExt)];

        let resp =
            handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, &state).await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 11, "10 内置 + 1 扩展(echo_test)");
        assert!(tools.iter().any(|t| t["name"] == "echo_test"));

        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo_test","arguments":{"msg":"hi"}}}"#,
            &state,
        )
        .await;
        assert_eq!(resp["result"]["content"][0]["text"], "hi");

        // 扩展返回 None(不认得)时透传给下一环——最终仍是 Unknown tool
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}}"#,
            &state,
        )
        .await;
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Unknown tool"));
    }

    /// 分叉与管理面声明：builtin_tools_visible=false 隐藏内置工具面（tools/call
    /// 照常分发）；is_admin_tool 声明的扩展工具不进 tools/list 但可调用。
    /// 默认值（两方法均未实现）= serial-studio 主产品行为不变（上方测试）。
    #[tokio::test]
    async fn extension_can_hide_builtin_and_admin_tools() {
        struct ForkExt;
        impl crate::mcp_ext::McpExtension for ForkExt {
            fn tools(&self) -> Vec<Value> {
                vec![
                    json!({ "name": "fork_tool", "description": "分叉面工具", "inputSchema": {"type":"object","properties":{}} }),
                    json!({ "name": "fork_admin", "description": "管理面工具", "inputSchema": {"type":"object","properties":{}} }),
                ]
            }
            fn is_admin_tool(&self, name: &str) -> bool {
                name == "fork_admin"
            }
            fn builtin_tools_visible(&self) -> bool {
                false
            }
            fn server_name(&self) -> Option<String> {
                Some("fork-product".into())
            }
            fn call<'a>(
                &'a self,
                name: &'a str,
                _args: Value,
                _principal: Option<&'a str>,
                _state: &'a AppState,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>>
            {
                Box::pin(async move { Some(ok_text(name.to_string())) })
            }
        }

        let mut state = make_state();
        state.mcp_extensions = vec![std::sync::Arc::new(ForkExt)];

        // initialize：serverInfo.name 报分叉产品自己的名字
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":0,"method":"initialize"}"#, &state).await;
        assert_eq!(resp["result"]["serverInfo"]["name"], "fork-product");

        // tools/list：内置隐藏 + 管理面隐藏 = 只剩 fork_tool
        let resp =
            handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, &state).await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["fork_tool"], "内置与管理面均不应出现");
        // 内置名不靠 tools/list 也能直接调用（隐藏≠禁用）
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_list","arguments":{}}}"#,
            &state,
        )
        .await;
        assert!(resp["result"]["isError"].is_null(), "内置名照常分发");
        // 管理面工具同理可调用
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fork_admin","arguments":{}}}"#,
            &state,
        )
        .await;
        assert_eq!(resp["result"]["content"][0]["text"], "fork_admin");
    }

    /// principal 解析契约：参数 token > Mcp-Session-Id 头 > 匿名。
    #[tokio::test]
    async fn principal_resolution_param_over_header() {
        let mut state = make_state();
        state.mcp_extensions = vec![std::sync::Arc::new(EchoExt)];

        // 匿名（无头无参）
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo_principal","arguments":{}}}"#,
            &state,
        )
        .await;
        assert_eq!(resp["result"]["content"][0]["text"], "anonymous");

        // 头（handle_request_with 模拟标准客户端回传）
        let resp = handle_request_with(
            Some("header-token"),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo_principal","arguments":{}}}"#,
            &state,
        )
        .await;
        assert_eq!(resp["result"]["content"][0]["text"], "header-token");

        // 参数覆盖头
        let resp = handle_request_with(
            Some("header-token"),
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo_principal","arguments":{"token":"param-token"}}}"#,
            &state,
        )
        .await;
        assert_eq!(resp["result"]["content"][0]["text"], "param-token");
    }

    /// initialize 签发 session_token（每次新签，非空 uuid）。
    #[tokio::test]
    async fn initialize_mints_session_token() {
        let a = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            &make_state(),
        )
        .await;
        let b = handle_request(
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}"#,
            &make_state(),
        )
        .await;
        let ta = a["result"]["session_token"].as_str().unwrap();
        let tb = b["result"]["session_token"].as_str().unwrap();
        assert!(
            !ta.is_empty() && ta != tb,
            "每次 initialize 新签: {ta} / {tb}"
        );
    }

    /// 会话注册表：同 token 复用会话，不同 token 各自建。
    #[test]
    fn session_registry_reuses_per_token() {
        let t = unique_name("sess");
        let a = session_for(&t);
        assert_eq!(session_for(&t), a, "同 token 同会话");
        let other = session_for(&unique_name("sess"));
        assert_ne!(other, a, "不同 token 不同会话");
        assert_eq!(mcp_session_of(&t), Some(a));
        assert_eq!(mcp_session_of("no-such-token"), None);
    }

    /// port_open/close 的参数与会话校验（真实开合依赖硬件端口，走集成/冒烟）。
    #[tokio::test]
    async fn port_open_close_argument_guards() {
        fn text_of(v: &Value) -> String {
            v["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .into()
        }
        let state = make_state();
        // 匿名 → 须会话标识
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"port_open","arguments":{"port":"COM99"}}}"#,
            &state,
        )
        .await;
        assert!(text_of(&resp).contains("会话标识"));
        // 缺 port → 报参数
        let resp = handle_request_with(
            Some("tok-open"),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"port_open","arguments":{}}}"#,
            &state,
        )
        .await;
        assert!(text_of(&resp).contains("缺少参数 port"));
        // 无会话记录的 close → 提示只能关自己开的
        let resp = handle_request_with(
            Some("tok-never-opened"),
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"port_close","arguments":{"port":"COM99"}}}"#,
            &state,
        )
        .await;
        assert!(text_of(&resp).contains("未曾打开"));
        // 有会话但端口未开 → 过参数关，落到 manager 的 NotOpen（区别于参数错误）
        session_for("tok-open");
        let resp = handle_request_with(
            Some("tok-open"),
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"port_close","arguments":{"port":"COM99"}}}"#,
            &state,
        )
        .await;
        assert!(text_of(&resp).contains("关闭失败"), "{}", text_of(&resp));
    }

    /// 远程 MCP 默认禁用脚本(enable_scripting=false),serial_script 应被拒;
    /// 旧名 serial_debug_script 为分发别名,同样被拒。
    #[tokio::test]
    async fn serial_script_disabled_by_default() {
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_script","arguments":{"code":"await sleep(1)"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_debug_script","arguments":{"code":"await sleep(1)"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true, "旧名别名同样受闸门");
    }

    /// serial_script 的 name 分支同受 enable_scripting 闸门:默认 false 拒执行。
    #[tokio::test]
    async fn serial_script_run_disabled_by_default() {
        ensure_test_config_dir();
        let name = unique_name("gate");
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await sleep(1)"}}}}}}"#,
            name
        );
        handle_request(&req, &make_state()).await;
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_eq!(
            resp["result"]["isError"], true,
            "enable_scripting=false 应拦库脚本执行"
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("未启用"), "应提示未启用: {}", text);
        // 旧名 serial_run_script 别名同一分支,同样被拦
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"serial_run_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_eq!(
            resp["result"]["isError"], true,
            "旧名别名同样受 enable_scripting 闸门"
        );
    }

    /// serial_script:name 不存在报错并提示 get(不传 name);code+name 并用/皆缺报互斥缺参。
    #[tokio::test]
    async fn serial_script_name_not_found_or_arg_conflicts() {
        ensure_test_config_dir();
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_script","arguments":{"name":"no-such-script-xyz"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("无脚本") && text.contains("serial_get_script"),
            "应报无脚本并提示 get: {}",
            text
        );
        // code 与 name 并用 → 互斥报错
        let req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_script","arguments":{"code":"await sleep(1)","name":"x"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("二选一"), "应报互斥: {}", text);
        // 皆缺(含 name 空串) → 缺参
        let req = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"serial_script","arguments":{"name":""}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// 脚本库合并粒度:save 的 delete=true 删除;无 code 无 delete 报缺参;code+delete 互斥;
    /// get 不传 name 列元数据;旧名别名(list_scripts/delete_script)仍分发。
    #[tokio::test]
    async fn script_library_merged_tools_and_aliases() {
        ensure_test_config_dir();
        let name = unique_name("merge");

        // save(code) → get(name) 有 code → save(delete=true) → get 报无脚本
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await sleep(1)"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert!(resp["result"]["isError"].is_null());
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"serial_get_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("await sleep(1)"),
            "get 应回 code 全文: {text}"
        );
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","delete":true}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert!(resp["result"]["isError"].is_null());
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("已删除"));
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"serial_get_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true, "删除后取应报无脚本");

        // 无 code 无 delete → 缺参;code+delete → 互斥(含 code 空串边界:Some("") 走保存分支而非删除)
        let req = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"serial_save_script","arguments":{"name":"whatever-xyz"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        for req in [
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"serial_save_script","arguments":{"name":"whatever-xyz","code":"await sleep(1)","delete":true}}}"#,
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"serial_save_script","arguments":{"name":"whatever-xyz","code":"","delete":true}}}"#,
        ] {
            let resp = handle_request(req, &make_state()).await;
            assert_eq!(resp["result"]["isError"], true, "code 与 delete 应互斥");
            assert!(resp["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("互斥"));
        }

        // get 不传 name → 列表(元数据数组);旧名 serial_list_scripts 别名同效。
        // 并行测试共享 scripts.json 且增删不定——全文比对不稳,存唯一 marker
        // 后断言两条路径的列表都含它(同库同格式)
        let marker = unique_name("alias");
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{marker}","code":"await sleep(1)"}}}}}}"#
        );
        handle_request(&req, &make_state()).await;
        async fn list_names(tool: &str) -> Vec<String> {
            let req = format!(
                r#"{{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{{"name":"{tool}","arguments":{{}}}}}}"#
            );
            let resp = handle_request(&req, &make_state()).await;
            let text = resp["result"]["content"][0]["text"].as_str().unwrap();
            serde_json::from_str::<Vec<Value>>(text)
                .unwrap_or_default()
                .iter()
                .filter_map(|e| e["name"].as_str().map(String::from))
                .collect()
        }
        let get_list = list_names("serial_get_script").await;
        assert!(get_list.contains(&marker), "get 列表应含 marker");
        let alias_list = list_names("serial_list_scripts").await;
        assert!(
            alias_list.contains(&marker),
            "旧名别名列表应含 marker: {alias_list:?}"
        );
    }

    /// merge_run_args:default 只填缺失 key;显式空串不覆盖;非 string 值视为已提供跳过。
    #[test]
    fn merge_run_args_semantics() {
        let params = vec![
            ss_core::ScriptParam {
                name: "a".into(),
                label: None,
                kind: "string".into(),
                default: Some("DA".into()),
                options: vec![],
            },
            ss_core::ScriptParam {
                name: "b".into(),
                label: None,
                kind: "string".into(),
                default: Some("DB".into()),
                options: vec![],
            },
            ss_core::ScriptParam {
                name: "c".into(),
                label: None,
                kind: "string".into(),
                default: None,
                options: vec![],
            },
        ];
        // 未传任何 args:有 default 的填上
        let m = merge_run_args(&params, None);
        assert_eq!(m.get("a").map(String::as_str), Some("DA"));
        assert_eq!(m.get("b").map(String::as_str), Some("DB"));
        assert!(!m.contains_key("c"));

        // 显式空串 a="":已提供,不用 default;显式 b="x" 优先
        let supplied = serde_json::json!({"a": "", "b": "x"});
        let m = merge_run_args(&params, Some(&supplied));
        assert_eq!(m.get("a").map(String::as_str), Some(""));
        assert_eq!(m.get("b").map(String::as_str), Some("x"));

        // key 存在但值非 string:a=42 → 跳过值且不填 default(不算缺 key)
        let supplied = serde_json::json!({"a": 42});
        let m = merge_run_args(&params, Some(&supplied));
        assert!(!m.contains_key("a"), "非 string 值应跳过且不填 default");
        assert_eq!(m.get("b").map(String::as_str), Some("DB"));

        // args 非对象(如数组):当空处理,default 正常填
        let m = merge_run_args(&params, Some(&serde_json::json!([])));
        assert_eq!(m.get("a").map(String::as_str), Some("DA"));
    }

    #[tokio::test]
    async fn serial_list_returns_text() {
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list","arguments":{}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert!(resp["result"]["content"][0]["text"].is_string());
    }

    #[tokio::test]
    async fn serial_status_no_port_opened() {
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_status","arguments":{}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// prompts/list 含 serial_script_guide,且 prompts/get 返回的指南含关键约束。
    #[tokio::test]
    async fn prompts_include_script_guide() {
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"prompts/list"}"#,
            &make_state(),
        )
        .await;
        let names: Vec<&str> = resp["result"]["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"serial_script_guide"),
            "prompts 应含 serial_script_guide: {:?}",
            names
        );
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"serial_script_guide"}}"#,
            &make_state(),
        )
        .await;
        let text = resp["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("expect"), "脚本指南应含 expect 说明");
        assert!(text.contains("正则字符串"), "脚本指南应含 pattern 约束");
    }

    #[test]
    fn hex_to_bytes_works() {
        assert_eq!(hex_to_bytes("48656C6C6F").unwrap(), b"Hello");
        assert_eq!(hex_to_bytes("48 65").unwrap(), b"He");
        assert!(hex_to_bytes("ABC").is_err());
    }

    // ===== 脚本库管理(save/list/delete)集成测 =====
    //
    // 这几个测试经 SERIAL_STUDIO_CONFIG_DIR 把 scripts.json 落到共享 tempdir,不污染 exe 目录。
    // 所有此类测试 set 同一路径(幂等),各自用唯一 name 避免内容互踩。生产环境不设此变量。

    fn ensure_test_config_dir() {
        let dir = std::env::temp_dir().join("ss-mcp-test-scripts");
        std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
        std::fs::create_dir_all(&dir).unwrap();
    }

    fn unique_name(prefix: &str) -> String {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        format!("{}-{}-{}", prefix, std::process::id(), n)
    }

    /// save 不受 enable_scripting 限制:默认 false 也能存(数据管理非执行)。
    #[tokio::test]
    async fn save_script_not_blocked_by_enable_scripting() {
        ensure_test_config_dir();
        let name = unique_name("save");
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await sleep(1)"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_ne!(
            resp["result"]["isError"], true,
            "enable_scripting=false 不应拦 save"
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("已保存"), "应提示已保存: {}", text);
    }

    /// 端到端:save(带 code marker)→ list(含 name,不含 code 全文)→ delete(已删除)→ delete(幂等)。
    #[tokio::test]
    async fn save_list_delete_roundtrip() {
        ensure_test_config_dir();
        let name = unique_name("roundtrip");
        let marker = format!("SECRET-CODE-{}", name);
        // save:code 里藏唯一 marker,后面验证 list 不泄露 code。
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await send('{}')","description":"e2e"}}}}}}"#,
            name, marker
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_ne!(resp["result"]["isError"], true);

        // list:含刚保存的 name,但不含 code 全文(marker)。
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list_scripts","arguments":{}}}"#,
            &make_state(),
        )
        .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(&name), "list 应含刚保存的 name");
        assert!(
            !text.contains(&marker),
            "list 不应泄露 code 全文(marker): {}",
            text
        );

        // delete:命中 → 已删除。
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_delete_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("已删除"), "删存在的应提示已删除: {}", text);

        // delete 幂等:再删 → 非 isError,提示无需删除。
        let resp = handle_request(&req, &make_state()).await;
        assert_ne!(resp["result"]["isError"], true, "删不存在应幂等成功");
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("无需删除"), "幂等应提示无需删除: {}", text);
    }

    /// save 覆盖语义:同名再存,提示"已覆盖"。
    #[tokio::test]
    async fn save_script_overwrites() {
        ensure_test_config_dir();
        let name = unique_name("overwrite");
        for code in ["v1", "v2"] {
            let req = format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await send('{}')"}}}}}}"#,
                name, code
            );
            let resp = handle_request(&req, &make_state()).await;
            assert_ne!(resp["result"]["isError"], true);
        }
        // 第二次应提示已覆盖(list 验证只剩一份)
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_get_script","arguments":{}}}"#,
            &make_state(),
        ).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_str(text).unwrap();
        let mine: Vec<_> = entries
            .iter()
            .filter(|e| e["name"].as_str() == Some(&name))
            .collect();
        assert_eq!(mine.len(), 1, "覆盖后应只剩一份: {:?}", mine);
    }

    /// get:按名取回完整定义(含 code 全文)——list 不泄露的 code 由 get 出回;
    /// 无此名报错提示 list;name 缺失/空串报缺参;不受 enable_scripting 限制(数据管理)。
    /// code 含引号/反斜杠/换行、params/group 一并回显(save→get 经 serde 往返不丢字段)。
    #[tokio::test]
    async fn get_script_returns_code_and_errors() {
        ensure_test_config_dir();
        let name = unique_name("get");
        let marker = format!("SECRET-CODE-{}", name);
        // code 只存不跑(本测试不执行),\q 这类非 JS 合法转义无所谓;JSON 转义层:
        // \n(换行)与 \\q(单反斜杠+q)、\"(引号)三类字符各覆盖一次。
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"log(\"{}\n\\q\")","description":"get-e2e","group":"g1","params":[{{"name":"p","type":"select","options":["a","b"],"default":"a"}}]}}}}}}"#,
            name, marker
        );
        handle_request(&req, &make_state()).await;

        // get(默认 enable_scripting=false)→ 非 error,code 全文含 marker(含转义字符往返)。
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_get_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_ne!(
            resp["result"]["isError"], true,
            "enable_scripting=false 不应拦 get"
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let v: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["name"].as_str(), Some(&*name));
        assert_eq!(v["description"].as_str(), Some("get-e2e"));
        assert_eq!(v["group"].as_str(), Some("g1"));
        assert_eq!(v["params"][0]["name"].as_str(), Some("p"));
        assert_eq!(v["params"][0]["default"].as_str(), Some("a"));
        let code = v["code"].as_str().unwrap();
        assert!(
            code.contains(&marker)
                && code.contains('\n')
                && code.contains('\\')
                && code.contains('"'),
            "get 应返回 code 原文(引号/反斜杠/换行经 serde 往返不失真): {:?}",
            code
        );

        // 无此名 → 提示不传 name 可列出全部
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_get_script","arguments":{"name":"no-such-script-xyz"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("无脚本") && text.contains("不传 name"),
            "应报无脚本并提示列表: {}",
            text
        );

        // name 空串 → 视同缺省,列出元数据(并入后的列表分支)
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_get_script","arguments":{"name":""}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_ne!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with('['), "空串 name 应列元数据: {text}");
    }

    /// save 缺必填参数(name/code)→ isError。
    #[tokio::test]
    async fn save_script_missing_params_errors() {
        // 缺 code 且无 delete → isError（并入后 code 可选但需 delete 标志才合法缺省）
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_save_script","arguments":{"name":"x"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        // 缺 name
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_save_script","arguments":{"code":"x"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// save/delete 命中触发 script_bus 广播;list/get 只读不触发;delete 幂等(None)不触发。
    #[tokio::test]
    async fn save_delete_broadcast_script_bus() {
        ensure_test_config_dir();
        let (tx, mut rx) = broadcast::channel::<()>(16);
        let name = unique_name("bcast");

        // save → 广播
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await sleep(1)"}}}}}}"#,
            name
        );
        handle_request(&req, &make_state_with_script_bus(tx.clone())).await;
        assert!(rx.try_recv().is_ok(), "save 应触发 script_bus");

        // list → 不广播(只读)
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list_scripts","arguments":{}}}"#;
        handle_request(req, &make_state_with_script_bus(tx.clone())).await;
        assert!(rx.try_recv().is_err(), "list 不应触发 script_bus");

        // get → 不广播(只读,同 list)
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_get_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        handle_request(&req, &make_state_with_script_bus(tx.clone())).await;
        assert!(rx.try_recv().is_err(), "get 不应触发 script_bus");

        // delete(命中)→ 广播
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_delete_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        handle_request(&req, &make_state_with_script_bus(tx.clone())).await;
        assert!(rx.try_recv().is_ok(), "delete 命中应触发 script_bus");

        // delete(幂等 None)→ 不广播
        handle_request(&req, &make_state_with_script_bus(tx.clone())).await;
        assert!(
            rx.try_recv().is_err(),
            "delete 幂等未变更不应触发 script_bus"
        );
    }
}

#[cfg(test)]
mod ssh_display_tests {
    use super::tests::make_state;
    use super::*;
    use crate::ssh::{SshAuthRecord, SshEndpointRecord, SshHostRecord, SshManager};
    use std::sync::Arc;

    fn ssh_with_entries() -> Arc<SshManager> {
        let m = SshManager::empty();
        m.update_registry(vec![
            SshHostRecord {
                allow_legacy_mac: false,
                id: "ssh-x1".into(),
                host: "192.0.2.70".into(),
                port: 22,
                username: "root".into(),
                nickname: Some("车间网关".into()),
                auth: SshAuthRecord::Password {
                    password: "pw".into(),
                },
                endpoints: vec![SshEndpointRecord {
                    name: "shell".into(),
                    r#type: "shell".into(),
                    alias: Some("控制台".into()),
                }],
            },
            SshHostRecord {
                allow_legacy_mac: false,
                id: "ssh-x2".into(),
                host: "192.0.2.71".into(),
                port: 22,
                username: "pi".into(),
                nickname: None,
                auth: SshAuthRecord::Agent,
                endpoints: vec![SshEndpointRecord {
                    name: "shell".into(),
                    r#type: "shell".into(),
                    alias: None,
                }],
            },
        ]);
        Arc::new(m)
    }

    /// serial_list 扁平单行:SSH 标记 + 设备昵称 + 寻址 + 端点别名 + 状态,无嵌套括号。
    #[tokio::test]
    async fn serial_list_flat_format_with_ssh() {
        // 不设 SERIAL_STUDIO_CONFIG_DIR:注册表操作全内存,且进程级 env 会与并行
        // 的脚本库测试互踩(lib 测试二进制同进程,known hazard)
        let mut state = make_state();
        let ssh = ssh_with_entries();
        state.ssh = Arc::clone(&ssh);
        // addresses 内持独立的 ssh 引用(make_state 注入的是空表),一并重建
        let (tx, _) = tokio::sync::broadcast::channel(16);
        state.addresses = Arc::new(crate::address::AddressResolver::new(
            Arc::new(crate::device::DeviceClientManager::empty(
                tx,
                "inst-mcp-ssh",
            )),
            ssh,
            tokio::sync::broadcast::channel(16).0,
            "inst-mcp-ssh".into(),
        ));
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list","arguments":{}}}"#;
        let resp = handle_request(req, &state).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let line1 = text
            .lines()
            .find(|l| l.starts_with("ssh-x1::shell"))
            .unwrap();
        assert!(line1.contains("端点别名 控制台"), "{line1}");
        assert!(
            line1.contains("SSH 设备 车间网关") && line1.contains("寻址 车间网关::shell"),
            "{line1}"
        );
        assert!(
            line1.ends_with("closed") && !line1.contains('('),
            "扁平无括号: {line1}"
        );
        let line2 = text
            .lines()
            .find(|l| l.starts_with("ssh-x2::shell"))
            .unwrap();
        assert!(
            line2.contains("SSH 设备 ssh-x2") && !line2.contains("寻址"),
            "无昵称 uuid 兜底: {line2}"
        );
    }

    /// nickname_of 双来源:SSH 注册表昵称可查(展示与解析同源)。
    #[tokio::test]
    async fn nickname_of_includes_ssh_source() {
        let (tx, _) = tokio::sync::broadcast::channel(4);
        let devices = Arc::new(crate::device::DeviceClientManager::empty(
            tx.clone(),
            "self",
        ));
        let r =
            crate::address::AddressResolver::new(devices, ssh_with_entries(), tx, "self".into());
        assert_eq!(r.nickname_of("ssh-x1").as_deref(), Some("车间网关"));
        assert_eq!(r.nickname_of("ssh-nope"), None);
    }
}

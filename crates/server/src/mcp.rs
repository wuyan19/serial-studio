//! MCP (Model Context Protocol) JSON-RPC 处理层。
//!
//! 移植自 terminal-serial，适配 serial-studio 的异步 SerialManager + 多串口：
//! - 工具加 `port` 参数（缺省时用唯一打开的串口）
//! - handle_request 与各 tool 函数均为 async（调 manager 的 async 方法）
//! - 暴露 12 工具：6 基础(list/send/read/status/grep/clear) + 2 脚本执行(debug_script/run_script) + 4 脚本库(save/get/list/delete)

use crate::address::AliasMatch;
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use tokio::sync::broadcast;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// axum POST /mcp 入口。
pub async fn mcp_handler(State(state): State<AppState>, body: String) -> Json<Value> {
    Json(handle_request(&body, &state).await)
}

pub async fn handle_request(body: &str, state: &AppState) -> Value {
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
        "initialize" => json!(handle_initialize()),
        "notifications/initialized" => return json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!(handle_tools_list()),
        "tools/call" => handle_tools_call(&params, state).await,
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

fn handle_initialize() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": false },
            "prompts": { "listChanged": false }
        },
        "serverInfo": { "name": "serial-studio", "version": env!("CARGO_PKG_VERSION") }
    })
}

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "serial_list",
                "description": "列出系统所有串口及其打开状态、别名与所属设备昵称。",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
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
                "name": "serial_status",
                "description": "获取已打开串口的配置：波特率、数据位、校验、停止位、流控、换行符、占用数与别名。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址:完整键/别名/昵称作用域(test::COM5),缺省=唯一打开的串口" }
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
                "name": "serial_debug_script",
                "description": "在串口上临时执行一段 JS 脚本（QuickJS）做调试验证，调通后可经 serial_save_script 落库、serial_run_script 按名复用。脚本内可用 send/expect/clear/sleep（均可带 [port] 跨串口，缺省为脚本运行端口）、同步 log（日志随本工具响应返回）及只读宿主机文件的 file_stat/file_md5/read_file/read_b64_chunk；签名与约束详见 serial_script_guide prompt，调用前先获取。受 enable_scripting 开关限制，默认关闭；运行上限 5 分钟，超时中止。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "code": { "type": "string", "description": "JS 源码（顶层可直接 await，如 await send(\"AT\")）" },
                        "args": { "type": "object", "description": "运行时参数（注入脚本 args.<name>），键值均 string", "additionalProperties": { "type": "string" } }
                    },
                    "required": ["code"]
                }
            },
            {
                "name": "serial_run_script",
                "description": "按 name 执行脚本库（scripts.json）中已保存的脚本。执行路径与约束同 serial_debug_script（enable_scripting 闸门、5 分钟运行上限）；脚本内 log 的调试日志随本工具响应返回。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "脚本库中的脚本名（serial_list_scripts 可查）" },
                        "port": { "type": "string", "description": "串口寻址：完整键/别名/昵称作用域（如 test::COM5），缺省时用唯一打开的串口" },
                        "args": { "type": "object", "description": "运行时参数（注入脚本 args.<name>），键值均 string，未传的键用脚本声明的 default 填充", "additionalProperties": { "type": "string" } }
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "serial_save_script",
                "description": "保存（或覆盖）一个 JS 脚本到脚本库（scripts.json），供日后经 serial_run_script 按名执行或在 UI 复用。name 是唯一存取键，已存在则覆盖。数据管理而非执行代码，不受 enable_scripting 限制。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "脚本唯一名（存取键，如 \"init-modem\"）" },
                        "code": { "type": "string", "description": "JS 源码（顶层可直接 await）" },
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
                    "required": ["name", "code"]
                }
            },
            {
                "name": "serial_get_script",
                "description": "按 name 读取脚本库（scripts.json）中一个脚本的完整定义（description/group/params/code 全文）；覆盖改写前先经此取原文。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "脚本库中的脚本名（serial_list_scripts 可查）" }
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "serial_list_scripts",
                "description": "列出脚本库（scripts.json）中所有脚本的元数据（name/description/group/params），不含 code 全文（要 code 用 serial_get_script）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "serial_delete_script",
                "description": "从脚本库删除一个脚本。无此名也不报错（幂等）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "要删除的脚本名" }
                    },
                    "required": ["name"]
                }
            }
        ]
    })
}

async fn handle_tools_call(params: &Value, state: &AppState) -> Value {
    let name = match params.get("name").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return error_text("Missing tool name".into()),
    };
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "serial_list" => tool_serial_list(arguments, state).await,
        "serial_send" => tool_serial_send(arguments, state).await,
        "serial_read" => tool_serial_read(arguments, state).await,
        "serial_status" => tool_serial_status(arguments, state).await,
        "serial_grep" => tool_serial_grep(arguments, state).await,
        "serial_clear" => tool_serial_clear(arguments, state).await,
        "serial_debug_script" => tool_serial_debug_script(arguments, state).await,
        "serial_run_script" => tool_serial_run_script(arguments, state).await,
        "serial_save_script" => tool_serial_save_script(arguments, &state.script_bus).await,
        "serial_get_script" => tool_serial_get_script(arguments).await,
        "serial_list_scripts" => tool_serial_list_scripts(arguments).await,
        "serial_delete_script" => tool_serial_delete_script(arguments, &state.script_bus).await,
        other => error_text(format!("Unknown tool: {}", other)),
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
        // 输入是裸名且未被解析改写 → 查索引区分"无此别名"与"歧义"
        let norm = ss_core::normalize_port_key(p);
        if norm == key && !norm.contains(ss_core::PORT_KEY_SEP) {
            if let AliasMatch::Ambiguous(cands) = state.addresses.lookup_port(&norm) {
                return Err(format!(
                    "端口别名「{}」匹配多个端口 {:?},请使用完整键或设备昵称作用域(如 设备昵称::端口)",
                    norm, cands
                ));
            }
        }
        return Ok(key);
    }
    let open = manager.list_open_ports().await;
    match open.len() {
        1 => Ok(open[0].clone()),
        0 => Err("未打开任何串口，请先在 UI 打开或通过 WS 的 open 命令".into()),
        _ => Err(format!("打开了多个串口 {:?}，必须指定 port 参数", open)),
    }
}

async fn tool_serial_list(_args: Value, state: &AppState) -> Value {
    // 合并视图(本地 + 远端设备桶 + 别名 + 本地占有权覆盖)——与 UI/REST/WS 同一数据源,
    // 远程设备的端口对 MCP 可见且带远端别名(下沉后 MCP 免费获得远程能力的落点)
    let views = crate::list_ports_with_meta(state).await;
    if views.is_empty() {
        return ok_text("未发现任何串口".into());
    }
    let mut out = Vec::with_capacity(views.len());
    for v in views {
        // 别名词汇 + 设备昵称都展示出来——agent 由此发现可用寻址形式
        // (裸名 / 端口别名 / `设备昵称::端口`),与 usage guide 的寻址表呼应
        let mut notes = Vec::new();
        if let Some(a) = &v.alias {
            notes.push(format!("别名 {}", a));
        }
        let dev_id = ss_core::split_port_key(&v.info.name).0;
        if dev_id != ss_core::LOCAL_DEVICE_ID {
            // 提示用裸后缀(目标机上的端口名),拼出的 test::<后缀> 才是可解析寻址
            let suffix = ss_core::split_port_key(&v.info.name).1;
            match state.addresses.nickname_of(dev_id) {
                Some(nick) => notes.push(format!("设备 {} (寻址 {}::{})", nick, nick, suffix)),
                None => notes.push(format!("设备 {}", dev_id)),
            }
        }
        let label = if notes.is_empty() {
            v.info.name.clone()
        } else {
            format!("{} ({})", v.info.name, notes.join(", "))
        };
        let line = if v.info.opened {
            if v.info.holders > 0 {
                format!("{} (open, {} holder(s))", label, v.info.holders)
            } else {
                format!("{} (open)", label)
            }
        } else {
            format!("{} (closed)", label)
        };
        out.push(line);
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
    match manager.send(&port, data_str, format, auto_newline).await {
        Ok(0) => error_text("No data to send".into()),
        Ok(n) => {
            let timeout_ms = args.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(0);
            if timeout_ms > 0 {
                // 带静默期读取：首字节等到 timeout_ms，之后连续无新数据即视为响应完整，
                // 避免 drain() 取首片即返回导致多分片响应被截断。
                // 静默期 250ms：交互式 CLI「立即回显→执行停顿→输出」两段式间隔常大于
                // 40ms；代价是每次调用尾延约 +210ms,换完整响应值得
                let resp = manager
                    .drain_buffer_quiet(&port, timeout_ms, 250)
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

    let data = match manager.drain_buffer(&port, timeout_ms).await {
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
    match manager.status(&port).await {
        Some(cfg) => {
            let holders = manager.holder_count(&port).await.unwrap_or(0);
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
            ok_text(format!(
                "Port: {}\n{alias_line}Baud rate: {}\nData bits: {:?}\nParity: {:?}\nStop bits: {:?}\nFlow control: {:?}\nLine ending: {:?}\nHolders: {}",
                port, cfg.baud_rate, cfg.data_bits, cfg.parity, cfg.stop_bits, cfg.flow_control, cfg.line_ending, holders
            ))
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
        let matches = match manager.grep_buffer_bytes(&port, pat, timeout_ms).await {
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
        match manager.grep_buffer(&port, pattern, timeout_ms).await {
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
    match manager.clear_buffer(&port).await {
        Ok(()) => ok_text("Buffer cleared".into()),
        Err(e) => error_text(e.to_string()),
    }
}

/// 临时执行调用方提供的 JS 代码(serial_debug_script):调通后可 save 落库。
async fn tool_serial_debug_script(args: Value, state: &AppState) -> Value {
    let code = match args.get("code").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return error_text("Missing required parameter: code".into()),
    };
    // 运行时参数 args(注入脚本 args.<name>);缺省空。值非 string 的条目跳过。
    let run_args = supplied_run_args(args.get("args"));
    let script = ss_core::Script {
        description: None,
        group: None,
        params: Vec::new(),
        code: code.to_string(),
    };
    execute_script(state, &args, script, run_args).await
}

/// 执行脚本库(scripts.json)中已保存的脚本(serial_run_script):按 name 取出后走与
/// serial_debug_script 相同的执行路径(闸门/预检/并发上限/日志返回)。读到即快照——
/// run 期间 save/delete 覆盖同名脚本不影响本次执行(scripts_store 的 LOCK 只保证读不与写交错)。
async fn tool_serial_run_script(args: Value, state: &AppState) -> Value {
    let name = match args.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return error_text("Missing required parameter: name".into()),
    };
    let script = match crate::scripts_store::load().get(&name) {
        Some(s) => s.clone(),
        None => {
            return error_text(format!(
                "无脚本「{}」,用 serial_list_scripts 查看可用脚本",
                name
            ))
        }
    };
    // name 查找先于 execute_script 内的闸门:属只读元数据访问(list 工具本可见),无害;
    // 执行能力仍统一由闸门拦截。
    let run_args = merge_run_args(&script.params, args.get("args"));
    execute_script(state, &args, script, run_args).await
}

/// 脚本执行统一路径(enable_scripting 闸门 → resolve_port → 端口预检 → 并发上限 →
/// run_script → 日志随响应返回)。serial_debug_script 与 serial_run_script 共用,
/// 执行 JS 的工具必经此路——闸门语义单一真相,新增执行类工具不会漏拦。
async fn execute_script(
    state: &AppState,
    args: &Value,
    script: ss_core::Script,
    run_args: std::collections::HashMap<String, String>,
) -> Value {
    let manager = &state.manager;
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
    if !manager.is_open(&port).await || manager.is_disconnected(&port).await {
        return error_text(format!("端口 {} 未打开或已断开", port));
    }
    // 并发上限(同 WS):防 DoS。permit 借用 semaphore,持到 run_script 完成(函数返回即释放)。
    let _permit = match state.script_semaphore.try_acquire() {
        Ok(p) => p,
        Err(_) => return error_text("脚本执行并发已满,稍后再试".into()),
    };
    let ss_core::ScriptRunOutcome { result, logs } =
        ss_core::run_script(&port, &script, manager.clone(), run_args).await;
    // 日志随结果返回(MCP 无实时推送出口):成功/失败/超时均拼上 log() 收集的输出,AI 才能调试脚本。
    // 空日志省略该段,避免噪音。
    match result {
        Ok(()) => ok_text(with_logs("脚本执行完成", &logs)),
        Err(e) => error_text(with_logs(
            &format!("脚本失败: {}", e.display_message()),
            &logs,
        )),
    }
}

/// 调用方显式提供的运行时参数(值非 string 的条目跳过,与 serial_debug_script 现状一致)。
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
// save/get/list/delete 操作 scripts.json 配置文件,不执行任何 JS——故不经 enable_scripting 闸门
// (该闸门语义是"是否允许远程执行 JS",防 RCE)。AI 调试好脚本后经此落盘供日后复用。
// 持久化的原子性/并发由 scripts_store 的进程内锁保证。

async fn tool_serial_save_script(args: Value, script_bus: &broadcast::Sender<()>) -> Value {
    let name = match args.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return error_text("Missing required parameter: name".into()),
    };
    let code = match args.get("code").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => return error_text("Missing required parameter: code".into()),
    };
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

/// 按名读取单个脚本的完整定义(含 code 全文)——list 只回元数据的膨胀防护,
/// code 的取回出口在这里;AI 改写库脚本(save 覆盖)前经此取原文。
async fn tool_serial_get_script(args: Value) -> Value {
    let name = match args.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return error_text("Missing required parameter: name".into()),
    };
    match crate::scripts_store::load().get(&name) {
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
        None => error_text(format!(
            "无脚本「{}」,用 serial_list_scripts 查看可用脚本",
            name
        )),
    }
}

async fn tool_serial_list_scripts(_args: Value) -> Value {
    let map = crate::scripts_store::load();
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
    ok_text(serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into()))
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
    if cleaned.len() % 2 != 0 {
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
                "description": "脚本编写指南：serial_debug_script / serial_run_script 的可用函数、约束（expect 返回空串、无 console、正则字符串等）与重试模式",
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

除 `serial_list` 与脚本库管理工具外，各工具接受可选 `port` 参数。不传时，若只打开了一个串口则自动选用；打开多个时必须显式指定。

## 寻址形式

- 裸端口名：本机串口（如 `COM5`、`/dev/ttyUSB0`）。
- 完整键：远端设备端口 `设备id::COM5`,多级级联逐段透传。
- 端口别名:UI 里设置的别名(如 `GPS`),本机优先,跨设备同名歧义时报候选。
- 设备昵称作用域:设备注册时设置的昵称(如 `test::COM5`)。末段叶别名在该设备
  作用域内唯一命中时本地即解析(`test::GPS` → 该设备的 GPS 别名端口);多级
  级联后缀逐段透传,由下一跳解析。昵称在设备列表唯一。

serial_list 输出会标注每个端口的别名与所属设备昵称。

## 推荐工作流

- 简单命令-响应：`serial_send(data="AT", timeout_ms=1000)`（一步拿响应；该读取破坏性清空缓冲）。
- 等待特定输出：`serial_send`（不设 timeout_ms）→ `serial_grep(pattern="OK", timeout_ms=3000)` → `serial_clear`。send 设了 timeout_ms 时响应已被其读走，勿再 grep/read 接力。
- 不要用 `serial_read` 轮询等待——每次读都会清空缓冲区，目标未到时数据会丢。

## 陷阱

- text 模式默认追加换行(按端口配置的 line_ending)，设 `auto_newline=false` 才发原始数据。
- `serial_grep` 等待期间新数据正常进缓冲区，不阻塞数据流。"#;

/// serial_debug_script / serial_run_script 的编写指南。与 skills/serial-studio-script/SKILL.md、
/// ss_server::SCRIPT_SKILL 三处同源(include_str! 同一文件)——改约束只改 SKILL.md。
const SERIAL_SCRIPT_GUIDE: &str = include_str!("../../../skills/serial-studio-script/SKILL.md");

#[cfg(test)]
mod tests {
    use super::*;
    use ss_core::{EventBus, RealPortOpener, SerialManager};
    use std::sync::Arc;

    /// 测试用 AppState(RealPortOpener + 空设备表;script_bus receiver 丢弃——
    /// 验证广播的测试自建 channel 保留 rx)。
    fn make_state() -> AppState {
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
                meta_tx,
                "inst-mcp-test".into(),
            )),
            devices,
            instance_id: "inst-mcp-test".into(),
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
            12,
            "8 个串口工具(含 debug_script/run_script) + 4 个脚本库工具(save/get/list/delete)"
        );
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"serial_debug_script"));
        assert!(names.contains(&"serial_run_script"));
        assert!(!names.contains(&"serial_run_saved_script"), "旧名应已移除");
        assert!(names.contains(&"serial_save_script"));
        assert!(names.contains(&"serial_get_script"));
        assert!(names.contains(&"serial_list_scripts"));
        assert!(names.contains(&"serial_delete_script"));
    }

    /// 远程 MCP 默认禁用脚本(enable_scripting=false),serial_debug_script 应被拒。
    #[tokio::test]
    async fn serial_debug_script_disabled_by_default() {
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_debug_script","arguments":{"code":"await sleep(1)"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// serial_run_script 同受 enable_scripting 闸门:默认 false 拒执行。
    #[tokio::test]
    async fn serial_run_script_disabled_by_default() {
        ensure_test_config_dir();
        let name = unique_name("gate");
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_save_script","arguments":{{"name":"{}","code":"await sleep(1)"}}}}}}"#,
            name
        );
        handle_request(&req, &make_state()).await;
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"serial_run_script","arguments":{{"name":"{}"}}}}}}"#,
            name
        );
        let resp = handle_request(&req, &make_state()).await;
        assert_eq!(
            resp["result"]["isError"], true,
            "enable_scripting=false 应拦库脚本执行"
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("未启用"), "应提示未启用: {}", text);
    }

    /// serial_run_script:name 不存在报错并提示 list;name 缺失/空串报缺参。
    #[tokio::test]
    async fn serial_run_script_name_not_found_or_missing() {
        ensure_test_config_dir();
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_run_script","arguments":{"name":"no-such-script-xyz"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("无脚本") && text.contains("serial_list_scripts"),
            "应报无脚本并提示 list: {}",
            text
        );
        // name 空串 → 缺参(对齐 save/delete/get 的非空检查)
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_run_script","arguments":{"name":""}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
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
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list_scripts","arguments":{}}}"#,
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

        // 无此名 → 提示 list
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_get_script","arguments":{"name":"no-such-script-xyz"}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("无脚本") && text.contains("serial_list_scripts"),
            "应报无脚本并提示 list: {}",
            text
        );

        // name 空串 → 缺参
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_get_script","arguments":{"name":""}}}"#;
        let resp = handle_request(req, &make_state()).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// save 缺必填参数(name/code)→ isError。
    #[tokio::test]
    async fn save_script_missing_params_errors() {
        // 缺 code
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
        handle_request(&req, &make_state_with_script_bus(tx.clone())).await;
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

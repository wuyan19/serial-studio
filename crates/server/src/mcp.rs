//! MCP (Model Context Protocol) JSON-RPC 处理层。
//!
//! 移植自 terminal-serial，适配 serial-studio 的异步 SerialManager + 多串口：
//! - 工具加 `port` 参数（缺省时用唯一打开的串口）
//! - handle_request 与各 tool 函数均为 async（调 manager 的 async 方法）
//! - 暴露 6 工具：serial_list / serial_send / serial_read / serial_status / serial_grep / serial_clear

use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use ss_core::SerialManager;
use std::sync::Arc;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// axum POST /mcp 入口。
pub async fn mcp_handler(State(state): State<AppState>, body: String) -> Json<Value> {
    Json(
        handle_request(
            &body,
            &state.manager,
            state.enable_scripting.load(std::sync::atomic::Ordering::Relaxed),
            &state.script_semaphore,
        )
        .await,
    )
}

pub async fn handle_request(
    body: &str,
    manager: &Arc<SerialManager>,
    enable_scripting: bool,
    semaphore: &tokio::sync::Semaphore,
) -> Value {
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
        "tools/call" => handle_tools_call(&params, manager, enable_scripting, semaphore).await,
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
                "description": "列出系统所有串口及其打开状态与别名。无需指定端口，用于发现可用串口或确认某端口是否已打开。",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "serial_send",
                "description": "发送数据到串口并可选等待设备响应。text 模式 auto_newline 默认 true，自动追加换行。设置 timeout_ms > 0 时会等待并返回响应。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名或别名（如 COM7 / /dev/ttyUSB0 / GPS）。缺省时使用唯一打开的串口" },
                        "data": { "type": "string", "description": "要发送的数据" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text", "description": "data 的编码：text 为文本，hex 为十六进制" },
                        "auto_newline": { "type": "boolean", "default": true, "description": "text 模式是否追加换行" },
                        "timeout_ms": { "type": "integer", "default": 0, "description": "发送后等待响应的超时（毫秒），0 不等待" }
                    },
                    "required": ["data"]
                }
            },
            {
                "name": "serial_read",
                "description": "读取串口接收缓冲区数据（破坏性，读后清空）。空时按 timeout 等待。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名或别名" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text", "description": "输出编码：text 为文本，hex 为十六进制" },
                        "timeout_ms": { "type": "integer", "default": 100, "description": "缓冲区空时等待超时（毫秒）" }
                    }
                }
            },
            {
                "name": "serial_status",
                "description": "获取指定串口的配置信息。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名或别名" }
                    }
                }
            },
            {
                "name": "serial_grep",
                "description": "在接收缓冲区中搜索匹配模式（非破坏）。text 模式支持正则，hex 模式按字节序列。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名或别名" },
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
                        "port": { "type": "string", "description": "串口名或别名" }
                    }
                }
            },
            {
                "name": "serial_run_script",
                "description": "在串口上执行一段 JS 脚本(QuickJS)。脚本内可用全局 async 函数 send(data,[port])/expect(pattern,ms,[port])/clear([port])/sleep(ms);[port] 缺省=脚本运行端口,可指定其它已打开端口以跨多串口。受 enable_scripting 开关限制,默认关闭。调用前先获取 serial_script_guide prompt 了解可用函数与约束。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名或别名。缺省时使用唯一打开的串口" },
                        "code": { "type": "string", "description": "JS 源码(顶层可直接 await,如 await send(\"AT\"))" },
                        "args": { "type": "object", "description": "运行时参数(注入脚本 args.<name>),键值均 string。可选", "additionalProperties": { "type": "string" } }
                    },
                    "required": ["code"]
                }
            }
        ]
    })
}

async fn handle_tools_call(
    params: &Value,
    manager: &Arc<SerialManager>,
    enable_scripting: bool,
    semaphore: &tokio::sync::Semaphore,
) -> Value {
    let name = match params.get("name").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return error_text("Missing tool name".into()),
    };
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "serial_list" => tool_serial_list(arguments, &**manager).await,
        "serial_send" => tool_serial_send(arguments, &**manager).await,
        "serial_read" => tool_serial_read(arguments, &**manager).await,
        "serial_status" => tool_serial_status(arguments, &**manager).await,
        "serial_grep" => tool_serial_grep(arguments, &**manager).await,
        "serial_clear" => tool_serial_clear(arguments, &**manager).await,
        "serial_run_script" => tool_serial_run_script(arguments, manager, enable_scripting, semaphore).await,
        other => error_text(format!("Unknown tool: {}", other)),
    }
}

async fn resolve_port(args: &Value, manager: &SerialManager) -> Result<String, String> {
    if let Some(p) = args.get("port").and_then(|v| v.as_str()) {
        // 精确端口名优先：是已开端口就直接用
        let open = manager.list_open_ports().await;
        if open.iter().any(|x| x == p) {
            return Ok(p.to_string());
        }
        // 否则按别名反查 ports.json
        let meta = crate::port_meta_store::load();
        if let Some((port, _)) = meta.iter().find(|(_, m)| m.alias.as_deref() == Some(p)) {
            return Ok(port.clone());
        }
        // 既非已开端口名也非别名：透传，下游 NotOpen 兜底（保留原行为）
        return Ok(p.to_string());
    }
    let open = manager.list_open_ports().await;
    match open.len() {
        1 => Ok(open[0].clone()),
        0 => Err("未打开任何串口，请先在 UI 打开或通过 WS 的 open 命令".into()),
        _ => Err(format!("打开了多个串口 {:?}，必须指定 port 参数", open)),
    }
}

async fn tool_serial_list(_args: Value, manager: &SerialManager) -> Value {
    let ports = manager.list_ports().await;
    if ports.is_empty() {
        return ok_text("未发现任何串口".into());
    }
    let meta = crate::port_meta_store::load();
    let mut out = Vec::with_capacity(ports.len());
    for p in ports {
        let alias = meta.get(&p.name).and_then(|m| m.alias.as_deref());
        let label = match alias {
            Some(a) => format!("{} ({})", p.name, a),
            None => p.name.clone(),
        };
        let line = if p.opened {
            match manager.holder_count(&p.name).await {
                Some(n) if n > 0 => format!("{} (open, {} holder(s))", label, n),
                _ => format!("{} (open)", label),
            }
        } else {
            format!("{} (closed)", label)
        };
        out.push(line);
    }
    ok_text(out.join("\n"))
}

async fn tool_serial_send(args: Value, manager: &SerialManager) -> Value {
    let port = match resolve_port(&args, manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let data_str = match args.get("data").and_then(|d| d.as_str()) {
        Some(d) => d,
        None => return error_text("Missing required parameter: data".into()),
    };
    let format = args.get("format").and_then(|f| f.as_str()).unwrap_or("text");
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
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let resp = manager
                    .drain_buffer(&port, timeout_ms)
                    .await
                    .unwrap_or_default();
                ok_text(format!("Sent {} bytes. Response: {}", n, String::from_utf8_lossy(&resp)))
            } else {
                ok_text(format!("Sent {} bytes", n))
            }
        }
        Err(e) => error_text(format!("Send failed: {}", e)),
    }
}

async fn tool_serial_read(args: Value, manager: &SerialManager) -> Value {
    let port = match resolve_port(&args, manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let timeout_ms = args.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(100);
    let format = args.get("format").and_then(|f| f.as_str()).unwrap_or("text");

    let data = match manager.drain_buffer(&port, timeout_ms).await {
        Ok(d) => d,
        Err(e) => return error_text(e.to_string()),
    };
    let output = match format {
        "hex" => data.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(""),
        _ => String::from_utf8_lossy(&data).to_string(),
    };
    ok_text(output)
}

async fn tool_serial_status(args: Value, manager: &SerialManager) -> Value {
    let port = match resolve_port(&args, manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    match manager.status(&port).await {
        Some(cfg) => {
            let holders = manager.holder_count(&port).await.unwrap_or(0);
            let alias = crate::port_meta_store::load()
                .get(&port)
                .and_then(|m| m.alias.clone());
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

async fn tool_serial_grep(args: Value, manager: &SerialManager) -> Value {
    let port = match resolve_port(&args, manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return error_text("Missing required parameter: pattern".into()),
    };
    let timeout_ms = args.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(1000);
    let format = args.get("format").and_then(|f| f.as_str()).unwrap_or("text");

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
                let hex: String = ctx.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
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

async fn tool_serial_clear(args: Value, manager: &SerialManager) -> Value {
    let port = match resolve_port(&args, manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    match manager.clear_buffer(&port).await {
        Ok(()) => ok_text("Buffer cleared".into()),
        Err(e) => error_text(e.to_string()),
    }
}

async fn tool_serial_run_script(
    args: Value,
    manager: &Arc<SerialManager>,
    enable_scripting: bool,
    semaphore: &tokio::sync::Semaphore,
) -> Value {
    // 远程 MCP 路径强制闸门:服务器无认证,脚本执行须显式开启
    if !enable_scripting {
        return error_text("脚本执行未启用(settings.json 的 enable_scripting=false)".into());
    }
    let port = match resolve_port(&args, &**manager).await {
        Ok(p) => p,
        Err(e) => return error_text(e),
    };
    // 端口预检:未打开则脚本内 send 静默失败却显示"完成",误导。
    if !manager.is_open(&port).await {
        return error_text(format!("端口 {} 未打开", port));
    }
    // 并发上限(同 WS):防 DoS。permit 借用 semaphore,持到 run_script 完成(函数返回即释放)。
    let _permit = match semaphore.try_acquire() {
        Ok(p) => p,
        Err(_) => return error_text("脚本执行并发已满,稍后再试".into()),
    };
    let code = match args.get("code").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return error_text("Missing required parameter: code".into()),
    };
    // 运行时参数 args(注入脚本 args.<name>);缺省空。值非 string 的条目跳过。
    let run_args: std::collections::HashMap<String, String> = args
        .get("args")
        .and_then(|a| a.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let script = ss_core::Script {
        description: None,
        group: None,
        params: Vec::new(),
        code: code.to_string(),
    };
    match ss_core::run_script(&port, &script, manager.clone(), run_args).await {
        Ok(()) => ok_text("脚本执行完成".into()),
        Err(e) => error_text(format!("脚本失败: {}", e.display_message())),
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
                "description": "脚本编写指南：serial_run_script 的可用函数、约束（expect 返回空串、无 console、正则字符串等）与重试模式",
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

所有工具接受可选 `port` 参数。不传时，若只打开了一个串口则自动选用；打开多个时必须显式指定。

## 推荐工作流

- 简单命令-响应：`serial_send(data="AT", timeout_ms=1000)`（一步拿响应）。
- 等待特定输出：`serial_send` → `serial_grep(pattern="OK", timeout_ms=3000)` → `serial_clear`。
- 不要用 `serial_read` 轮询等待——每次读都会清空缓冲区，目标未到时数据会丢。

## 陷阱

- text 模式默认追加 `\r\n`，设 `auto_newline=false` 才发原始数据。
- `serial_grep` 等待期间新数据正常进缓冲区，不阻塞数据流。"#;

/// serial_run_script 的编写指南。跨 MCP 客户端分发(Claude Desktop/Code 等),
/// 与仓库 skills/serial-studio-script/SKILL.md 同源——前者服务任意 MCP 客户端,
/// 后者服务装了技能的 Claude Code。改约束时两处同步。
const SERIAL_SCRIPT_GUIDE: &str = r#"# Serial Studio 脚本编写指南

serial_run_script 执行一段 JS(QuickJS,顶层可直接 await),跑在指定串口上。能做 if/for/重试等控制流。send/expect/clear 的可选 port 参数可指定其它已打开端口,从而在一个脚本里跨多串口操作。

## 可用全局 async 函数(只有这 4 个 + 标准 JS;无 fetch/require/fs,沙箱)
- await send(data, [port])          发文本,自动追加换行。总成功,无返回。
- await expect(pattern, ms, [port]) 在接收缓冲用正则 pattern 匹配整行,返回首条匹配行。
                                    超时无匹配返回空串 ""(不报错)——必须判断返回值。
- await clear([port])               清空接收缓冲。
- await sleep(ms)                   睡眠(与端口无关)。
[port] 可选,缺省=脚本运行端口;传端口名则操作该端口(须已打开)。

## 必须遵守的约束
1. 判断 expect 返回值:expect 超时返回 "" 不报错。不判断会把"没收到"当"收到"。用 if (line === "") 识别。
2. 无控制台输出:无 console.log。要打印/调试/回报结果,只能 throw new Error("...")——消息会显示给用户(脚本以失败结束)。
3. expect 的 pattern 是正则字符串:写 expect("OK", 1000),不要 expect(/OK/, 1000)(字面量转 "/OK/" 会让正则编译失败)。
4. 30 秒超时:脚本总执行上限 30s,死循环会被强杀。expect 的 ms 通常 500~3000。
5. 用户 throw 正常传播:expect 没等到 → throw new Error("原因") 是中止报错的正道。

## 多端口:一个脚本操作多个串口
send/expect/clear 的可选 port 参数指定目标端口(须已打开),缺省=脚本运行端口。各端口接收缓冲相互隔离——对 COM3 的 expect 只读 COM3 的回显。
未打开的端口:send 静默失败、expect 返回空串(须判空)。脚本无 open 原语,需先手动打开涉及的端口。
例:COM3 查 MAC → COM5 配该 MAC:
  await clear("COM3");
  await send("AT+MAC?", "COM3");
  const line = await expect("MAC:\\s*([0-9A-Fa-f:]+)", 2000, "COM3");
  if (!line) throw new Error("COM3 未返回 MAC");
  const m = line.match(/[\dA-Fa-f]{2}([:\-][\dA-Fa-f]{2}){5}/);
  const mac = m ? m[0] : "";
  if (!mac) throw new Error("无法解析 MAC: " + line);
  await clear("COM5");
  await send("AT+SETMAC=" + mac, "COM5");
  if (await expect("OK", 1000, "COM5") === "") throw new Error("COM5 配置失败");

## 运行时参数(args)
serial_run_script 的 args 入参(object,键值均 string)注入为脚本全局对象 args,字段名自定。把易变值从 code 抽出,换参重跑不改脚本。
  const mac = args.mac;                       // 调用方在 args 里传
  await send("AT+SETMAC=" + mac, args.target);
桌面/Web 端则在脚本编辑器「参数」区声明(string/select),或在 code 顶部用 // @param <name> <type> ... 注释声明(粘贴即用),运行时弹窗收集注入 args.<name>。

## 模式:失败重试(脚本的核心价值)
await clear();
let ok = "";
for (let i = 1; i <= 3; i++) {
  await send("AT");
  ok = await expect("OK", 1000);
  if (ok) break;
  await sleep(300);
}
if (!ok) throw new Error("重试 3 次无响应");

## 调试
看变量:throw new Error("debug: " + JSON.stringify(x))。
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use ss_core::{EventBus, RealPortOpener, SerialManager};
    use std::sync::Arc;

    fn make_manager() -> Arc<SerialManager> {
        Arc::new(SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(RealPortOpener)))
    }

    #[tokio::test]
    async fn parse_error() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let resp = handle_request("not json", &m, false, &sem).await;
        assert_eq!(resp["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn initialize() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, &m, false, &sem).await;
        assert_eq!(resp["result"]["serverInfo"]["name"], "serial-studio");
    }

    #[tokio::test]
    async fn tools_list_has_seven() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, &m, false, &sem).await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 7);
    }

    /// 远程 MCP 默认禁用脚本(enable_scripting=false),serial_run_script 应被拒。
    #[tokio::test]
    async fn serial_run_script_disabled_by_default() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_run_script","arguments":{"code":"await sleep(1)"}}}"#;
        let resp = handle_request(req, &m, false, &sem).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    #[tokio::test]
    async fn serial_list_returns_text() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_list","arguments":{}}}"#;
        let resp = handle_request(req, &m, false, &sem).await;
        assert!(resp["result"]["content"][0]["text"].is_string());
    }

    #[tokio::test]
    async fn serial_status_no_port_opened() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_status","arguments":{}}}"#;
        let resp = handle_request(req, &m, false, &sem).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    /// prompts/list 含 serial_script_guide,且 prompts/get 返回的指南含关键约束。
    #[tokio::test]
    async fn prompts_include_script_guide() {
        let m = make_manager();
    let sem = tokio::sync::Semaphore::new(4);
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"prompts/list"}"#, &m, false, &sem).await;
        let names: Vec<&str> = resp["result"]["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"serial_script_guide"),
            "prompts 应含 serial_script_guide: {:?}", names
        );
        let resp = handle_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"serial_script_guide"}}"#,
            &m,
            false,
            &sem,
        )
        .await;
        let text = resp["result"]["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("expect"), "脚本指南应含 expect 说明");
        assert!(text.contains("正则字符串"), "脚本指南应含 pattern 约束");
    }

    #[test]
    fn hex_to_bytes_works() {
        assert_eq!(hex_to_bytes("48656C6C6F").unwrap(), b"Hello");
        assert_eq!(hex_to_bytes("48 65").unwrap(), b"He");
        assert!(hex_to_bytes("ABC").is_err());
    }
}

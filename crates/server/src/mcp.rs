//! MCP (Model Context Protocol) JSON-RPC 处理层。
//!
//! 移植自 terminal-serial，适配 serial-studio 的异步 SerialManager + 多串口：
//! - 工具加 `port` 参数（缺省时用唯一打开的串口）
//! - handle_request 与各 tool 函数均为 async（调 manager 的 async 方法）
//! - 暴露 5 工具：serial_send / serial_read / serial_status / serial_grep / serial_clear

use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use ss_core::SerialManager;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// axum POST /mcp 入口。
pub async fn mcp_handler(State(state): State<AppState>, body: String) -> Json<Value> {
    Json(handle_request(&body, &state.manager).await)
}

pub async fn handle_request(body: &str, manager: &SerialManager) -> Value {
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
        "tools/call" => handle_tools_call(&params, manager).await,
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
                "name": "serial_send",
                "description": "发送数据到串口并可选等待设备响应。text 模式 auto_newline 默认 true，按端口 line_ending 追加换行（open 时配 LF/CR/CRLF）。设置 timeout_ms > 0 时会等待并返回响应。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名（如 COM3）。缺省时使用唯一打开的串口" },
                        "data": { "type": "string", "description": "要发送的数据" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text" },
                        "auto_newline": { "type": "boolean", "default": true, "description": "text 模式是否追加换行（换行符由端口 line_ending 决定）" },
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
                        "port": { "type": "string", "description": "串口名" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text" },
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
                        "port": { "type": "string", "description": "串口名" }
                    }
                }
            },
            {
                "name": "serial_grep",
                "description": "在接收缓冲区中搜索匹配模式（非破坏）。text 模式支持正则，hex 模式按字节序列。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": { "type": "string", "description": "串口名" },
                        "pattern": { "type": "string", "description": "搜索模式" },
                        "format": { "type": "string", "enum": ["text", "hex"], "default": "text" },
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
                        "port": { "type": "string", "description": "串口名" }
                    }
                }
            }
        ]
    })
}

async fn handle_tools_call(params: &Value, manager: &SerialManager) -> Value {
    let name = match params.get("name").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return error_text("Missing tool name".into()),
    };
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "serial_send" => tool_serial_send(arguments, manager).await,
        "serial_read" => tool_serial_read(arguments, manager).await,
        "serial_status" => tool_serial_status(arguments, manager).await,
        "serial_grep" => tool_serial_grep(arguments, manager).await,
        "serial_clear" => tool_serial_clear(arguments, manager).await,
        other => error_text(format!("Unknown tool: {}", other)),
    }
}

async fn resolve_port(args: &Value, manager: &SerialManager) -> Result<String, String> {
    if let Some(p) = args.get("port").and_then(|v| v.as_str()) {
        return Ok(p.to_string());
    }
    let open = manager.list_open_ports().await;
    match open.len() {
        1 => Ok(open[0].clone()),
        0 => Err("未打开任何串口，请先在 UI 打开或通过 WS 的 open 命令".into()),
        _ => Err(format!("打开了多个串口 {:?}，必须指定 port 参数", open)),
    }
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
        Some(cfg) => ok_text(format!(
            "Port: {}\nBaud rate: {}\nData bits: {:?}\nParity: {:?}\nStop bits: {:?}\nFlow control: {:?}\nLine ending: {:?}",
            port, cfg.baud_rate, cfg.data_bits, cfg.parity, cfg.stop_bits, cfg.flow_control, cfg.line_ending
        )),
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

#[cfg(test)]
mod tests {
    use super::*;
    use ss_core::{EventBus, SerialManager};
    use std::sync::Arc;

    fn make_manager() -> SerialManager {
        SerialManager::new(Arc::new(EventBus::new(16)))
    }

    #[tokio::test]
    async fn parse_error() {
        let m = make_manager();
        let resp = handle_request("not json", &m).await;
        assert_eq!(resp["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn initialize() {
        let m = make_manager();
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, &m).await;
        assert_eq!(resp["result"]["serverInfo"]["name"], "serial-studio");
    }

    #[tokio::test]
    async fn tools_list_has_five() {
        let m = make_manager();
        let resp = handle_request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, &m).await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
    }

    #[tokio::test]
    async fn serial_status_no_port_opened() {
        let m = make_manager();
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_status","arguments":{}}}"#;
        let resp = handle_request(req, &m).await;
        assert_eq!(resp["result"]["isError"], true);
    }

    #[test]
    fn hex_to_bytes_works() {
        assert_eq!(hex_to_bytes("48656C6C6F").unwrap(), b"Hello");
        assert_eq!(hex_to_bytes("48 65").unwrap(), b"He");
        assert!(hex_to_bytes("ABC").is_err());
    }
}

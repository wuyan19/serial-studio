//! WebSocket 协议适配层。
//!
//! 协议（JSON）：
//!   client → server:
//!     {"action":"list"}
//!     {"action":"open","port":"COM3","config":{"baud_rate":115200,...}}
//!     {"action":"close","port":"COM3"}
//!     {"action":"write","port":"COM3","data":"...","encoding":"hex|text"}
//!   server → client:
//!     {"type":"ports","ports":[...]}
//!     {"type":"data","port":"COM3","data":"...","encoding":"hex"}
//!     {"type":"opened","port":"COM3"}
//!     {"type":"closed","port":"COM3"}
//!     {"type":"ok","message":"..."}
//!     {"type":"error","message":"..."}
//!
//! 数据流：client 命令 → SerialManager；EventBus 事件 → 推给 client。

use crate::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use ss_core::{SerialConfig, SerialEvent};
use tokio::sync::mpsc;

/// 服务器 → 客户端 消息（全 owned，避免生命周期纠缠）。
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Ports { ports: Vec<ss_core::PortInfo> },
    Data { port: String, data: String, encoding: String },
    Opened { port: String },
    Closed { port: String },
    Error { message: String },
    Ok { message: String },
    Macros { macros: Vec<MacroInfo> },
    MacroResult { name: String, success: bool, message: String },
}

/// 宏摘要（list_macros 返回）。
#[derive(Serialize)]
struct MacroInfo {
    name: String,
    description: Option<String>,
}

/// 客户端 → 服务器 消息。
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ClientMsg {
    List,
    Open {
        port: String,
        #[serde(default)]
        config: SerialConfig,
    },
    Close { port: String },
    Write {
        port: String,
        data: String,
        #[serde(default = "default_encoding")]
        encoding: String,
    },
    ListMacros,
    RunMacro { name: String, port: String },
}

fn default_encoding() -> String {
    "text".into()
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    tracing::info!("WS 客户端已连接");
    let (mut ws_tx, mut ws_rx) = socket.split();

    // 输出 channel：所有要发给 client 的消息汇到这里统一发送（避免 select 中 &mut 冲突）
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    // 订阅 EventBus
    let mut event_rx = state.event_bus.subscribe();

    // 推送初始端口列表
    {
        let ports = state.manager.list_ports().await;
        let _ = out_tx.send(to_json(ServerMsg::Ports { ports })).await;
    }

    // event → out channel（独立任务）
    let out_tx_evt = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    if let Some(msg) = event_to_msg(&event) {
                        if out_tx_evt.send(msg).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // 主循环：client 命令 + 输出发送
    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_client_msg(&text, &state, &out_tx).await;
                    }
                    Some(Ok(Message::Binary(_))) => {
                        let _ = out_tx
                            .send(to_json(ServerMsg::Error { message: "仅支持文本消息".into() }))
                            .await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            Some(out) = out_rx.recv() => {
                if ws_tx.send(Message::Text(out)).await.is_err() {
                    break;
                }
            }
        }
    }

    event_task.abort();
    tracing::info!("WS 客户端断开");
}

fn to_json(msg: ServerMsg) -> String {
    serde_json::to_string(&msg).unwrap()
}

fn event_to_msg(event: &SerialEvent) -> Option<String> {
    let msg = match event {
        SerialEvent::DataReceived { port, data } => ServerMsg::Data {
            port: port.clone(),
            data: hex::encode(data),
            encoding: "hex".into(),
        },
        SerialEvent::PortOpened { port } => ServerMsg::Opened { port: port.clone() },
        SerialEvent::PortClosed { port } => ServerMsg::Closed { port: port.clone() },
        SerialEvent::Error { port, message } => ServerMsg::Error {
            message: format!("{}: {}", port, message),
        },
    };
    Some(to_json(msg))
}

async fn handle_client_msg(text: &str, state: &AppState, out_tx: &mpsc::Sender<String>) {
    let msg: ClientMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            let _ = out_tx
                .send(to_json(ServerMsg::Error {
                    message: format!("指令解析失败: {}", e),
                }))
                .await;
            return;
        }
    };

    match msg {
        ClientMsg::List => {
            let ports = state.manager.list_ports().await;
            let _ = out_tx.send(to_json(ServerMsg::Ports { ports })).await;
        }
        ClientMsg::Open { port, config } => match state.manager.open(port.clone(), config).await {
            Ok(()) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok { message: "opened".into() }))
                    .await;
                // PortOpened 事件会由 port_task 经 EventBus 广播，前端也会收到
            }
            Err(e) => {
                let _ = out_tx.send(to_json(ServerMsg::Error { message: e.to_string() })).await;
            }
        },
        ClientMsg::Close { port } => match state.manager.close(port).await {
            Ok(()) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok { message: "closed".into() }))
                    .await;
            }
            Err(e) => {
                let _ = out_tx.send(to_json(ServerMsg::Error { message: e.to_string() })).await;
            }
        },
        ClientMsg::Write { port, data, encoding } => {
            let bytes = match encoding.as_str() {
                "hex" => match hex::decode(data.trim()) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = out_tx
                            .send(to_json(ServerMsg::Error {
                                message: format!("hex 解码失败: {}", e),
                            }))
                            .await;
                        return;
                    }
                },
                "text" => data.into_bytes(),
                other => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Error {
                            message: format!("不支持的编码: {}", other),
                        }))
                        .await;
                    return;
                }
            };
            match state.manager.write(port, bytes::Bytes::from(bytes)).await {
                Ok(n) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: format!("written {} bytes", n),
                        }))
                        .await;
                }
                Err(e) => {
                    let _ = out_tx.send(to_json(ServerMsg::Error { message: e.to_string() })).await;
                }
            }
        }
        ClientMsg::ListMacros => {
            let macros: Vec<MacroInfo> = state
                .macros
                .iter()
                .map(|(n, m)| MacroInfo {
                    name: n.clone(),
                    description: m.description.clone(),
                })
                .collect();
            let _ = out_tx.send(to_json(ServerMsg::Macros { macros })).await;
        }
        ClientMsg::RunMacro { name, port } => {
            let mac = match state.macros.get(&name) {
                Some(m) => m.clone(),
                None => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Error { message: format!("宏 {} 不存在", name) }))
                        .await;
                    return;
                }
            };
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok { message: format!("运行宏 {}", name) }))
                .await;
            tokio::spawn(async move {
                let result = ss_core::run_macro(&port, &mac, &manager).await;
                let msg = match result {
                    Ok(()) => ServerMsg::MacroResult {
                        name,
                        success: true,
                        message: "完成".into(),
                    },
                    Err(e) => ServerMsg::MacroResult {
                        name,
                        success: false,
                        message: e.to_string(),
                    },
                };
                let _ = out_tx2.send(to_json(msg)).await;
            });
        }
    }
}

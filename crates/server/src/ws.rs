//! WebSocket 协议适配层。
//!
//! 协议（JSON）：
//!   client → server:
//!     {"action":"list"}
//!     {"action":"open","port":"COM3","config":{"baud_rate":115200,...}}
//!     {"action":"close","port":"COM3"}
//!     {"action":"write","port":"COM3","data":"...","encoding":"hex|text"}
//!     {"action":"set_alias","port":"COM3","alias":"GPS"}   # 空串/null 清除别名
//!     {"action":"run_script","name":"...","port":"COM3","script":{"code":"..."}}  # 运行 JS 脚本（受 enable_scripting 限制）
//!     {"action":"version"}                                # 查询服务版本（远程/Web 关于页用）
//!   server → client:
//!     {"type":"ports","ports":[...]}
//!     {"type":"data","port":"COM3","data":"...","encoding":"hex"}
//!     {"type":"opened","port":"COM3"}
//!     {"type":"closed","port":"COM3"}
//!     {"type":"acquired","port":"COM3","opened":bool,"config":{...},"holders":n}  # open 的直接回复（区分首开/附加）
//!     {"type":"holders","port":"COM3","holders":n}                                 # 持有者数量变化
//!     {"type":"script_result","name":"...","success":bool,"message":"..."}         # run_script 的结果
//!     {"type":"version","version":"0.1.0","enable_scripting":false}                # version 的直接回复
//!     {"type":"ok","message":"..."}
//!     {"type":"error","message":"..."}
//!
//! 会话与占有权：每条 WS 连接绑定一个 SessionId；open→acquire、close→release。
//! 断连时 release_all 释放本会话持有的全部端口（末位口才拆毁），杜绝泄漏。
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
use ss_core::{AcquireResult, ReleaseOutcome, SerialConfig, SerialEvent, SessionId};
use tokio::sync::mpsc;

/// 服务器 → 客户端 消息（全 owned，避免生命周期纠缠）。
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Ports { ports: Vec<crate::PortView> },
    Opened { port: String },
    Closed { port: String },
    /// open 的直接回复：opened=true 首开，false 附加（config 为实际配置，holders 为当前持有数）。
    Acquired { port: String, opened: bool, config: SerialConfig, holders: usize },
    /// 持有者数量变化（有人加入/退出，端口未关）。
    Holders { port: String, holders: usize },
    /// 端口元数据（别名等）变更——客户端应重新拉取端口列表。
    MetaChanged,
    Error { message: String },
    Ok { message: String },
    MacroResult { name: String, success: bool, message: String },
    /// run_script 的结果（与 MacroResult 同构）。
    ScriptResult { name: String, success: bool, message: String },
    /// version 的直接回复：服务端编译版本 + 是否启用远程脚本执行（前端据此显隐脚本 UI）。
    Version { version: String, enable_scripting: bool },
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
    RunMacro {
        name: String,
        port: String,
        r#macro: ss_core::Macro,
    },
    /// 运行 JS 脚本（受 settings.enable_scripting 限制，默认 false）。
    RunScript {
        name: String,
        port: String,
        script: ss_core::Script,
    },
    /// 设置端口别名（""/null = 清除）。别名写入 ports.json，跟随端口所在机器。
    SetAlias {
        port: String,
        #[serde(default)]
        alias: Option<String>,
    },
    /// 查询服务版本。
    Version,
}

fn default_encoding() -> String {
    "text".into()
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    // 每条连接一个会话：用于串口占有份额的归属追踪与断连清理
    let session = SessionId::next();
    tracing::info!("WS 客户端已连接 (session={:?})", session);

    let (mut ws_tx, mut ws_rx) = socket.split();

    // 输出 channel：所有要发给 client 的消息汇到这里统一发送（避免 select 中 &mut 冲突）
    let (out_tx, mut out_rx) = mpsc::channel::<OutFrame>(64);

    // 订阅原始事件流（A/B：暂时跳过合批层测延迟；MCP 不走此路，不受影响）
    let mut event_rx = state.event_bus.subscribe();

    // 推送初始端口列表
    {
        let ports = crate::list_ports_with_meta(&state).await;
        let _ = out_tx.send(to_json(ServerMsg::Ports { ports })).await;
    }

    // event → out channel（独立任务）
    let out_tx_evt = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                // 被本地强制踢出:发 Close 让主循环断开本连接
                Ok(SerialEvent::Kicked { session: kicked, .. }) if kicked == session => {
                    let _ = out_tx_evt.send(OutFrame::Close).await;
                }
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

    // 元数据（别名）变更 → 通知客户端重新拉取端口列表。
    // 否则别的客户端改了别名，本客户端要等下一个串口事件才看到。
    let mut meta_rx = state.meta_bus.subscribe();
    let out_tx_meta = out_tx.clone();
    let meta_task = tokio::spawn(async move {
        loop {
            match meta_rx.recv().await {
                Ok(()) => {
                    if out_tx_meta.send(to_json(ServerMsg::MetaChanged)).await.is_err() {
                        break;
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
                        // spawn 命令处理：避免 manager.write/acquire 等 await 阻塞 out_rx 消费，
                        // 否则 out channel 积压 → event_task 阻塞 → EventBus lagged 丢回显（快速输入吞字）
                        let state = state.clone();
                        let out_tx = out_tx.clone();
                        tokio::spawn(async move {
                            handle_client_msg(&text, &state, &out_tx, session).await;
                        });
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
                match out {
                    OutFrame::Text(s) => {
                        if ws_tx.send(Message::Text(s)).await.is_err() {
                            break;
                        }
                    }
                    OutFrame::Binary(v) => {
                        if ws_tx.send(Message::Binary(v)).await.is_err() {
                            break;
                        }
                    }
                    OutFrame::Close => {
                        let _ = ws_tx.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }

    // 先停本连接的事件转发，再释放占有份额；末位口才拆毁，事件广播给其它仍在的客户端
    event_task.abort();
    meta_task.abort();
    let released = state.manager.release_all(session).await;
    if !released.is_empty() {
        tracing::info!("session {:?} 断连，释放 {} 个持有端口", session, released.len());
    }
    tracing::info!("WS 客户端断开 (session={:?})", session);
}

/// 输出帧：控制消息走 Text(JSON)，串口数据走 Binary(帧头+原始字节)，Close 断开连接。
enum OutFrame {
    Text(String),
    Binary(Vec<u8>),
    /// 关闭连接(被踢出等),主循环发 Close frame 后断开。
    Close,
}

/// 构造数据 Binary 帧：`[port_len:u8][port UTF-8][data]`。
/// port_len 用 u8：串口设备名（COMn、/dev/ttyUSBn）远小于 255；超长由 debug_assert 拦截。
fn data_frame(port: &str, data: &[u8]) -> Vec<u8> {
    debug_assert!(port.len() <= 255, "port name too long for binary frame header");
    let port_bytes = port.as_bytes();
    let mut frame = Vec::with_capacity(1 + port_bytes.len() + data.len());
    frame.push(port_bytes.len() as u8);
    frame.extend_from_slice(port_bytes);
    frame.extend_from_slice(data);
    frame
}

fn to_json(msg: ServerMsg) -> OutFrame {
    OutFrame::Text(serde_json::to_string(&msg).unwrap())
}

fn event_to_msg(event: &SerialEvent) -> Option<OutFrame> {
    match event {
        // Kicked 是内部信号(通知 WS handler 断开),不转发给客户端
        SerialEvent::Kicked { .. } => None,
        // 数据走 Binary 帧直传字节（[port_len][port][data]），前端零解码
        SerialEvent::DataReceived { port, data } => Some(OutFrame::Binary(data_frame(port, data))),
        SerialEvent::PortOpened { port } => Some(to_json(ServerMsg::Opened { port: port.clone() })),
        SerialEvent::PortClosed { port } => Some(to_json(ServerMsg::Closed { port: port.clone() })),
        SerialEvent::HoldersChanged { port, holders } => Some(to_json(ServerMsg::Holders {
            port: port.clone(),
            holders: *holders,
        })),
        SerialEvent::Error { port, message } => Some(to_json(ServerMsg::Error {
            message: format!("{}: {}", port, message),
        })),
    }
}

async fn handle_client_msg(text: &str, state: &AppState, out_tx: &mpsc::Sender<OutFrame>, session: SessionId) {
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
            let ports = crate::list_ports_with_meta(&state).await;
            let _ = out_tx.send(to_json(ServerMsg::Ports { ports })).await;
        }
        ClientMsg::Open { port, config } => match state.manager.acquire(port.clone(), config, session).await {
            Ok(AcquireResult::Opened { config }) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Acquired { port, opened: true, config, holders: 1 }))
                    .await;
            }
            Ok(AcquireResult::Attached { config, holders }) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Acquired { port, opened: false, config, holders }))
                    .await;
            }
            Err(e) => {
                let _ = out_tx.send(to_json(ServerMsg::Error { message: e.to_string() })).await;
            }
        },
        ClientMsg::Close { port } => match state.manager.release(&port, session).await {
            Ok(ReleaseOutcome::Closed) => {
                let _ = out_tx.send(to_json(ServerMsg::Ok { message: "closed".into() })).await;
            }
            Ok(ReleaseOutcome::Released { remaining }) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok {
                        message: format!("released ({} holder(s) remaining)", remaining),
                    }))
                    .await;
            }
            Ok(ReleaseOutcome::NotHeld) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok { message: "not held".into() }))
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
        ClientMsg::RunMacro { name, port, r#macro: mac } => {
            // 宏定义由前端持有（本地存储），服务端无状态，只负责在指定端口执行
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
        ClientMsg::RunScript { name, port, script } => {
            // 远程路径强制闸门:服务器默认 0.0.0.0 无认证,脚本执行须显式开启
            if !state.enable_scripting.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = out_tx
                    .send(to_json(ServerMsg::Error {
                        message: "远程脚本执行未启用(settings.json 的 enable_scripting=false)".into(),
                    }))
                    .await;
                return;
            }
            // 并发上限:防远程同时起大量脚本线程(每脚本一个 OS 线程 + QuickJS runtime)DoS。
            // permit 随下方 spawn 闭包结束自动释放。
            let permit = match state.script_semaphore.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Error {
                            message: "脚本执行并发已满,稍后再试".into(),
                        }))
                        .await;
                    return;
                }
            };
            // 端口预检:未打开则脚本内 send 全静默失败却显示"完成",误导——提前拒。
            if !state.manager.is_open(&port).await {
                let _ = out_tx
                    .send(to_json(ServerMsg::Error {
                        message: format!("端口 {} 未打开,请先连接", port),
                    }))
                    .await;
                return;
            }
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok { message: format!("运行脚本 {}", name) }))
                .await;
            tokio::spawn(async move {
                let _permit = permit; // 持有到脚本结束
                let result = ss_core::run_script(&port, &script, manager).await;
                let msg = match result {
                    Ok(()) => ServerMsg::ScriptResult {
                        name,
                        success: true,
                        message: "完成".into(),
                    },
                    Err(e) => ServerMsg::ScriptResult {
                        name,
                        success: false,
                        message: e.display_message(),
                    },
                };
                let _ = out_tx2.send(to_json(msg)).await;
            });
        }
        ClientMsg::SetAlias { port, alias } => {
            match crate::set_alias_and_notify(state, &port, alias) {
                Ok(()) => {
                    let _ = out_tx.send(to_json(ServerMsg::Ok { message: "alias set".into() })).await;
                }
                Err(e) => {
                    let _ = out_tx.send(to_json(ServerMsg::Error { message: e })).await;
                }
            }
        }
        ClientMsg::Version => {
            let enable_scripting = state
                .enable_scripting
                .load(std::sync::atomic::Ordering::Relaxed);
            let _ = out_tx
                .send(to_json(ServerMsg::Version {
                    version: env!("CARGO_PKG_VERSION").into(),
                    enable_scripting,
                }))
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_frame_layout() {
        let f = data_frame("COM3", &[0x41, 0x42, 0x43]);
        // [port_len=4][C O M 3][data...]
        assert_eq!(f, vec![4, b'C', b'O', b'M', b'3', 0x41, 0x42, 0x43]);
    }

    #[test]
    fn data_frame_empty_data() {
        let f = data_frame("COM7", &[]);
        assert_eq!(f, vec![4, b'C', b'O', b'M', b'7']);
    }

    #[test]
    fn data_frame_multibyte_port() {
        // 多字节端口名（UTF-8）：port_len 是字节长度，不是字符数
        let port = "串口1";
        let f = data_frame(port, &[0xff]);
        assert_eq!(f[0] as usize, port.len());
        assert_eq!(&f[1..1 + port.len()], port.as_bytes());
        assert_eq!(&f[1 + port.len()..], &[0xff]);
    }
}

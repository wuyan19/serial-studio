//! WebSocket 协议适配层。
//!
//! 协议（JSON）：
//!   client → server:
//!     {"action":"list"}
//!     {"action":"open","port":"COM3","config":{"baud_rate":115200,...}}
//!     {"action":"close","port":"COM3"}
//!     {"action":"write","port":"COM3","data":"...","encoding":"hex|text"}
//!     {"action":"set_alias","port":"COM3","alias":"GPS"}   # 空串/null 清除别名
//!     {"action":"run_script","name":"...","port":"COM3","script":{"code":"..."},"run_id":"<uuid>","args":{...}}  # 运行 JS 脚本（受 enable_scripting 限制）
//!     {"action":"stop_script","run_id":"<uuid>"}                              # 停止运行中的脚本
//!     {"action":"version"}                                # 查询服务版本（远程/Web 关于页用）
//!   server → client:
//!     {"type":"ports","ports":[...]}
//!     {"type":"data","port":"COM3","data":"...","encoding":"hex"}
//!     {"type":"opened","port":"COM3"}
//!     {"type":"closed","port":"COM3"}
//!     {"type":"acquired","port":"COM3","opened":bool,"config":{...},"holders":n}  # open 的直接回复（区分首开/附加）
//!     {"type":"holders","port":"COM3","holders":n}                                 # 持有者数量变化
//!     {"type":"script_result","run_id":"...","name":"...","success":bool,"message":"..."}  # run_script 的结果（含停止 Aborted）
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
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::mpsc;

/// 服务器 → 客户端 消息（全 owned，避免生命周期纠缠）。
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Ports { ports: Vec<crate::PortView> },
    Opened { port: String },
    Closed { port: String },
    /// 设备意外断开(USB 拔出):前端保留 tab 可重连(区别于 Closed 的删 tab)。
    Disconnected { port: String },
    /// open 的直接回复：opened=true 首开，false 附加（config 为实际配置，holders 为当前持有数）。
    Acquired { port: String, opened: bool, config: SerialConfig, holders: usize },
    /// 持有者数量变化（有人加入/退出，端口未关）。
    Holders { port: String, holders: usize },
    /// 端口元数据（别名等）变更——客户端应重新拉取端口列表。
    MetaChanged,
    Error { message: String },
    Ok { message: String },
    MacroResult { run_id: String, name: String, success: bool, message: String },
    /// run_script 的结果（与 MacroResult 同构）。run_id 供前端按运行实例路由（停止/并发区分）。
    ScriptResult { run_id: String, name: String, success: bool, message: String },
    /// 脚本 log() 输出(实时)。前端按 run_id 路由到对应运行实例的日志区。port 不转发(前端按 run_id 路由)。
    ScriptLog { run_id: String, message: String },
    /// version 的直接回复：服务端编译版本 + 是否启用远程脚本执行（前端据此显隐脚本 UI）。
    Version { version: String, enable_scripting: bool },
    /// get_script_skill 的直接回复：脚本编写 SKILL 全文(前端展示 / 复制给外部 Agent)。
    ScriptSkill { text: String },
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
        /// 运行实例 id（前端生成 uuid），用于停止与结果路由（对齐 RunScript）。
        run_id: String,
    },
    /// 运行 JS 脚本（受 settings.enable_scripting 限制，默认 false）。
    RunScript {
        name: String,
        port: String,
        script: ss_core::Script,
        #[serde(default)]
        args: std::collections::HashMap<String, String>,
        /// 运行实例 id（前端生成 uuid）,用于停止与结果路由。
        run_id: String,
    },
    /// 停止运行中的脚本（按 run_id）:set 对应 abort flag,脚本经 sleep 轮询退出。
    StopScript { run_id: String },
    /// 停止运行中的宏(按 run_id):复用 script_runs 表,set abort flag → 宏经 Delay 分段/Expect select! 退出。
    StopMacro { run_id: String },
    /// 设置端口别名（""/null = 清除）。别名写入 ports.json，跟随端口所在机器。
    SetAlias {
        port: String,
        #[serde(default)]
        alias: Option<String>,
    },
    /// 查询服务版本。
    Version,
    /// 拉取脚本编写 SKILL 全文(展示 / 复制给外部 Agent)。
    GetScriptSkill,
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

    // 直连关闭信号:被本地 force_close 踢出时,经 AppState.closers 点对点触发断开
    // (不靠 EventBus 广播——广播 Lagged 会丢,踢人须必送达)
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();
    state.closers.lock().unwrap().insert(session, close_tx);

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
                let msg = match out {
                    OutFrame::Text(s) => Message::Text(s),
                    OutFrame::Binary(v) => Message::Binary(v),
                };
                if ws_tx.send(msg).await.is_err() {
                    break;
                }
            }
            _ = &mut close_rx => {
                // 被本地 force_close 点对点触发断开(发 Close frame + 超时防自阻)
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    ws_tx.send(Message::Close(None)),
                )
                .await;
                break;
            }
        }
    }

    // 先停本连接的事件转发，再释放占有份额；末位口才拆毁，事件广播给其它仍在的客户端
    event_task.abort();
    meta_task.abort();
    state.closers.lock().unwrap().remove(&session);
    // 本 session 启动的脚本跟着停(防 orphan:客户端断连后脚本继续占并发槽,无超时后变无界)
    let orphan_aborts: Vec<Arc<AtomicBool>> = state
        .script_runs
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, r)| matches!(&r.owner, crate::ScriptOwner::Session(s) if s == &session))
        .map(|(_, r)| r.abort.clone())
        .collect();
    for f in orphan_aborts {
        f.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let released = state.manager.release_all(session).await;
    if !released.is_empty() {
        tracing::info!("session {:?} 断连，释放 {} 个持有端口", session, released.len());
    }
    tracing::info!("WS 客户端断开 (session={:?})", session);
}

/// 输出帧：控制消息走 Text(JSON)，串口数据走 Binary(帧头+原始字节)。
enum OutFrame {
    Text(String),
    Binary(Vec<u8>),
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
    Some(match event {
        // 数据走 Binary 帧直传字节（[port_len][port][data]），前端零解码
        SerialEvent::DataReceived { port, data } => OutFrame::Binary(data_frame(port, data)),
        SerialEvent::PortOpened { port } => to_json(ServerMsg::Opened { port: port.clone() }),
        SerialEvent::PortClosed { port } => to_json(ServerMsg::Closed { port: port.clone() }),
        SerialEvent::PortDisconnected { port } => to_json(ServerMsg::Disconnected { port: port.clone() }),
        SerialEvent::HoldersChanged { port, holders } => to_json(ServerMsg::Holders {
            port: port.clone(),
            holders: *holders,
        }),
        SerialEvent::Error { port, message } => to_json(ServerMsg::Error {
            message: format!("{}: {}", port, message),
        }),
        SerialEvent::ScriptLog { run_id, message, .. } => to_json(ServerMsg::ScriptLog {
            run_id: run_id.clone(),
            message: message.clone(),
        }),
    })
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
            Ok(AcquireResult::Opened { config, holders }) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Acquired { port, opened: true, config, holders }))
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
        ClientMsg::RunMacro { name, port, r#macro: mac, run_id } => {
            // 宏定义由前端持有（本地存储），服务端无状态，只负责在指定端口执行
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            // 注册停止信号(复用 script_runs 表):StopMacro 时 set flag,宏经 Delay 分段/Expect select! 退出。
            let abort = Arc::new(AtomicBool::new(false));
            state.script_runs.lock().unwrap().insert(
                run_id.clone(),
                crate::ScriptRun { abort: abort.clone(), owner: crate::ScriptOwner::Session(session) },
            );
            let script_runs = state.script_runs.clone();
            let run_id_for_cleanup = run_id.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok { message: format!("运行宏 {}", name) }))
                .await;
            tokio::spawn(async move {
                let result = ss_core::run_macro(&port, &mac, &manager, abort).await;
                script_runs.lock().unwrap().remove(&run_id_for_cleanup);
                let msg = match result {
                    Ok(()) => ServerMsg::MacroResult {
                        run_id,
                        name,
                        success: true,
                        message: "完成".into(),
                    },
                    Err(e) => ServerMsg::MacroResult {
                        run_id,
                        name,
                        success: false,
                        message: e.display_message(),
                    },
                };
                let _ = out_tx2.send(to_json(msg)).await;
            });
        }
        ClientMsg::RunScript { name, port, script, args, run_id } => {
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
            // 不预检端口:未开则脚本内 send 返 Some(fail) → JS 包装层 throw "send 失败(端口 X): …",
            // 脚本中断回明确错误(不再静默坑用户)。见 core/script.rs send 闭包 + JS 包装层。
            // 注册停止信号:StopScript 时 set flag,脚本 sleep 分段轮询命中即抛异常退出。
            let abort = Arc::new(AtomicBool::new(false));
            state.script_runs.lock().unwrap().insert(
                run_id.clone(),
                crate::ScriptRun { abort: abort.clone(), owner: crate::ScriptOwner::Session(session) },
            );
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            let script_runs = state.script_runs.clone();
            let run_id_for_cleanup = run_id.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok { message: format!("运行脚本 {}", name) }))
                .await;
            tokio::spawn(async move {
                let _permit = permit; // 持有到脚本结束
                // None 超时 = 无总时长上限(长跑复现);停止靠 abort + sleep 分段轮询。
                let result = ss_core::run_script_with_timeout(&port, &script.code, manager, None, args, &run_id, abort).await;
                script_runs.lock().unwrap().remove(&run_id_for_cleanup);
                let msg = match result {
                    Ok(()) => ServerMsg::ScriptResult {
                        run_id,
                        name,
                        success: true,
                        message: "完成".into(),
                    },
                    Err(e) => ServerMsg::ScriptResult {
                        run_id,
                        name,
                        success: false,
                        message: e.display_message(),
                    },
                };
                let _ = out_tx2.send(to_json(msg)).await;
            });
        }
        ClientMsg::StopScript { run_id } => {
            // 锁内取 abort Arc,锁随 block 结束立即释放,再 store/send——避免持 std 锁跨 await(非 Send)
            let abort = { state.script_runs.lock().unwrap().get(&run_id).map(|r| r.abort.clone()) };
            match abort {
                Some(flag) => {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = out_tx.send(to_json(ServerMsg::Ok { message: "停止信号已发送".into() })).await;
                }
                None => {
                    let _ = out_tx.send(to_json(ServerMsg::Ok { message: "脚本已结束或不存在".into() })).await;
                }
            }
        }
        ClientMsg::StopMacro { run_id } => {
            // 与 StopScript 同表(script_runs):run_id uuid 不区分宏/脚本,abort flag 通用。
            let abort = { state.script_runs.lock().unwrap().get(&run_id).map(|r| r.abort.clone()) };
            match abort {
                Some(flag) => {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = out_tx.send(to_json(ServerMsg::Ok { message: "停止信号已发送".into() })).await;
                }
                None => {
                    let _ = out_tx.send(to_json(ServerMsg::Ok { message: "宏已结束或不存在".into() })).await;
                }
            }
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
        ClientMsg::GetScriptSkill => {
            let _ = out_tx
                .send(to_json(ServerMsg::ScriptSkill {
                    text: crate::SCRIPT_SKILL.into(),
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

    #[test]
    fn event_to_msg_script_log_is_text_json() {
        // 锁定 WS 转发契约:ScriptLog → Text JSON,type=script_log,port 不转发(前端按 run_id 路由)。
        let evt = SerialEvent::ScriptLog {
            run_id: "r1".into(),
            port: "COM5".into(),
            message: "hello world".into(),
        };
        match event_to_msg(&evt).expect("ScriptLog 应转发为 Some") {
            OutFrame::Text(json) => {
                assert!(json.contains(r#""type":"script_log""#), "type 字段: {json}");
                assert!(json.contains(r#""run_id":"r1""#), "run_id: {json}");
                assert!(json.contains(r#""message":"hello world""#), "message: {json}");
                assert!(!json.contains("COM5"), "port 不应转发给前端: {json}");
            }
            OutFrame::Binary(_) => panic!("ScriptLog 应是 Text(JSON),非 Binary"),
        }
    }
}

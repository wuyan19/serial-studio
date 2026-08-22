//! WebSocket 协议适配层:axum WS 会话 ↔ SerialManager/EventBus 的接线。
//! 消息词典与编解码单一定义在 `crate::protocol`(勿在此另写副本);数据帧
//! `[port_len:u8][port UTF-8][data]` 仅 server→client,上行写走 JSON write action。
//!
//! 会话与占有权：每条 WS 连接绑定一个 SessionId；open→acquire、close→release。
//! 断连时 release_all 释放本会话持有的全部端口（末位口才拆毁），杜绝泄漏。
//! 数据流：client 命令 → SerialManager；EventBus 事件 → 推给 client。

use crate::protocol::{data_frame, to_json, ClientMsg, OutFrame, ServerMsg};
use crate::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use ss_core::{AcquireResult, ReleaseOutcome, SerialEvent, SessionId};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::mpsc;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    // TODO(心跳对称): 客户端→服务端方向已由前端应用层 ping/pong 探活；反向（服务端探客户端死活）
    // 当前只靠 ws_rx.next() 返回 None/Err，TCP half-open 下可能数分钟才感知。如需更快回收 session，
    // 可在此起定时器，空闲超时则主动关闭连接。
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

    // 推送初始端口列表与设备在线快照
    {
        let ports = crate::list_ports_with_meta(&state).await;
        let _ = out_tx.send(to_json(ServerMsg::Ports { ports })).await;
        let devices = state.devices.device_states();
        let _ = out_tx.send(to_json(ServerMsg::Devices { devices })).await;
    }

    // 设备上下线 → 重推 Devices 快照(连接存活期间设备增删/断连可见)
    let mut device_rx = state.devices.subscribe();
    let out_tx_dev = out_tx.clone();
    let devices_mgr = state.devices.clone();
    let device_task = tokio::spawn(async move {
        loop {
            match device_rx.recv().await {
                Ok(_) => {
                    let devices = devices_mgr.device_states();
                    if out_tx_dev
                        .send(to_json(ServerMsg::Devices { devices }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // Lagged = 积压丢事件:若丢的是最后一个(如最终 Offline),裸 continue 会
                // 让该连接的设备状态永久陈旧——重推一次快照自愈
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let devices = devices_mgr.device_states();
                    if out_tx_dev
                        .send(to_json(ServerMsg::Devices { devices }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

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
                    if out_tx_meta
                        .send(to_json(ServerMsg::MetaChanged))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // Lagged = 积压丢事件:补发一次通知让客户端重拉自愈
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if out_tx_meta
                        .send(to_json(ServerMsg::MetaChanged))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // 脚本库变更 → 通知客户端重新拉取脚本列表(MCP/Tauri 写入后前端即时刷新)。
    let mut script_rx = state.script_bus.subscribe();
    let out_tx_script = out_tx.clone();
    let script_task = tokio::spawn(async move {
        loop {
            match script_rx.recv().await {
                Ok(()) => {
                    if out_tx_script
                        .send(to_json(ServerMsg::ScriptsChanged))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // Lagged = 积压丢事件:补发一次通知让客户端重拉自愈
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if out_tx_script
                        .send(to_json(ServerMsg::ScriptsChanged))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
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
                            .send(to_json(ServerMsg::Error { message: "仅支持文本消息".into(), port: None }))
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
    script_task.abort();
    device_task.abort();
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
        tracing::info!(
            "session {:?} 断连，释放 {} 个持有端口",
            session,
            released.len()
        );
    }
    tracing::info!("WS 客户端断开 (session={:?})", session);
}

fn event_to_msg(event: &SerialEvent) -> Option<OutFrame> {
    Some(match event {
        // 数据走 Binary 帧直传字节（[port_len][port][data]），前端零解码
        SerialEvent::DataReceived { port, data } => OutFrame::Binary(data_frame(port, data)),
        SerialEvent::PortOpened { port } => to_json(ServerMsg::Opened { port: port.clone() }),
        SerialEvent::PortClosed { port } => to_json(ServerMsg::Closed { port: port.clone() }),
        SerialEvent::PortDisconnected { port } => {
            to_json(ServerMsg::Disconnected { port: port.clone() })
        }
        SerialEvent::HoldersChanged { port, holders } => to_json(ServerMsg::Holders {
            port: port.clone(),
            holders: *holders,
        }),
        SerialEvent::Error { port, message } => to_json(ServerMsg::Error {
            message: format!("{}: {}", port, message),
            port: None,
        }),
        SerialEvent::ScriptLog {
            run_id, message, ..
        } => to_json(ServerMsg::ScriptLog {
            run_id: run_id.clone(),
            message: message.clone(),
        }),
    })
}

async fn handle_client_msg(
    text: &str,
    state: &AppState,
    out_tx: &mpsc::Sender<OutFrame>,
    session: SessionId,
) {
    let msg: ClientMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            let _ = out_tx
                .send(to_json(ServerMsg::Error {
                    message: format!("指令解析失败: {}", e),
                    port: None,
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
        ClientMsg::Open { port, config } => {
            match state.manager.acquire(port.clone(), config, session).await {
                Ok(AcquireResult::Opened { config, holders }) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Acquired {
                            port,
                            opened: true,
                            config,
                            holders,
                        }))
                        .await;
                }
                Ok(AcquireResult::Attached { config, holders }) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Acquired {
                            port,
                            opened: false,
                            config,
                            holders,
                        }))
                        .await;
                }
                Err(e) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Error {
                            message: e.to_string(),
                            port: Some(port),
                        }))
                        .await;
                }
            }
        }
        ClientMsg::Close { port } => match state.manager.release(&port, session).await {
            Ok(ReleaseOutcome::Closed) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok {
                        message: "closed".into(),
                        port: Some(port),
                    }))
                    .await;
            }
            Ok(ReleaseOutcome::Released { remaining }) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok {
                        message: format!("released ({} holder(s) remaining)", remaining),
                        port: Some(port),
                    }))
                    .await;
            }
            Ok(ReleaseOutcome::NotHeld) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Ok {
                        message: "not held".into(),
                        port: Some(port),
                    }))
                    .await;
            }
            Err(e) => {
                let _ = out_tx
                    .send(to_json(ServerMsg::Error {
                        message: e.to_string(),
                        port: Some(port),
                    }))
                    .await;
            }
        },
        ClientMsg::Write {
            port,
            data,
            encoding,
        } => {
            let bytes = match encoding.as_str() {
                "hex" => match hex::decode(data.trim()) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = out_tx
                            .send(to_json(ServerMsg::Error {
                                message: format!("hex 解码失败: {}", e),
                                port: Some(port),
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
                            port: Some(port),
                        }))
                        .await;
                    return;
                }
            };
            // 回执语义 = "已受理"(入队即回):设备客户端的写回执不再等远端 OS 写完
            // (WAN RTT 会把宏/脚本的循环写从 µs 级拖到每条一个 RTT)。真实写结果
            // 异步到达,失败经 Error 事件回报(此时写者的 pending 已结,仅留痕——
            // 失败罕见且断连有统一断开路径兜底)。
            let _ = out_tx
                .send(to_json(ServerMsg::Ok {
                    message: format!("accepted {} bytes", bytes.len()),
                    port: Some(port.clone()),
                }))
                .await;
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            let port_for_err = port.clone();
            tokio::spawn(async move {
                if let Err(e) = manager
                    .write(port_for_err.clone(), bytes::Bytes::from(bytes))
                    .await
                {
                    tracing::warn!("端口 {} 异步写失败: {}", port_for_err, e);
                    let _ = out_tx2
                        .send(to_json(ServerMsg::Error {
                            message: e.to_string(),
                            port: Some(port_for_err),
                        }))
                        .await;
                }
            });
        }
        ClientMsg::RunMacro {
            name,
            port,
            r#macro: mac,
            run_id,
        } => {
            // 宏定义由前端持有（本地存储），服务端无状态，只负责在指定端口执行
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            // 注册停止信号(复用 script_runs 表):StopMacro 时 set flag,宏经 Delay 分段/Expect select! 退出。
            let abort = Arc::new(AtomicBool::new(false));
            state.script_runs.lock().unwrap().insert(
                run_id.clone(),
                crate::ScriptRun {
                    abort: abort.clone(),
                    owner: crate::ScriptOwner::Session(session),
                },
            );
            let script_runs = state.script_runs.clone();
            let run_id_for_cleanup = run_id.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok {
                    message: format!("运行宏 {}", name),
                    port: None,
                }))
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
        ClientMsg::RunScript {
            name,
            port,
            script,
            args,
            run_id,
        } => {
            // 远程路径强制闸门:服务器默认 0.0.0.0 无认证,脚本执行须显式开启
            if !state
                .enable_scripting
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let _ = out_tx
                    .send(to_json(ServerMsg::Error {
                        message: "远程脚本执行未启用(settings.json 的 enable_scripting=false)"
                            .into(),
                        port: None,
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
                            port: None,
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
                crate::ScriptRun {
                    abort: abort.clone(),
                    owner: crate::ScriptOwner::Session(session),
                },
            );
            let manager = state.manager.clone();
            let out_tx2 = out_tx.clone();
            let script_runs = state.script_runs.clone();
            let run_id_for_cleanup = run_id.clone();
            let _ = out_tx
                .send(to_json(ServerMsg::Ok {
                    message: format!("运行脚本 {}", name),
                    port: None,
                }))
                .await;
            tokio::spawn(async move {
                let _permit = permit; // 持有到脚本结束
                                      // None 超时 = 无总时长上限(长跑复现);停止靠 abort + sleep 分段轮询。
                let result = ss_core::run_script_with_timeout(
                    &port,
                    &script.code,
                    manager,
                    None,
                    args,
                    &run_id,
                    abort,
                )
                .await;
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
            let abort = {
                state
                    .script_runs
                    .lock()
                    .unwrap()
                    .get(&run_id)
                    .map(|r| r.abort.clone())
            };
            match abort {
                Some(flag) => {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: "停止信号已发送".into(),
                            port: None,
                        }))
                        .await;
                }
                None => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: "脚本已结束或不存在".into(),
                            port: None,
                        }))
                        .await;
                }
            }
        }
        ClientMsg::StopMacro { run_id } => {
            // 与 StopScript 同表(script_runs):run_id uuid 不区分宏/脚本,abort flag 通用。
            let abort = {
                state
                    .script_runs
                    .lock()
                    .unwrap()
                    .get(&run_id)
                    .map(|r| r.abort.clone())
            };
            match abort {
                Some(flag) => {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: "停止信号已发送".into(),
                            port: None,
                        }))
                        .await;
                }
                None => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: "宏已结束或不存在".into(),
                            port: None,
                        }))
                        .await;
                }
            }
        }
        ClientMsg::SetAlias { port, alias } => {
            // 远端设备的别名转发是同步阻塞 RPC(最长 10s)——包 spawn_blocking,
            // 勿占 runtime worker 线程。回执带 port:设备客户端按端口路由在途回执
            // (漏带会等满 10s 超时假报错)。
            let st = state.clone();
            let p = port.clone();
            let result =
                tokio::task::spawn_blocking(move || crate::set_alias_and_notify(&st, &p, alias))
                    .await
                    .map_err(|e| format!("join 错误: {}", e))
                    .and_then(|r| r);
            match result {
                Ok(()) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Ok {
                            message: "alias set".into(),
                            port: Some(port),
                        }))
                        .await;
                }
                Err(e) => {
                    let _ = out_tx
                        .send(to_json(ServerMsg::Error {
                            message: e,
                            port: Some(port),
                        }))
                        .await;
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
        ClientMsg::Ping => {
            // 应用层心跳应答：客户端用 ping/pong 探活（应对服务端强杀不发 Close frame）
            let _ = out_tx.send(to_json(ServerMsg::Pong)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                assert!(
                    json.contains(r#""message":"hello world""#),
                    "message: {json}"
                );
                assert!(!json.contains("COM5"), "port 不应转发给前端: {json}");
            }
            OutFrame::Binary(_) => panic!("ScriptLog 应是 Text(JSON),非 Binary"),
        }
    }
}

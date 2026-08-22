//! 单台远程设备的连接客户端:一条 WS 到远端 ss,管理该设备全部端口的
//! 打开/写入/关闭/别名转发与数据帧分发。
//!
//! 状态机:Connecting → Connected(reader + writer + watchdog)→ 断开 → 退避重连
//! (1s×2^n ±20% jitter,cap 30s;连接成功即归零)。断开时:广播 Offline、关闭本设备
//! 全部在用端口的 IO 状态(read 返 Err → drainer 走断开路径)、清在途回执;远端
//! release_all 自动释放远端占有,无需显式 close。
//!
//! 对外只暴露同步入口(open_blocking 等,在 manager 的 spawn_blocking 里调),
//! 与异步会话经 unbounded 命令通道 + std mpsc 回执交互。命令通道由 writer 独占
//! 消费(单写者保序:open/write/close 同通道,close 不走旁路)。

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use ss_core::{RemoteDevice, SerialConfig, SerialError};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::protocol::{parse_data_frame, ClientMsg, DeviceStateView, ServerMsg};
use crate::PortView;

use super::port_io::{read_timeout_of, RemotePortIo, RemoteSharedIo};
use super::{DeviceCommand, DeviceEvent};

/// 心跳参数(对齐前端 transport.ts:10s 一探,20s 无入站判死)。
const PING_INTERVAL: Duration = Duration::from_secs(10);
const DEAD_AFTER: Duration = Duration::from_secs(20);
/// 连接超时(含 TCP + WS 握手)。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// open/set_alias 回执等待。
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
/// writer 单次发送超时(背压/半开防护):超时视为断连。
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

type WsSink =
    SplitSink<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>;

/// 在途回执(open/set_alias 的 Result、write 的 io 结果),按远端线名路由。
pub(crate) enum PendingReply {
    Result {
        port: String,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Write {
        port: String,
        reply: std::sync::mpsc::Sender<io::Result<()>>,
    },
}

/// 设备共享态:连接重建后复用(cmd_tx 不换,外部 sender 恒有效)。
pub(crate) struct DeviceInner {
    pub(crate) dev: RemoteDevice,
    pub(crate) online: AtomicBool,
    /// 命令通道(writer 独占消费;断连期间的积压在新会话开始时被丢弃——陈旧
    /// Open/Write 重放会打开无人对账的端口/突发打到串口设备)。
    pub(crate) cmd_tx: tokio::sync::mpsc::UnboundedSender<DeviceCommand>,
    /// 远端线名 → 在用端口的 IO 状态(**Weak**:句柄释放即条目失效,帧分发
    /// upgrade 失败自动清——不阻 PortIo 生命周期,正常关闭不留残留)。
    pub(crate) ports: Mutex<Vec<(String, std::sync::Weak<RemoteSharedIo>)>>,
    /// 远端上报的端口列表缓存(list 合并用,PortView 含远端别名)。
    pub(crate) cached_ports: Mutex<Vec<PortView>>,
    /// 在途回执表。
    pub(crate) pending: Mutex<Vec<PendingReply>>,
    /// 主动停止标记(remove 设备/断开按钮)→ run loop 不再重连。
    pub(crate) stopped: AtomicBool,
    /// 会话取消信号(stop 触发,活跃 session 的 select 监听——仅靠 stopped 标志
    /// 会话感知不到,而自己的心跳 Ping/Pong 会持续刷新"无入站判死",连接永不退出)。
    pub(crate) session_stop: tokio::sync::Notify,
}

pub struct DeviceClient {
    inner: Arc<DeviceInner>,
    /// 命令接收端(仅 run 启动时取一次)。
    cmd_rx: tokio::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<DeviceCommand>>>,
    device_bus: broadcast::Sender<DeviceEvent>,
    meta_bus: broadcast::Sender<()>,
}

impl DeviceClient {
    pub(crate) fn new(
        dev: RemoteDevice,
        device_bus: broadcast::Sender<DeviceEvent>,
        meta_bus: broadcast::Sender<()>,
    ) -> Self {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            inner: Arc::new(DeviceInner {
                dev,
                online: AtomicBool::new(false),
                cmd_tx,
                ports: Mutex::new(Vec::new()),
                cached_ports: Mutex::new(Vec::new()),
                pending: Mutex::new(Vec::new()),
                stopped: AtomicBool::new(false),
                session_stop: tokio::sync::Notify::new(),
            }),
            cmd_rx: tokio::sync::Mutex::new(Some(cmd_rx)),
            device_bus,
            meta_bus,
        }
    }

    pub fn device(&self) -> &RemoteDevice {
        &self.inner.dev
    }

    /// 端口列表缓存快照(列表合并用)。
    pub(crate) fn cached_ports_snapshot(&self) -> Vec<PortView> {
        self.inner.cached_ports.lock().unwrap().clone()
    }

    pub fn online(&self) -> bool {
        self.inner.online.load(Ordering::Relaxed)
    }

    /// 设备状态快照(Devices 推送用)。
    pub fn state_view(&self) -> DeviceStateView {
        DeviceStateView {
            id: self.inner.dev.id.clone(),
            online: self.online(),
        }
    }

    /// 打开远端端口(同步,manager 的 spawn_blocking 里调)。
    /// 成功时登记 RemoteSharedIo(Weak)并返回 PortIo 句柄;设备离线直接报错。
    /// 线名先规范化(裸名补 local::)——远端回的数据帧/Acquired 都用远端侧完整键,
    /// 登记键与之一致,分发/路由才不 miss。
    pub fn open_blocking(
        &self,
        port: &str,
        config: &SerialConfig,
    ) -> Result<Box<dyn ss_core::PortIo>, SerialError> {
        let port = ss_core::normalize_port_key(port);
        if !self.online() {
            return Err(SerialError::OpenFailed {
                port: format!("{}::{}", self.inner.dev.id, port),
                message: format!("设备 {}({}) 未连接", self.inner.dev.id, self.inner.dev.host),
            });
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        self.inner
            .cmd_tx
            .send(DeviceCommand::Open {
                port: port.clone(),
                config: config.clone(),
                reply: reply_tx,
            })
            .map_err(|_| SerialError::OpenFailed {
                port: port.clone(),
                message: "设备连接已断开".into(),
            })?;
        match reply_rx.recv_timeout(RPC_TIMEOUT) {
            Ok(Ok(())) => {
                let shared = Arc::new(RemoteSharedIo::new(read_timeout_of(config)));
                let mut ports = self.inner.ports.lock().unwrap();
                ports.retain(|(_, w)| w.upgrade().is_some()); // 顺带清已失效条目
                ports.push((port.clone(), Arc::downgrade(&shared)));
                Ok(Box::new(RemotePortIo::new(
                    shared,
                    self.inner.cmd_tx.clone(),
                    Arc::clone(&self.inner),
                    port,
                )))
            }
            Ok(Err(msg)) => Err(SerialError::OpenFailed {
                port: format!("{}::{}", self.inner.dev.id, port),
                message: format!("远端打开失败: {}", msg),
            }),
            Err(_) => {
                // 超时:挂起的回执可能晚到,清掉防泄漏(晚到的 acquired 找不到就丢弃)
                drop_pending(&self.inner, port.as_str());
                Err(SerialError::OpenFailed {
                    port,
                    message: "远端打开超时".into(),
                })
            }
        }
    }

    /// 设置远端端口别名(转发 WS set_alias——别名归端口所在机器)。
    pub fn set_alias_blocking(&self, port: &str, alias: Option<String>) -> Result<(), String> {
        let port = ss_core::normalize_port_key(port);
        if !self.online() {
            return Err(format!("设备 {} 未连接", self.inner.dev.id));
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        self.inner
            .cmd_tx
            .send(DeviceCommand::SetAlias {
                port: port.to_string(),
                alias,
                reply: reply_tx,
            })
            .map_err(|_| "设备连接已断开".to_string())?;
        match reply_rx.recv_timeout(RPC_TIMEOUT) {
            Ok(r) => r,
            Err(_) => {
                drop_pending(&self.inner, port.as_str());
                Err("远端设置别名超时".into())
            }
        }
    }

    /// 主动停止(不重连)。remove/断开/重连设备时用:置标志 + 取消活跃会话
    /// (否则心跳 Ping/Pong 持续刷新看门狗,WS 无限存活成幽灵连接,远端占有权泄漏)。
    pub fn stop(&self) {
        self.inner.stopped.store(true, Ordering::Relaxed);
        self.inner.session_stop.notify_waiters();
        self.set_offline("设备已移除");
    }

    fn set_offline(&self, reason: &str) {
        if !self.inner.online.swap(false, Ordering::Relaxed) {
            return; // 已离线,幂等
        }
        // 关闭在用端口的 IO 状态(唤醒阻塞 read → port_task 走断开路径)
        let closed: Vec<Arc<RemoteSharedIo>> = {
            let mut ports = self.inner.ports.lock().unwrap();
            ports.drain(..).filter_map(|(_, w)| w.upgrade()).collect()
        };
        for io in closed {
            io.close_with_error(io::Error::new(io::ErrorKind::ConnectionAborted, reason));
        }
        // 在途回执全部失败(尽快让调用方拿错;recv_timeout 兜底之外的快速路径)
        let drained: Vec<PendingReply> = self.inner.pending.lock().unwrap().drain(..).collect();
        for p in drained {
            match p {
                PendingReply::Result { reply, .. } => {
                    let _ = reply.send(Err(reason.to_string()));
                }
                PendingReply::Write { reply, .. } => {
                    let _ = reply.send(Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        reason,
                    )));
                }
            }
        }
        // 缓存列表 opened 置 false(防 UI 假绿灯;条目保留供展示)
        self.inner
            .cached_ports
            .lock()
            .unwrap()
            .iter_mut()
            .for_each(|p| p.info.opened = false);
        let _ = self.device_bus.send(DeviceEvent::Offline {
            dev_id: self.inner.dev.id.clone(),
        });
        let _ = self.meta_bus.send(());
    }

    /// 连接主循环。由 DeviceClientManager::start spawn(每设备一次)。
    pub(crate) async fn run(self: Arc<Self>) {
        let cmd_rx = match self.cmd_rx.lock().await.take() {
            Some(rx) => rx,
            None => return, // 已启动(幂等保护)
        };
        // 共享接收端:每个连接会话的 writer 持一份 clone(重连后新 writer 继续
        // 消费同一通道,外部 sender 恒有效;writer 串行消费,锁无竞争)
        let cmd_rx = Arc::new(tokio::sync::Mutex::new(cmd_rx));
        let mut backoff = Duration::from_secs(1);
        loop {
            if self.inner.stopped.load(Ordering::Relaxed) {
                return;
            }
            let url = format!("ws://{}:{}/ws", self.inner.dev.host, self.inner.dev.port);
            let connected =
                tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&url)).await;
            match connected {
                Ok(Ok((ws, _resp))) => {
                    tracing::info!("设备 {}({}) 已连接", self.inner.dev.id, self.inner.dev.host);
                    backoff = Duration::from_secs(1);
                    self.session(ws, Arc::clone(&cmd_rx)).await;
                }
                Ok(Err(e)) => {
                    tracing::info!(
                        "设备 {}({}) 连接失败: {}",
                        self.inner.dev.id,
                        self.inner.dev.host,
                        e
                    );
                }
                Err(_) => {
                    tracing::info!(
                        "设备 {}({}) 连接超时",
                        self.inner.dev.id,
                        self.inner.dev.host
                    );
                }
            }
            if self.inner.stopped.load(Ordering::Relaxed) {
                return;
            }
            self.set_offline("设备连接断开");
            // 退避:1s×2^n ±20% jitter,cap 30s
            let jitter = 0.8 + (simple_rand() % 40) as f64 / 100.0;
            let wait = backoff.mul_f64(jitter);
            tracing::info!("设备 {} 将在 {:.1?} 后重连", self.inner.dev.id, wait);
            tokio::time::sleep(wait).await;
            backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
        }
    }

    /// 单次连接会话:reader + writer + watchdog。命令通道经 Arc 共享给本会话 writer。
    async fn session(
        &self,
        ws: WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        cmd_rx: Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<DeviceCommand>>>,
    ) {
        let (sink, mut stream) = ws.split();
        let sink = Arc::new(tokio::sync::Mutex::new(sink));

        // 清空断连期间积压的陈旧命令(在置 online **之前**——此后到达的新命令安全):
        // 陈旧 Open 重放会在远端打开无人对账的端口;陈旧 Write 积压重连后突发打到
        // 串口设备(对 AT 类设备是数据污染)。置 online 前发送方(open/write/set_alias
        // 的 online 检查)全部拒绝,无误删窗口。
        {
            let mut rx = cmd_rx.lock().await;
            let dropped = rx.try_recv().is_ok();
            while rx.try_recv().is_ok() {}
            if dropped {
                tracing::info!("设备 {} 丢弃断连期间积压的陈旧命令", self.inner.dev.id);
            }
        }

        // 上线:广播 + 拉初始端口列表。
        // 自连(把本机地址注册为远程设备)是合法形态——透传深度限 1(list 合并只收
        // 远端自己的口)保证列表恒为"本地 N + 镜像 N"不增殖;open 镜像口路由回本机
        // manager,即本地口的远程视图,占有权语义照常(附加到同一端口)。
        self.inner.online.store(true, Ordering::Relaxed);
        let _ = self.device_bus.send(DeviceEvent::Online {
            dev_id: self.inner.dev.id.clone(),
        });
        let _ = self.meta_bus.send(());
        if let Err(e) = sink_send_json(&sink, &ClientMsg::List).await {
            tracing::warn!("设备 {} 发送 list 失败: {}", self.inner.dev.id, e);
        }

        // writer:命令通道 → JSON → sink(独立任务,发送超时视为断连经 oneshot 通知主循环)
        let (writer_dead_tx, mut writer_dead_rx) = tokio::sync::oneshot::channel::<()>();
        let writer = tokio::spawn({
            let sink = Arc::clone(&sink);
            let inner = Arc::clone(&self.inner);
            let cmd_rx = cmd_rx;
            async move {
                loop {
                    // 锁内等消息:单 writer 消费,锁无竞争;会话切换时旧 writer 被
                    // abort(await 点安全释放锁),新 writer 接管同一通道
                    let cmd = cmd_rx.lock().await.recv().await;
                    match cmd {
                        Some(cmd) => {
                            if let Err(e) = handle_command(&sink, &inner, cmd).await {
                                tracing::warn!("设备 {} 发送命令失败: {}", inner.dev.id, e);
                                let _ = writer_dead_tx.send(());
                                return;
                            }
                        }
                        None => return, // manager 侧 drop(进程关闭)
                    }
                }
            }
        });

        let mut ping_tick = tokio::time::interval(PING_INTERVAL);
        ping_tick.tick().await; // interval 首个 tick 立即完成,跳过
        let mut last_inbound = tokio::time::Instant::now();

        loop {
            tokio::select! {
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            last_inbound = tokio::time::Instant::now();
                            self.handle_server_text(&text);
                        }
                        Some(Ok(Message::Binary(bin))) => {
                            last_inbound = tokio::time::Instant::now();
                            self.handle_data_frame(&bin);
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                            last_inbound = tokio::time::Instant::now(); // 协议层应答由 tungstenite 自动处理
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
                _ = ping_tick.tick() => {
                    // 协议层探活(客户端可发真 Ping,不受浏览器限制)。
                    // 发送必须包超时:半开连接下 TCP 缓冲满会让 send 永久 pending,
                    // select 分支 handler 阻塞 = 整个会话(含看门狗)停摆。
                    if last_inbound.elapsed() > DEAD_AFTER {
                        tracing::warn!(
                            "设备 {} 心跳超时({:?} 无入站),断开重连",
                            self.inner.dev.id, last_inbound.elapsed()
                        );
                        break;
                    }
                    let ping = async { sink.lock().await.send(Message::Ping(Vec::new())).await };
                    match tokio::time::timeout(SEND_TIMEOUT, ping).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            tracing::warn!("设备 {} 发送 Ping 失败: {}", self.inner.dev.id, e);
                            break;
                        }
                        Err(_) => {
                            tracing::warn!("设备 {} 发送 Ping 超时(半开?),断开重连", self.inner.dev.id);
                            break;
                        }
                    }
                }
                _ = &mut writer_dead_rx => {
                    tracing::warn!("设备 {} 写通道死亡,断开重连", self.inner.dev.id);
                    break;
                }
                _ = self.inner.session_stop.notified() => {
                    // stop()(断开/删除/重连设备):取消活跃会话——WS 随 sink/stream
                    // drop 关闭,远端 release_all 释放占有,run 循环见 stopped 退出
                    tracing::info!("设备 {} 会话被主动停止", self.inner.dev.id);
                    break;
                }
            }
        }

        // 会话结束:停 writer(set_offline 由 run 统一做,此处只等 writer 退出)
        writer.abort();
        let _ = writer.await;
    }

    /// 远端文本消息:Ports 刷缓存;Acquired/Ok/Error 路由在途回执;事件触发 invalidate。
    fn handle_server_text(&self, text: &str) {
        let msg: ServerMsg = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                let head: String = text.chars().take(120).collect();
                tracing::warn!("设备 {} 消息解析失败: {} ({})", self.inner.dev.id, e, head);
                return;
            }
        };
        match msg {
            ServerMsg::Ports { ports } => {
                // 缓存 diff:**变了才**通知本地。这是防自连回授环的关键——
                // 本地 meta_bus 会把 MetaChanged 推给所有连接(含自连的这条),
                // 若无条件扇出,自连时 MetaChanged→重拉→Ports→再扇出→…消息风暴。
                // diff 后:未变化的重复 Ports 静默,变更传播一轮即收敛。
                let mut cached = self.inner.cached_ports.lock().unwrap();
                if *cached != ports {
                    *cached = ports;
                    drop(cached);
                    let _ = self.meta_bus.send(());
                }
            }
            ServerMsg::Acquired { port, .. } => self.route_result(&port, Ok(())),
            ServerMsg::Ok {
                port: Some(port), ..
            } => {
                self.route_write(&port, Ok(()));
                self.route_result(&port, Ok(()));
            }
            ServerMsg::Error { message, port } => {
                // open/write/set_alias 失败都走 Error;有 port 路由,无 port 只留痕
                if let Some(port) = port {
                    self.route_write(
                        &port,
                        Err(io::Error::new(io::ErrorKind::Other, message.clone())),
                    );
                    self.route_result(&port, Err(message));
                } else {
                    tracing::warn!("设备 {} 错误: {}", self.inner.dev.id, message);
                }
            }
            // 远端事件(端口状态/元数据变更)→ 重拉列表:**不直接扇出本地 meta_bus**
            // (自连时同样形成回授环)。重拉结果经 Ports 分支 diff,真变了才通知。
            ServerMsg::Opened { .. }
            | ServerMsg::Closed { .. }
            | ServerMsg::Disconnected { .. }
            | ServerMsg::Holders { .. }
            | ServerMsg::MetaChanged { .. }
            | ServerMsg::ScriptsChanged { .. } => {
                let _ = self.inner.cmd_tx.send(DeviceCommand::RefreshList);
            }
            _ => {}
        }
    }

    /// 远端数据帧:按线名分发到在用端口(Weak upgrade,失效条目顺带清理)。
    fn handle_data_frame(&self, bin: &[u8]) {
        let Some((port, data)) = parse_data_frame(bin) else {
            return;
        };
        let mut ports = self.inner.ports.lock().unwrap();
        if let Some(idx) = ports.iter().position(|(p, _)| p == port) {
            if let Some(io) = ports[idx].1.upgrade() {
                io.push(data);
            } else {
                ports.remove(idx); // 句柄已释放,清登记
            }
        }
    }

    fn route_result(&self, port: &str, result: Result<(), String>) {
        let mut pending = self.inner.pending.lock().unwrap();
        if let Some(idx) = pending
            .iter()
            .position(|p| matches!(p, PendingReply::Result { port: q, .. } if q == port))
        {
            if let PendingReply::Result { reply, .. } = pending.remove(idx) {
                let _ = reply.send(result);
            }
        }
    }

    fn route_write(&self, port: &str, result: io::Result<()>) {
        let mut pending = self.inner.pending.lock().unwrap();
        if let Some(idx) = pending
            .iter()
            .position(|p| matches!(p, PendingReply::Write { port: q, .. } if q == port))
        {
            if let PendingReply::Write { reply, .. } = pending.remove(idx) {
                let _ = reply.send(result);
            }
        }
    }
}

fn drop_pending(inner: &DeviceInner, port: &str) {
    inner.pending.lock().unwrap().retain(|p| match p {
        PendingReply::Result { port: q, .. } | PendingReply::Write { port: q, .. } => q != port,
    });
}

/// writer 里处理一条命令:挂回执(回执由 reader 收到 Acquired/Ok/Error 时路由)+ 发 JSON。
async fn handle_command(
    sink: &Arc<tokio::sync::Mutex<WsSink>>,
    inner: &Arc<DeviceInner>,
    cmd: DeviceCommand,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    match cmd {
        DeviceCommand::Open {
            port,
            config,
            reply,
        } => {
            inner.pending.lock().unwrap().push(PendingReply::Result {
                port: port.clone(),
                reply,
            });
            sink_send_json(sink, &ClientMsg::Open { port, config }).await
        }
        DeviceCommand::Write { port, data, reply } => {
            inner.pending.lock().unwrap().push(PendingReply::Write {
                port: port.clone(),
                reply,
            });
            // JSON 文本不能携带任意字节,二进制走 hex(线上约定,两端同步)
            let msg = ClientMsg::Write {
                port,
                data: hex::encode(&data),
                encoding: "hex".into(),
            };
            sink_send_json(sink, &msg).await
        }
        DeviceCommand::ClosePort { port } => {
            // fire-and-forget:远端 close 幂等;句柄 Drop 触发(读写双句柄会双发,无害)
            sink_send_json(sink, &ClientMsg::Close { port }).await
        }
        DeviceCommand::SetAlias { port, alias, reply } => {
            inner.pending.lock().unwrap().push(PendingReply::Result {
                port: port.clone(),
                reply,
            });
            sink_send_json(sink, &ClientMsg::SetAlias { port, alias }).await
        }
        DeviceCommand::RefreshList => sink_send_json(sink, &ClientMsg::List).await,
    }
}

/// 发送 JSON(5s 超时防背压/半开卡死 writer;超时按 ConnectionClosed 视为断连)。
async fn sink_send_json(
    sink: &Arc<tokio::sync::Mutex<WsSink>>,
    msg: &ClientMsg,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let json = serde_json::to_string(msg).unwrap();
    match tokio::time::timeout(SEND_TIMEOUT, sink.lock().await.send(Message::Text(json))).await {
        Ok(r) => r,
        Err(_) => Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed),
    }
}

/// 轻量伪随机(jitter 用,无需密码学质量;splitmix64)。
fn simple_rand() -> u64 {
    use std::sync::atomic::AtomicU64;
    static CTR: AtomicU64 = AtomicU64::new(0x9E3779B97F4A7C15);
    let mut x = CTR.fetch_add(0x9E3779B97F4A7C15, Ordering::Relaxed);
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D049BB133111EB);
    x ^ (x >> 31)
}

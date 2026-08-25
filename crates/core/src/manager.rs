//! 多串口管理器：HashMap<端口名, PortHandle>。
//!
//! 接入层（server/telnet/tauri）面对的核心接口。
//! 端口按"会话引用计数"共享：acquire 取得份额、release 退份额（末位才拆毁），
//! force_close_others 踢掉非本地持有者(远程 WS)、保留本地;末位或全远程时拆毁端口。
//! 另提供接收缓冲区方法（drain/grep/clear）供 MCP/宏使用。

use crate::error::SerialError;
use crate::event_bus::{EventBus, SerialEvent};
use crate::opener::PortOpener;
use crate::port_task::{self, Disconnect, PhysicalLayer, PortCommand, PortHandle};
use crate::rx_buffer::RxBuffer;
use crate::serial;
use crate::types::{
    normalize_port_key, AcquireResult, PortInfo, ReleaseOutcome, SerialConfig, SessionId,
};
use bytes::Bytes;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;

/// 端口键解析器:把用户输入的键(裸端口名 / 端口别名 / 设备昵称作用域键)
/// 解析为 manager map 键(本机=裸名,远端=`devId::name`)。
/// 别名是 server 层关注点(core 不碰持久化与网络),经此闭包注入——依赖倒置,
/// 同 PortOpener 模式。实现必须纯同步、内存级(热路径 send 每次都过这里)。
pub type KeyResolver = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// 端口实例计数器:每次 Open 单调递增,作为 PortHandle.instance,供 drainer 区分
/// "断开通知是否仍属当前 map 中的实例"(防断开后重开同名端口被误杀)。
static NEXT_PORT_INSTANCE: AtomicU64 = AtomicU64::new(1);

pub struct SerialManager {
    ports: Arc<Mutex<HashMap<String, PortHandle>>>,
    event_bus: Arc<EventBus>,
    opener: Arc<dyn PortOpener>,
    disconnect_tx: mpsc::Sender<Disconnect>,
    /// drainer 接收端:new() 只建不 spawn(此时未必在 tokio runtime),首次 acquire
    /// (必在 runtime 内)时 take 出来 spawn。std::Mutex 短锁取出即可。
    disconnect_rx: std::sync::Mutex<Option<mpsc::Receiver<Disconnect>>>,
    /// 可选键解析器(None = 恒等)。所有端口入口经 canon_key 统一规范化+解析,
    /// 保证 map 键单一形态、占有权单一事实。生产由 server 层注入(见 create_state)。
    key_resolver: Option<KeyResolver>,
}

impl SerialManager {
    pub fn new(event_bus: Arc<EventBus>, opener: Arc<dyn PortOpener>) -> Self {
        let ports = Arc::new(Mutex::new(HashMap::<String, PortHandle>::new()));
        let (disconnect_tx, disconnect_rx) = mpsc::channel::<Disconnect>(32);
        Self {
            ports,
            event_bus,
            opener,
            disconnect_tx,
            disconnect_rx: std::sync::Mutex::new(Some(disconnect_rx)),
            key_resolver: None,
        }
    }

    /// 带键解析器构造(生产组装点)。resolver 在 normalize 之后调用:
    /// 输入已完成遗留 `local::` 剥除,含 `::` 的完整键与裸名都交给它甄别
    /// (设备昵称重写 / 端口别名反查),解析失败时实现应原样透传(下游 NotOpen 兜底)。
    pub fn with_key_resolver(
        event_bus: Arc<EventBus>,
        opener: Arc<dyn PortOpener>,
        key_resolver: KeyResolver,
    ) -> Self {
        let ports = Arc::new(Mutex::new(HashMap::<String, PortHandle>::new()));
        let (disconnect_tx, disconnect_rx) = mpsc::channel::<Disconnect>(32);
        Self {
            ports,
            event_bus,
            opener,
            disconnect_tx,
            disconnect_rx: std::sync::Mutex::new(Some(disconnect_rx)),
            key_resolver: Some(key_resolver),
        }
    }

    /// 键规范化唯一入口:normalize(剥遗留 local::)+ 可选别名解析。
    /// manager 所有端口入口一律经此,map 键恒为规范形态
    /// (本机=裸名,远端=`devId::name`,级联整体透传)。
    pub fn canon_key(&self, raw: &str) -> String {
        let key = normalize_port_key(raw);
        match &self.key_resolver {
            Some(r) => r(&key),
            None => key,
        }
    }

    /// 首次 acquire 时启动 drainer(此时已在 tokio runtime 内);后续调用 no-op。
    /// 不能在 new() 里 spawn——tauri 启动期调 new() 时未必有 reactor,会 panic。
    /// drainer:端口读线程检测到设备断开(try_send 通知)时,单所有权 remove + 发 PortDisconnected。
    /// 仅当 map 中该端口仍是触发断开的实例时才处理——区分主动关闭(已先 remove,get 不到→no-op)
    /// 与断开后重开同名新实例(instance 不符→不误杀)。
    fn maybe_spawn_drainer(&self) {
        if let Some(mut rx) = self.disconnect_rx.lock().unwrap().take() {
            let ports = Arc::clone(&self.ports);
            let bus = Arc::clone(&self.event_bus);
            tokio::spawn(async move {
                while let Some(d) = rx.recv().await {
                    let disconnected = {
                        let mut ports = ports.lock().await;
                        if ports.get(&d.port).map(|h| h.instance) == Some(d.instance) {
                            // 标 disconnected + 丢弃物理层(读线程已退);holders/config/rx_buffer 保留,等 reopen
                            let handle = ports.get_mut(&d.port).unwrap();
                            handle.disconnected = true;
                            if let Some(p) = handle.physical.take() {
                                p.abort_handle.abort(); // 显式 abort(防御:任务可能卡在 write 的 spawn_blocking)
                            }
                            true
                        } else {
                            false
                        }
                    };
                    if disconnected {
                        bus.publish(SerialEvent::PortDisconnected { port: d.port });
                    }
                }
            });
        }
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    /// 列出系统串口，附加本管理器的 opened 状态与持有者数。
    /// 端口名为裸名(本机端口键即裸名),与 map 键同一形态——远端设备的端口由
    /// server 层的设备客户端另行合并(见 snapshot_open_states)。
    pub async fn list_ports(&self) -> Vec<PortInfo> {
        let names = serial::list_port_names();
        let ports = self.ports.lock().await;
        names
            .into_iter()
            .map(|name| {
                let handle = ports.get(&name);
                PortInfo {
                    opened: handle.is_some(),
                    holders: handle.map(|h| h.holders.len()).unwrap_or(0),
                    disconnected: handle.map(|h| h.disconnected).unwrap_or(false),
                    name,
                }
            })
            .collect()
    }

    /// 已占有端口的运行时快照(键含远端复合键,本机枚举之外的条目)。
    /// server 层合并远端设备端口列表时,用本地占有权覆盖远端缓存——
    /// opened/holders/disconnected 以本地为唯一真相(远端 WS 断后其缓存是陈旧的)。
    pub async fn snapshot_open_states(&self) -> Vec<PortInfo> {
        self.ports
            .lock()
            .await
            .iter()
            .map(|(name, h)| PortInfo {
                name: name.clone(),
                opened: true,
                holders: h.holders.len(),
                disconnected: h.disconnected,
            })
            .collect()
    }

    /// 当前已打开的端口名列表。
    pub async fn list_open_ports(&self) -> Vec<String> {
        // 排除 disconnected(占有权在但物理断、不可操作):telnet 列表 / mcp resolve_port
        // 只该列当前可用的已开端口,断开的不应被自动选/连
        self.ports
            .lock()
            .await
            .iter()
            .filter(|(_, h)| !h.disconnected)
            .map(|(p, _)| p.clone())
            .collect()
    }

    /// 占有端口份额：首个持有者真正打开，后续持有者附加（忽略其 config）。
    /// 并发安全：慢路径打开后做 TOCTOU 重检，避免泄漏句柄与相互覆盖。
    /// 端口键入口规范化(裸名补 `local::`),map 键恒为复合键单一形态。
    pub async fn acquire(
        &self,
        port: String,
        config: SerialConfig,
        session: SessionId,
    ) -> Result<AcquireResult, SerialError> {
        let port = self.canon_key(&port);
        self.maybe_spawn_drainer(); // 首次 acquire 启动 drainer(new() 不能 spawn:无 reactor 会 panic)

        // 锁内判定三分支 + 附加(HashSet 幂等,同 session 重复 acquire 不重复计数):
        //   Attach — 端口已占有且连接中 → 附加,返回当前配置
        //   Reopen — 端口已占有但设备断开(disconnected) → 重建物理层,复用占有权(holders 不动)
        //   Open   — 端口未占有 → 真正打开
        enum Action {
            Attach {
                config: SerialConfig,
                holders: usize,
            },
            Reopen,
            Open,
        }
        let action = {
            let mut ports = self.ports.lock().await;
            if let Some(handle) = ports.get_mut(&port) {
                if handle.disconnected {
                    // Reopen:不提前 insert(设备没插回时 opener 会失败,提前 insert 会留 phantom holder);
                    // 推迟到 phase 2 opener 成功后再 insert(与 Open 路径对齐)
                    Action::Reopen
                } else {
                    let was_new = handle.holders.insert(session);
                    let holders = handle.holders.len();
                    if was_new {
                        self.event_bus.publish(SerialEvent::HoldersChanged {
                            port: port.clone(),
                            holders,
                        });
                    }
                    Action::Attach {
                        config: handle.config.clone(),
                        holders,
                    }
                }
            } else {
                Action::Open
            }
        };
        let is_open = matches!(action, Action::Open);
        if let Action::Attach { config, holders } = action {
            return Ok(AcquireResult::Attached { config, holders });
        }

        // Open / Reopen 共用:锁外 spawn_blocking 打开(不持锁做 I/O)
        let opened = {
            let opener = Arc::clone(&self.opener);
            let port_name = port.clone();
            let cfg = config.clone();
            tokio::task::spawn_blocking(move || opener.open(&port_name, &cfg))
                .await
                .map_err(|e| SerialError::OpenFailed {
                    port: port.clone(),
                    message: format!("join 错误: {}", e),
                })??
        };

        // 锁内 TOCTOU 装回(Open 插新 / Reopen 复用逻辑层重建物理层;并发赢家则丢弃句柄转 attach)
        let result = {
            let mut ports = self.ports.lock().await;
            if let Some(handle) = ports.get_mut(&port) {
                if handle.disconnected {
                    // Reopen:复用逻辑层,重建物理层;此时才 insert 本 session(phase 1 未提前 insert,避 phantom)
                    let was_new = handle.holders.insert(session);
                    let holders = handle.holders.len();
                    let rx_buf_clone = Arc::clone(&handle.rx_buffer);
                    let (command_tx, command_rx) = mpsc::channel(32);
                    let event_bus = Arc::clone(&self.event_bus);
                    let task_name = port.clone();
                    let disconnect_tx_task = self.disconnect_tx.clone();
                    let new_instance = NEXT_PORT_INSTANCE.fetch_add(1, Ordering::Relaxed);
                    let quit = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let quit_for_task = Arc::clone(&quit);
                    let join_handle = tokio::spawn(async move {
                        port_task::run(
                            task_name,
                            opened,
                            quit_for_task,
                            command_rx,
                            event_bus,
                            rx_buf_clone,
                            disconnect_tx_task,
                            new_instance,
                        )
                        .await;
                    });
                    let abort_handle = join_handle.abort_handle();
                    handle.config = config.clone();
                    handle.instance = new_instance;
                    handle.disconnected = false;
                    handle.physical = Some(PhysicalLayer {
                        join_handle,
                        abort_handle,
                        command_tx,
                        quit,
                    });
                    if was_new {
                        self.event_bus.publish(SerialEvent::HoldersChanged {
                            port: port.clone(),
                            holders,
                        });
                    }
                    AcquireResult::Opened { config, holders }
                } else {
                    // 并发赢家已 open/reopen:丢弃刚开的句柄,转 attach(insert 本 session)
                    drop(opened);
                    let was_new = handle.holders.insert(session);
                    let holders = handle.holders.len();
                    if was_new {
                        self.event_bus.publish(SerialEvent::HoldersChanged {
                            port: port.clone(),
                            holders,
                        });
                    }
                    AcquireResult::Attached {
                        config: handle.config.clone(),
                        holders,
                    }
                }
            } else if is_open {
                // Open:构造新 PortHandle
                let rx_buffer = Arc::new(RxBuffer::new());
                let (command_tx, command_rx) = mpsc::channel(32);
                let event_bus = Arc::clone(&self.event_bus);
                let rx_buf_clone = Arc::clone(&rx_buffer);
                let task_name = port.clone();
                let disconnect_tx_task = self.disconnect_tx.clone();
                let instance = NEXT_PORT_INSTANCE.fetch_add(1, Ordering::Relaxed);
                let quit = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let quit_for_task = Arc::clone(&quit);
                let join_handle = tokio::spawn(async move {
                    port_task::run(
                        task_name,
                        opened,
                        quit_for_task,
                        command_rx,
                        event_bus,
                        rx_buf_clone,
                        disconnect_tx_task,
                        instance,
                    )
                    .await;
                });
                let abort_handle = join_handle.abort_handle();
                ports.insert(
                    port.clone(),
                    PortHandle {
                        holders: HashSet::from([session]),
                        config: config.clone(),
                        rx_buffer,
                        instance,
                        disconnected: false,
                        physical: Some(PhysicalLayer {
                            join_handle,
                            abort_handle,
                            command_tx,
                            quit,
                        }),
                    },
                );
                AcquireResult::Opened { config, holders: 1 }
            } else {
                // Reopen 但端口已被末位 release 删除:丢弃句柄
                drop(opened);
                return Err(SerialError::NotOpen(port.clone()));
            }
        };
        // Opened(open 首开 / reopen 重连)→ 发 PortOpened(前端据此清断开红标)
        if matches!(result, AcquireResult::Opened { .. }) {
            self.event_bus
                .publish(SerialEvent::PortOpened { port: port.clone() });
        }
        Ok(result)
    }

    /// 释放本会话的持有份额：非末位端口保持（发 HoldersChanged），末位才拆毁。
    pub async fn release(
        &self,
        port: &str,
        session: SessionId,
    ) -> Result<ReleaseOutcome, SerialError> {
        let key = self.canon_key(port);
        let port = key.as_str();
        // 锁内：判定效果；末位则取出 handle 以便锁外拆毁
        let (outcome, mut teardown_handle) = {
            let mut ports = self.ports.lock().await;
            let handle = ports
                .get_mut(port)
                .ok_or_else(|| SerialError::NotOpen(port.to_string()))?;
            if !handle.holders.remove(&session) {
                return Ok(ReleaseOutcome::NotHeld);
            }
            if handle.holders.is_empty() {
                (ReleaseOutcome::Closed, ports.remove(port))
            } else {
                (
                    ReleaseOutcome::Released {
                        remaining: handle.holders.len(),
                    },
                    None,
                )
            }
        };
        // 锁外：发布事件 + 拆毁
        match &outcome {
            ReleaseOutcome::Released { remaining } => {
                self.event_bus.publish(SerialEvent::HoldersChanged {
                    port: port.to_string(),
                    holders: *remaining,
                });
            }
            ReleaseOutcome::Closed => {
                if let Some(handle) = teardown_handle.take() {
                    Self::teardown(handle).await;
                }
                self.event_bus.publish(SerialEvent::PortClosed {
                    port: port.to_string(),
                });
            }
            ReleaseOutcome::NotHeld => {}
        }
        Ok(outcome)
    }

    /// 释放某会话持有的全部端口（断连/关窗清理）。仅末位口才拆毁。
    pub async fn release_all(&self, session: SessionId) -> Vec<(String, ReleaseOutcome)> {
        let held: Vec<String> = {
            let ports = self.ports.lock().await;
            ports
                .iter()
                .filter_map(|(p, h)| {
                    if h.holders.contains(&session) {
                        Some(p.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };
        let mut results = Vec::with_capacity(held.len());
        for port in held {
            // release 仅在并发被拆时返回 NotOpen（端口已不在），忽略即可
            if let Ok(outcome) = self.release(&port, session).await {
                results.push((port, outcome));
            }
        }
        results
    }

    /// 踢掉非本地持有者(远程 WS 客户端),保留 `keep`(本地窗口)。用于"强制关闭"
    /// 按钮只关远程、不关本地。踢完后若仍有本地持有者,端口保持(发 HoldersChanged);
    /// 全踢完则拆毁(发 PortClosed);无远程可踢则 no-op。返回剩余本地持有者数。
    pub async fn force_close_others(
        &self,
        port: &str,
        keep: &HashSet<SessionId>,
    ) -> Result<Vec<SessionId>, SerialError> {
        let key = self.canon_key(port);
        let port = key.as_str();
        let (before, remaining, kicked, teardown) = {
            let mut ports = self.ports.lock().await;
            let handle = ports
                .get_mut(port)
                .ok_or_else(|| SerialError::NotOpen(port.to_string()))?;
            let before = handle.holders.len();
            // 收集被踢的 session(retain 前非 keep 的),用于发 Kicked 通知 WS 断开连接
            let kicked: Vec<SessionId> = handle
                .holders
                .iter()
                .filter(|s| !keep.contains(s))
                .copied()
                .collect();
            handle.holders.retain(|s| keep.contains(s));
            let remaining = handle.holders.len();
            let teardown = if remaining == 0 {
                ports.remove(port)
            } else {
                None
            };
            (before, remaining, kicked, teardown)
        };
        if let Some(handle) = teardown {
            Self::teardown(handle).await;
            self.event_bus.publish(SerialEvent::PortClosed {
                port: port.to_string(),
            });
        } else if remaining < before {
            self.event_bus.publish(SerialEvent::HoldersChanged {
                port: port.to_string(),
                holders: remaining,
            });
        }
        Ok(kicked)
    }

    /// 端口的当前持有者数量（给 UI/status 用）。
    pub async fn holder_count(&self, port: &str) -> Option<usize> {
        let key = self.canon_key(port);
        self.ports
            .lock()
            .await
            .get(key.as_str())
            .map(|h| h.holders.len())
    }

    /// 拆毁端口任务：发 Close → 置 quit → abort → join。release 末位与 force_close_others 共用。
    /// quit 必须在 abort **前**置位:Close 2s 超时(慢写阻塞时)会走 abort,被 abort 的
    /// run() 跳过收尾置位——不预置则读线程永循环、句柄永不 Drop(远端口 ClosePort
    /// 发不出=远端泄漏;本地口 OS 句柄不释放)。
    async fn teardown(handle: PortHandle) {
        // 仅连接中(physical=Some)需停 port_task;disconnected 时物理层已 None,drop handle 即可
        if let Some(physical) = handle.physical {
            let (tx, rx) = oneshot::channel();
            let _ = physical.command_tx.send(PortCommand::Close(tx)).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
            physical.quit.store(true, Ordering::Relaxed); // abort 路径的读线程退出保障
            physical.abort_handle.abort();
            let _ = tokio::time::timeout(Duration::from_secs(5), physical.join_handle).await;
        }
    }

    /// 写入数据。
    pub async fn write(&self, port: String, data: Bytes) -> Result<usize, SerialError> {
        let port = self.canon_key(&port);
        let command_tx = {
            let ports = self.ports.lock().await;
            let handle = ports
                .get(&port)
                .ok_or_else(|| SerialError::NotOpen(port.clone()))?;
            if handle.disconnected {
                return Err(SerialError::Disconnected(port));
            }
            handle
                .physical
                .as_ref()
                .expect("connected 必有物理层")
                .command_tx
                .clone()
        };

        let (tx, rx) = oneshot::channel();
        command_tx
            .send(PortCommand::Write(data, tx))
            .await
            .map_err(|_| SerialError::NotOpen(port.clone()))?;

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SerialError::WriteFailed("写响应通道关闭".into())),
            Err(_) => Err(SerialError::WriteFailed("写超时".into())),
        }
    }

    /// 端口是否已打开。
    pub async fn is_open(&self, port: &str) -> bool {
        let key = self.canon_key(port);
        self.ports.lock().await.contains_key(key.as_str())
    }

    /// 端口是否处于设备断开态(占有权在、物理层已释放,等 reopen)。
    pub async fn is_disconnected(&self, port: &str) -> bool {
        let key = self.canon_key(port);
        self.ports
            .lock()
            .await
            .get(key.as_str())
            .map(|h| h.disconnected)
            .unwrap_or(false)
    }

    // ===== 接收缓冲区方法（MCP / 宏用）=====

    async fn get_rx_buffer(&self, port: &str) -> Result<Arc<RxBuffer>, SerialError> {
        let key = self.canon_key(port);
        let ports = self.ports.lock().await;
        ports
            .get(key.as_str())
            .map(|h| Arc::clone(&h.rx_buffer))
            .ok_or_else(|| SerialError::NotOpen(port.to_string()))
    }

    /// 返回端口配置（status 用）。
    pub async fn status(&self, port: &str) -> Option<SerialConfig> {
        let key = self.canon_key(port);
        self.ports
            .lock()
            .await
            .get(key.as_str())
            .map(|h| h.config.clone())
    }

    /// 端口的换行设置（send 用）。
    pub async fn port_line_ending(&self, port: &str) -> Option<crate::types::LineEnding> {
        let key = self.canon_key(port);
        self.ports
            .lock()
            .await
            .get(key.as_str())
            .map(|h| h.config.line_ending)
    }

    /// 高层发送：text/hex 编码 + 按端口 line_ending 追加换行 + write。
    /// 宏与 MCP 共用此入口，换行逻辑集中在此（透传的 WS/Telnet 不经过这里）。
    pub async fn send(
        &self,
        port: &str,
        data: &str,
        format: &str,
        auto_newline: bool,
    ) -> Result<usize, SerialError> {
        let line_ending = self
            .port_line_ending(port)
            .await
            .ok_or_else(|| SerialError::NotOpen(port.to_string()))?;
        let bytes = crate::macros::encode_send(data, format, auto_newline, line_ending)
            .map_err(SerialError::WriteFailed)?;
        if bytes.is_empty() {
            return Ok(0);
        }
        self.write(port.to_string(), Bytes::from(bytes)).await
    }

    /// 破坏性读取缓冲区（空时按 timeout 等待）。
    pub async fn drain_buffer(&self, port: &str, timeout_ms: u64) -> Result<Vec<u8>, SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        Ok(tokio::task::spawn_blocking(move || buf.drain(timeout_ms))
            .await
            .unwrap_or_default())
    }

    /// 破坏性读取缓冲区（带静默期，命令-响应场景用）。
    pub async fn drain_buffer_quiet(
        &self,
        port: &str,
        deadline_ms: u64,
        idle_ms: u64,
    ) -> Result<Vec<u8>, SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        Ok(
            tokio::task::spawn_blocking(move || buf.drain_quiet(deadline_ms, idle_ms))
                .await
                .unwrap_or_default(),
        )
    }

    /// 清空缓冲区。
    pub async fn clear_buffer(&self, port: &str) -> Result<(), SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        let _ = tokio::task::spawn_blocking(move || buf.clear()).await;
        Ok(())
    }

    /// 正则匹配缓冲区文本行（非破坏）。
    pub async fn grep_buffer(
        &self,
        port: &str,
        pattern: &str,
        timeout_ms: u64,
    ) -> Result<Vec<String>, SerialError> {
        let re =
            regex::Regex::new(pattern).map_err(|e| SerialError::InvalidConfig(e.to_string()))?;
        let buf = self.get_rx_buffer(port).await?;
        Ok(
            tokio::task::spawn_blocking(move || buf.grep_text(&re, timeout_ms))
                .await
                .unwrap_or_default(),
        )
    }

    /// 字节序列匹配缓冲区（非破坏）。
    pub async fn grep_buffer_bytes(
        &self,
        port: &str,
        pattern: Vec<u8>,
        timeout_ms: u64,
    ) -> Result<Vec<(usize, Vec<u8>)>, SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        Ok(
            tokio::task::spawn_blocking(move || buf.grep_bytes(&pattern, timeout_ms))
                .await
                .unwrap_or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    //! 占有权逻辑单测：注入 FakeOpener（返回内存桩串口），不碰真实硬件。
    //! 桩串口的 read 立即返回非超时错误 → port_task 读循环自行退出，避免阻塞测试运行时。

    use super::*;
    use crate::port_io::PortIo;
    use crate::types::{DataBits, FlowControl, LineEnding, Parity, StopBits};
    use std::io::{self, Read, Write};
    use std::time::Duration;

    /// 内存桩串口。disconnect=false:read 返 TimedOut(空闲,读循环 continue,端口保持开);
    /// disconnect=true:read 返非 timeout 错误(模拟设备拔出 → 读循环走断开路径)。
    struct FakePort {
        disconnect: bool,
    }

    impl Read for FakePort {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            if self.disconnect {
                Err(io::Error::new(io::ErrorKind::Other, "device removed"))
            } else {
                Err(io::Error::from(io::ErrorKind::TimedOut))
            }
        }
    }
    impl Write for FakePort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl PortIo for FakePort {
        fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
            Ok(Box::new(FakePort {
                disconnect: self.disconnect,
            }))
        }
    }

    struct FakeOpener;
    impl PortOpener for FakeOpener {
        fn open(
            &self,
            _port: &str,
            _config: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, SerialError> {
            Ok(Box::new(FakePort { disconnect: false }))
        }
    }

    /// 慢 opener：open 时 sleep，强制并发 acquire 同时停在慢路径，确定性触发 TOCTOU 重检。
    struct SlowFakeOpener;
    impl PortOpener for SlowFakeOpener {
        fn open(
            &self,
            _port: &str,
            _config: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, SerialError> {
            std::thread::sleep(Duration::from_millis(50));
            Ok(Box::new(FakePort { disconnect: false }))
        }
    }

    /// 回环桩:write 写入的字节可从 read 读回(读写共享同一队列,验证 PortIo
    /// 读写分离语义——try_clone 的两个句柄见同一底层流)。空读返 TimedOut。
    struct LoopbackPort {
        q: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u8>>>,
    }
    impl Read for LoopbackPort {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut q = self.q.lock().unwrap();
            if q.is_empty() {
                return Err(io::Error::from(io::ErrorKind::TimedOut));
            }
            let n = buf.len().min(q.len());
            for slot in buf.iter_mut().take(n) {
                *slot = q.pop_front().unwrap();
            }
            Ok(n)
        }
    }
    impl Write for LoopbackPort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.q.lock().unwrap().extend(buf.iter().copied());
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl PortIo for LoopbackPort {
        fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
            Ok(Box::new(LoopbackPort {
                q: std::sync::Arc::clone(&self.q),
            }))
        }
    }
    struct LoopbackOpener;
    impl PortOpener for LoopbackOpener {
        fn open(
            &self,
            _port: &str,
            _config: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, SerialError> {
            Ok(Box::new(LoopbackPort {
                q: std::sync::Arc::default(),
            }))
        }
    }

    /// PortIo 端到端:write 经命令通道进 PortIo → 读循环拉取 → RxBuffer → drain 读回。
    /// 证明窄 trait 上的读写分离 + RxBuffer 管道成立(远端 backend 复用同一路径)。
    #[tokio::test]
    async fn loopback_port_io_end_to_end() {
        let m = SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(LoopbackOpener));
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        let n = m
            .write("COM7".into(), bytes::Bytes::from_static(b"hello"))
            .await
            .unwrap();
        assert_eq!(n, 5);
        // 读循环节奏 5ms/批,给一点余量
        let data = m.drain_buffer("COM7", 2000).await.unwrap();
        assert_eq!(data, b"hello".to_vec(), "回环数据应经 RxBuffer 流回");
        let _ = m.release_all(s).await;
    }

    /// 裸名与遗留 `local::` 前缀指向同一端口条目:入口规范化剥前缀保证 map 单一形态,
    /// 老客户端写法不会与裸名引用分裂成两个条目(占有权单一事实)。
    #[tokio::test]
    async fn bare_name_and_composite_key_are_same_entry() {
        let m = mgr();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap(); // 裸名进
        assert!(m.is_open("COM7").await, "裸名查询应命中");
        assert!(
            m.is_open("local::COM7").await,
            "遗留 local:: 前缀查询应命中同一条目"
        );
        assert_eq!(m.holder_count("local::COM7").await, Some(1));
        let res = m.release("COM7", s).await.unwrap(); // 裸名释放
        assert!(matches!(res, ReleaseOutcome::Closed));
        assert!(!m.is_open("local::COM7").await);
    }

    fn mgr() -> SerialManager {
        SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(FakeOpener))
    }

    fn cfg(baud: u32) -> SerialConfig {
        SerialConfig {
            baud_rate: baud,
            data_bits: DataBits::Eight,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            line_ending: LineEnding::LF,
            timeout_ms: 100,
        }
    }

    #[tokio::test]
    async fn acquire_first_opens() {
        let m = mgr();
        let s = SessionId::next();
        let res = m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        assert!(matches!(res, AcquireResult::Opened { .. }));
        assert_eq!(m.holder_count("COM7").await, Some(1));
        assert!(m.is_open("COM7").await);
        let _ = m.release_all(s).await; // 退出读线程,免 runtime drop 等 spawn_blocking 挂死
    }

    #[tokio::test]
    async fn acquire_second_attaches_and_ignores_config() {
        let m = mgr();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        let res = m.acquire("COM7".into(), cfg(9600), s2).await.unwrap();
        match res {
            AcquireResult::Attached { config, holders } => {
                assert_eq!(holders, 2);
                assert_eq!(config.baud_rate, 115200, "请求的 9600 应被忽略");
            }
            other => panic!("期望 Attached，得到 {:?}", other),
        }
        assert_eq!(m.holder_count("COM7").await, Some(2));
        let _ = m.release_all(s1).await;
        let _ = m.release_all(s2).await;
    }

    #[tokio::test]
    async fn acquire_attach_publishes_holders_changed() {
        let m = mgr();
        let mut rx = m.event_bus().subscribe();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s2).await.unwrap();
        // 附加应发布 HoldersChanged{holders:2}
        let mut found = false;
        let deadline = std::time::Instant::now() + Duration::from_millis(200);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(SerialEvent::HoldersChanged { port, holders }) => {
                    assert_eq!(
                        port, "COM7",
                        "事件端口应为 map 键(本机=裸名)"
                    );
                    assert_eq!(holders, 2);
                    found = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        assert!(found, "附加成功应发布 HoldersChanged");
        let _ = m.release_all(s1).await;
        let _ = m.release_all(s2).await;
    }

    #[tokio::test]
    async fn acquire_same_session_idempotent() {
        let m = mgr();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        assert_eq!(
            m.holder_count("COM7").await,
            Some(1),
            "重复 acquire 不应重复计数"
        );
        let _ = m.release_all(s).await;
    }

    #[tokio::test]
    async fn release_non_last_keeps_open() {
        let m = mgr();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s2).await.unwrap();
        let out = m.release("COM7", s1).await.unwrap();
        assert!(matches!(out, ReleaseOutcome::Released { remaining: 1 }));
        assert_eq!(m.holder_count("COM7").await, Some(1));
        assert!(m.is_open("COM7").await);
        let _ = m.release_all(s2).await; // s2 仍持有,清掉以退出读线程
    }

    #[tokio::test]
    async fn release_last_closes() {
        let m = mgr();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        let out = m.release("COM7", s).await.unwrap();
        assert!(matches!(out, ReleaseOutcome::Closed));
        assert_eq!(m.holder_count("COM7").await, None);
        assert!(!m.is_open("COM7").await);
    }

    #[tokio::test]
    async fn release_not_held_is_idempotent() {
        let m = mgr();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        let out = m.release("COM7", s2).await.unwrap();
        assert!(matches!(out, ReleaseOutcome::NotHeld));
        assert_eq!(
            m.holder_count("COM7").await,
            Some(1),
            "旁观者 release 不影响端口"
        );
        let _ = m.release_all(s1).await; // s1 仍持有,清掉以退出读线程
    }

    #[tokio::test]
    async fn release_not_open_errors() {
        let m = mgr();
        let s = SessionId::next();
        let err = m.release("COM7", s).await.unwrap_err();
        assert!(matches!(err, SerialError::NotOpen(_)));
    }

    #[tokio::test]
    async fn release_all_clears_session_holds() {
        let m = mgr();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        m.acquire("COM3".into(), cfg(115200), s1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s2).await.unwrap();
        let results = m.release_all(s1).await;
        assert_eq!(results.len(), 2, "s1 持有 COM7、COM3");
        assert!(!m.is_open("COM3").await, "COM3 仅 s1 → 已关");
        assert_eq!(m.holder_count("COM7").await, Some(1), "COM7 还有 s2 → 保持");
        let _ = m.release_all(s2).await; // s2 仍持有 COM7,清掉以退出读线程
    }

    #[tokio::test]
    async fn force_close_others_not_open_errors() {
        let m = mgr();
        let err = m
            .force_close_others("COM7", &HashSet::new())
            .await
            .unwrap_err();
        assert!(matches!(err, SerialError::NotOpen(_)));
    }

    #[tokio::test]
    async fn force_close_others_keeps_local_kicks_remote() {
        let m = mgr();
        let local = SessionId::next();
        let remote1 = SessionId::next();
        let remote2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), local).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), remote1)
            .await
            .unwrap();
        m.acquire("COM7".into(), cfg(115200), remote2)
            .await
            .unwrap();
        let keep = HashSet::from([local]);
        let kicked = m.force_close_others("COM7", &keep).await.unwrap();
        assert_eq!(kicked.len(), 2, "踢掉 2 个远程");
        assert_eq!(m.holder_count("COM7").await, Some(1));
        assert!(m.is_open("COM7").await, "本地还在,端口应保持");
        let _ = m.release_all(local).await; // local 仍持有,清掉以退出读线程
    }

    #[tokio::test]
    async fn force_close_others_all_remote_teardown() {
        let m = mgr();
        let remote1 = SessionId::next();
        let remote2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), remote1)
            .await
            .unwrap();
        m.acquire("COM7".into(), cfg(115200), remote2)
            .await
            .unwrap();
        let keep = HashSet::new(); // 无本地持有者
        let kicked = m.force_close_others("COM7", &keep).await.unwrap();
        assert_eq!(kicked.len(), 2);
        assert!(!m.is_open("COM7").await, "全远程,踢完应拆毁");
    }

    #[tokio::test]
    async fn concurrent_acquire_one_opens_one_attaches_no_leak() {
        // 慢 opener 强制两路 acquire 同时进入慢路径，确定性触发 TOCTOU 重检分支
        let m = SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(SlowFakeOpener));
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        let (r1, r2) = tokio::join!(
            m.acquire("COM7".into(), cfg(115200), s1),
            m.acquire("COM7".into(), cfg(115200), s2),
        );
        let (r1, r2) = (r1.unwrap(), r2.unwrap());
        // 恰好一个 Opened、一个 Attached
        let n_opened = [
            matches!(r1, AcquireResult::Opened { .. }),
            matches!(r2, AcquireResult::Opened { .. }),
        ]
        .iter()
        .filter(|&&x| x)
        .count();
        assert_eq!(n_opened, 1, "应有且仅有一个 Opened（另一为 Attached）");
        assert_eq!(m.holder_count("COM7").await, Some(2));
        // 关键：端口任务只有一个（旧 open 的并发竞态会泄漏/覆盖 handle）
        assert_eq!(
            m.list_open_ports().await.len(),
            1,
            "并发 acquire 不应产生重复端口任务"
        );
        let _ = m.release_all(s1).await;
        let _ = m.release_all(s2).await;
    }

    /// 断开型 opener:每次 open 返回 disconnect=true 桩(模拟设备一上电就被拔)。
    struct DisconnectingOpener;
    impl PortOpener for DisconnectingOpener {
        fn open(
            &self,
            _port: &str,
            _config: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, SerialError> {
            Ok(Box::new(FakePort { disconnect: true }))
        }
    }

    /// 可重连 opener:首次 open 返 disconnect=true(模拟拔),之后 disconnect=false(插回稳定)。
    /// 用于测 reopen(首次断 → 重连恢复物理层,复用占有权)。
    #[derive(Default)]
    struct ReopeningOpener(std::sync::atomic::AtomicUsize);
    impl PortOpener for ReopeningOpener {
        fn open(
            &self,
            _port: &str,
            _config: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, SerialError> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Box::new(FakePort { disconnect: n == 0 }))
        }
    }

    /// reopen 失败 opener:首次 open 返 disconnect=true(断),之后 open 返 Err(设备没插回)。
    /// 用于测 M1:reopen 失败不留 phantom holder。
    #[derive(Default)]
    struct FailingReopenOpener(std::sync::atomic::AtomicUsize);
    impl PortOpener for FailingReopenOpener {
        fn open(&self, port: &str, _config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n == 0 {
                Ok(Box::new(FakePort { disconnect: true }))
            } else {
                Err(SerialError::OpenFailed {
                    port: port.into(),
                    message: "设备未插回".into(),
                })
            }
        }
    }

    #[tokio::test]
    async fn disconnect_marks_but_keeps_holders() {
        let m = SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(DisconnectingOpener));
        let mut rx = m.event_bus().subscribe();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        // 读线程立即返错 → try_send 通知 drainer → 标 disconnected + publish PortDisconnected(保留 holder)
        let mut got = false;
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(SerialEvent::PortDisconnected { port }) => {
                    assert_eq!(port, "COM7", "事件端口应为 map 键(本机=裸名)");
                    got = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        assert!(got, "设备断开应发布 PortDisconnected");
        // 占有权保留:端口仍在 map、holders 不清(等 reopen 复用)
        assert!(m.is_open("COM7").await, "断开后端口仍在 map(占有权保留)");
        assert_eq!(m.holder_count("COM7").await, Some(1), "holders 保留");
        let _ = m.release_all(s).await; // 清理读线程
    }

    #[tokio::test]
    async fn reopen_after_disconnect() {
        let m = SerialManager::new(
            Arc::new(EventBus::new(16)),
            Arc::new(ReopeningOpener::default()),
        );
        let mut rx = m.event_bus().subscribe();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        // 等首次断开(PortDisconnected)
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if matches!(rx.try_recv(), Ok(SerialEvent::PortDisconnected { .. })) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(m.is_open("COM7").await, "断开后占有权保留(端口在 map)");
        assert_eq!(m.holder_count("COM7").await, Some(1));
        // reopen(后续 opener 返 disconnect=false):复用 holder、重建物理层 → Opened
        let res = m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        assert!(
            matches!(res, AcquireResult::Opened { .. }),
            "reopen 应返回 Opened(物理层重建)"
        );
        assert_eq!(
            m.holder_count("COM7").await,
            Some(1),
            "reopen 后 holder 复用(仍是 1)"
        );
        let _ = m.release_all(s).await;
    }

    #[tokio::test]
    async fn close_after_reopen_non_last() {
        // 根治验证:两 session 共享端口 → 断开(两端 holder 保留)→ reopen(其一)→ 关其一 = 非末位
        let m = SerialManager::new(
            Arc::new(EventBus::new(16)),
            Arc::new(ReopeningOpener::default()),
        );
        let mut rx = m.event_bus().subscribe();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s2).await.unwrap();
        // 等首次断开(PortDisconnected)
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if matches!(rx.try_recv(), Ok(SerialEvent::PortDisconnected { .. })) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            m.holder_count("COM7").await,
            Some(2),
            "断开后两端 holder 都保留"
        );
        // reopen(s1):物理层重建(复用两端 holder)
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap();
        // 关 s1:非末位(s2 仍持有)→ Released,端口保持(不 PortClosed 波及 s2)
        let out = m.release("COM7", s1).await.unwrap();
        assert!(
            matches!(out, ReleaseOutcome::Released { remaining: 1 }),
            "关其一应非末位(根治:不波及另一端)"
        );
        assert!(m.is_open("COM7").await, "s2 仍持有,端口保持");
        assert_eq!(m.holder_count("COM7").await, Some(1));
        let _ = m.release("COM7", s2).await; // 清理读线程
    }

    #[tokio::test]
    async fn reopen_failure_leaves_no_phantom_holder() {
        // M1:reopen 失败(设备没插回)→ session 不应留 phantom holder
        let m = SerialManager::new(
            Arc::new(EventBus::new(16)),
            Arc::new(FailingReopenOpener::default()),
        );
        let mut rx = m.event_bus().subscribe();
        let s1 = SessionId::next();
        let s2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s1).await.unwrap(); // 首次(n=0,断)
                                                                  // 等断开
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if matches!(rx.try_recv(), Ok(SerialEvent::PortDisconnected { .. })) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            m.holder_count("COM7").await,
            Some(1),
            "断开后 s1 holder 保留"
        );
        // s2 尝试 reopen(设备没插回 → open 失败)
        let res = m.acquire("COM7".into(), cfg(115200), s2).await;
        assert!(res.is_err(), "reopen 失败(设备未插回)应返 Err");
        // M1 核心:s2 未留 phantom holder,holders 仍是 s1(1)
        assert_eq!(
            m.holder_count("COM7").await,
            Some(1),
            "reopen 失败不留 phantom holder"
        );
        // s1 仍能正常 release(末位 → 拆除)
        let out = m.release("COM7", s1).await.unwrap();
        assert!(matches!(out, ReleaseOutcome::Closed));
    }

    #[tokio::test]
    async fn write_disconnected_returns_error() {
        // 断开态 write → SerialError::Disconnected(区别于 NotOpen)
        let m = SerialManager::new(Arc::new(EventBus::new(16)), Arc::new(DisconnectingOpener));
        let mut rx = m.event_bus().subscribe();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        // 等断开
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if matches!(rx.try_recv(), Ok(SerialEvent::PortDisconnected { .. })) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let res = m.write("COM7".into(), Bytes::from_static(b"AT")).await;
        assert!(
            matches!(res, Err(SerialError::Disconnected(_))),
            "断开态 write 返 Disconnected"
        );
        let _ = m.release_all(s).await;
    }

    /// 注入 KeyResolver 后,裸别名经 canon_key 解析到真实键:acquire 落到解析后
    /// 条目、事件携带 map 键(本机=裸名),别名写法不产生第二个条目。
    #[tokio::test]
    async fn resolver_resolves_alias_to_map_key() {
        // 桩 resolver:"GPS" → "COM7";其余原样透传
        let resolver: KeyResolver = Arc::new(|k: &str| {
            if k == "GPS" {
                "COM7".to_string()
            } else {
                k.to_string()
            }
        });
        let m = SerialManager::with_key_resolver(
            Arc::new(EventBus::new(16)),
            Arc::new(FakeOpener),
            resolver,
        );
        let mut rx = m.event_bus().subscribe();
        let s = SessionId::next();
        assert_eq!(m.canon_key("GPS"), "COM7", "别名应被解析");
        m.acquire("GPS".into(), cfg(115200), s).await.unwrap();
        // 解析后的真实键命中;别名写法同样命中同一条目
        assert!(m.is_open("COM7").await);
        assert!(m.is_open("GPS").await, "再次用别名访问应指向同一条目");
        // 事件端口 = map 键(裸名),而非用户输入的别名
        let mut saw_opened = false;
        let deadline = std::time::Instant::now() + Duration::from_millis(200);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(SerialEvent::PortOpened { port }) => {
                    assert_eq!(port, "COM7", "事件端口应为解析后的 map 键");
                    saw_opened = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        assert!(saw_opened, "应收到 PortOpened 事件");
        let _ = m.release_all(s).await;
    }

    /// 无 resolver(new)时 canon_key = normalize:遗留前缀剥除、其余透传。
    #[test]
    fn canon_without_resolver_is_identity_after_normalize() {
        let m = mgr();
        assert_eq!(m.canon_key("COM7"), "COM7");
        assert_eq!(m.canon_key("local::COM7"), "COM7");
        assert_eq!(m.canon_key("uuid1::uuid2::COM3"), "uuid1::uuid2::COM3");
    }
}

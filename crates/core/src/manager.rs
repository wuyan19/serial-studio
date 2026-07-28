//! 多串口管理器：HashMap<端口名, PortHandle>。
//!
//! 接入层（server/telnet/tauri）面对的核心接口。
//! 端口按"会话引用计数"共享：acquire 取得份额、release 退份额（末位才拆毁），
//! force_close_others 踢掉非本地持有者(远程 WS)、保留本地;末位或全远程时拆毁端口。
//! 另提供接收缓冲区方法（drain/grep/clear）供 MCP/宏使用。

use crate::error::SerialError;
use crate::event_bus::{EventBus, SerialEvent};
use crate::opener::PortOpener;
use crate::port_task::{self, PortCommand, PortHandle};
use crate::rx_buffer::RxBuffer;
use crate::serial;
use crate::types::{AcquireResult, PortInfo, ReleaseOutcome, SerialConfig, SessionId};
use bytes::Bytes;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;

pub struct SerialManager {
    ports: Mutex<HashMap<String, PortHandle>>,
    event_bus: Arc<EventBus>,
    opener: Arc<dyn PortOpener>,
}

impl SerialManager {
    pub fn new(event_bus: Arc<EventBus>, opener: Arc<dyn PortOpener>) -> Self {
        Self {
            ports: Mutex::new(HashMap::new()),
            event_bus,
            opener,
        }
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    /// 列出系统串口，附加本管理器的 opened 状态与持有者数。
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
                    name,
                }
            })
            .collect()
    }

    /// 当前已打开的端口名列表。
    pub async fn list_open_ports(&self) -> Vec<String> {
        self.ports.lock().await.keys().cloned().collect()
    }

    /// 占有端口份额：首个持有者真正打开，后续持有者附加（忽略其 config）。
    /// 并发安全：慢路径打开后做 TOCTOU 重检，避免泄漏句柄与相互覆盖。
    pub async fn acquire(
        &self,
        port: String,
        config: SerialConfig,
        session: SessionId,
    ) -> Result<AcquireResult, SerialError> {
        // 快路径：已开 → 附加（HashSet 幂等，同 session 重复 acquire 不重复计数）
        let attached = {
            let mut ports = self.ports.lock().await;
            if let Some(handle) = ports.get_mut(&port) {
                let was_new = handle.holders.insert(session);
                let holders = handle.holders.len();
                Some((handle.config.clone(), holders, was_new))
            } else {
                None
            }
        };
        if let Some((config, holders, was_new)) = attached {
            if was_new {
                self.event_bus
                    .publish(SerialEvent::HoldersChanged { port: port.clone(), holders });
            }
            return Ok(AcquireResult::Attached { config, holders });
        }

        // 慢路径：真打开（锁外 spawn_blocking，不持锁做 I/O）
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

        // TOCTOU 重检 + 构造 handle（锁内仅做 map 操作；spawn 不阻塞）
        let attach_on_lose: Option<(SerialConfig, usize, bool)> = {
            let mut ports = self.ports.lock().await;
            if let Some(handle) = ports.get_mut(&port) {
                // 并发赢家：丢弃刚开的 OS 句柄，转为附加（否则泄漏）
                drop(opened);
                let was_new = handle.holders.insert(session);
                let holders = handle.holders.len();
                Some((handle.config.clone(), holders, was_new))
            } else {
                let rx_buffer = Arc::new(RxBuffer::new());
                let (command_tx, command_rx) = mpsc::channel(32);
                let event_bus = Arc::clone(&self.event_bus);
                let rx_buf_clone = Arc::clone(&rx_buffer);
                let task_name = port.clone();
                let join_handle = tokio::spawn(async move {
                    port_task::run(task_name, opened, command_rx, event_bus, rx_buf_clone).await;
                });
                let abort_handle = join_handle.abort_handle();
                ports.insert(
                    port.clone(),
                    PortHandle {
                        join_handle,
                        abort_handle,
                        command_tx,
                        rx_buffer,
                        config: config.clone(),
                        holders: HashSet::from([session]),
                    },
                );
                None
            }
        };
        if let Some((cfg, holders, was_new)) = attach_on_lose {
            if was_new {
                self.event_bus
                    .publish(SerialEvent::HoldersChanged { port: port.clone(), holders });
            }
            return Ok(AcquireResult::Attached { config: cfg, holders });
        }

        self.event_bus
            .publish(SerialEvent::PortOpened { port: port.clone() });
        Ok(AcquireResult::Opened { config })
    }

    /// 释放本会话的持有份额：非末位端口保持（发 HoldersChanged），末位才拆毁。
    pub async fn release(
        &self,
        port: &str,
        session: SessionId,
    ) -> Result<ReleaseOutcome, SerialError> {
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
                (ReleaseOutcome::Released { remaining: handle.holders.len() }, None)
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
                self.event_bus
                    .publish(SerialEvent::PortClosed { port: port.to_string() });
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
        let (before, remaining, kicked, teardown) = {
            let mut ports = self.ports.lock().await;
            let handle = ports
                .get_mut(port)
                .ok_or_else(|| SerialError::NotOpen(port.to_string()))?;
            let before = handle.holders.len();
            // 收集被踢的 session(retain 前非 keep 的),用于发 Kicked 通知 WS 断开连接
            let kicked: Vec<SessionId> =
                handle.holders.iter().filter(|s| !keep.contains(s)).copied().collect();
            handle.holders.retain(|s| keep.contains(s));
            let remaining = handle.holders.len();
            let teardown = if remaining == 0 { ports.remove(port) } else { None };
            (before, remaining, kicked, teardown)
        };
        if let Some(handle) = teardown {
            Self::teardown(handle).await;
            self.event_bus
                .publish(SerialEvent::PortClosed { port: port.to_string() });
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
        self.ports.lock().await.get(port).map(|h| h.holders.len())
    }

    /// 拆毁端口任务：发 Close → abort → join。release 末位与 force_close_others 共用。
    async fn teardown(handle: PortHandle) {
        let (tx, rx) = oneshot::channel();
        let _ = handle.command_tx.send(PortCommand::Close(tx)).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
        handle.abort_handle.abort();
        let _ = tokio::time::timeout(Duration::from_secs(5), handle.join_handle).await;
    }

    /// 写入数据。
    pub async fn write(&self, port: String, data: Bytes) -> Result<usize, SerialError> {
        let command_tx = {
            let ports = self.ports.lock().await;
            ports
                .get(&port)
                .ok_or_else(|| SerialError::NotOpen(port.clone()))?
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
        self.ports.lock().await.contains_key(port)
    }

    // ===== 接收缓冲区方法（MCP / 宏用）=====

    async fn get_rx_buffer(&self, port: &str) -> Result<Arc<RxBuffer>, SerialError> {
        let ports = self.ports.lock().await;
        ports
            .get(port)
            .map(|h| Arc::clone(&h.rx_buffer))
            .ok_or_else(|| SerialError::NotOpen(port.to_string()))
    }

    /// 返回端口配置（status 用）。
    pub async fn status(&self, port: &str) -> Option<SerialConfig> {
        self.ports.lock().await.get(port).map(|h| h.config.clone())
    }

    /// 端口的换行设置（send 用）。
    pub async fn port_line_ending(&self, port: &str) -> Option<crate::types::LineEnding> {
        self.ports.lock().await.get(port).map(|h| h.config.line_ending)
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
        let re = regex::Regex::new(pattern).map_err(|e| SerialError::InvalidConfig(e.to_string()))?;
        let buf = self.get_rx_buffer(port).await?;
        Ok(tokio::task::spawn_blocking(move || buf.grep_text(&re, timeout_ms))
            .await
            .unwrap_or_default())
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
    use crate::types::{DataBits, FlowControl, LineEnding, Parity, StopBits};
    use std::io::{self, Read, Write};
    use std::time::Duration;

    /// 内存桩串口：read 返回非超时错误使读循环自退；write 丢弃。
    struct FakePort;

    impl Read for FakePort {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::Other, "fake port"))
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
    impl serialport::SerialPort for FakePort {
        fn name(&self) -> Option<String> { None }
        fn baud_rate(&self) -> Result<u32, serialport::Error> { Ok(0) }
        fn data_bits(&self) -> Result<serialport::DataBits, serialport::Error> { Ok(serialport::DataBits::Eight) }
        fn flow_control(&self) -> Result<serialport::FlowControl, serialport::Error> { Ok(serialport::FlowControl::None) }
        fn parity(&self) -> Result<serialport::Parity, serialport::Error> { Ok(serialport::Parity::None) }
        fn stop_bits(&self) -> Result<serialport::StopBits, serialport::Error> { Ok(serialport::StopBits::One) }
        fn timeout(&self) -> Duration { Duration::from_millis(100) }
        fn set_baud_rate(&mut self, _: u32) -> Result<(), serialport::Error> { Ok(()) }
        fn set_data_bits(&mut self, _: serialport::DataBits) -> Result<(), serialport::Error> { Ok(()) }
        fn set_flow_control(&mut self, _: serialport::FlowControl) -> Result<(), serialport::Error> { Ok(()) }
        fn set_parity(&mut self, _: serialport::Parity) -> Result<(), serialport::Error> { Ok(()) }
        fn set_stop_bits(&mut self, _: serialport::StopBits) -> Result<(), serialport::Error> { Ok(()) }
        fn set_timeout(&mut self, _: Duration) -> Result<(), serialport::Error> { Ok(()) }
        fn write_request_to_send(&mut self, _: bool) -> Result<(), serialport::Error> { Ok(()) }
        fn write_data_terminal_ready(&mut self, _: bool) -> Result<(), serialport::Error> { Ok(()) }
        fn read_clear_to_send(&mut self) -> Result<bool, serialport::Error> { Ok(false) }
        fn read_data_set_ready(&mut self) -> Result<bool, serialport::Error> { Ok(false) }
        fn read_ring_indicator(&mut self) -> Result<bool, serialport::Error> { Ok(false) }
        fn read_carrier_detect(&mut self) -> Result<bool, serialport::Error> { Ok(false) }
        fn bytes_to_read(&self) -> Result<u32, serialport::Error> { Ok(0) }
        fn bytes_to_write(&self) -> Result<u32, serialport::Error> { Ok(0) }
        fn clear(&self, _: serialport::ClearBuffer) -> Result<(), serialport::Error> { Ok(()) }
        fn clear_break(&self) -> Result<(), serialport::Error> { Ok(()) }
        fn set_break(&self) -> Result<(), serialport::Error> { Ok(()) }
        fn try_clone(&self) -> Result<Box<dyn serialport::SerialPort>, serialport::Error> {
            Ok(Box::new(FakePort))
        }
    }

    struct FakeOpener;
    impl PortOpener for FakeOpener {
        fn open(&self, _port: &str, _config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, SerialError> {
            Ok(Box::new(FakePort))
        }
    }

    /// 慢 opener：open 时 sleep，强制并发 acquire 同时停在慢路径，确定性触发 TOCTOU 重检。
    struct SlowFakeOpener;
    impl PortOpener for SlowFakeOpener {
        fn open(&self, _port: &str, _config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, SerialError> {
            std::thread::sleep(Duration::from_millis(50));
            Ok(Box::new(FakePort))
        }
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
                    assert_eq!(port, "COM7");
                    assert_eq!(holders, 2);
                    found = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        assert!(found, "附加成功应发布 HoldersChanged");
    }

    #[tokio::test]
    async fn acquire_same_session_idempotent() {
        let m = mgr();
        let s = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), s).await.unwrap();
        assert_eq!(m.holder_count("COM7").await, Some(1), "重复 acquire 不应重复计数");
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
        assert_eq!(m.holder_count("COM7").await, Some(1), "旁观者 release 不影响端口");
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
    }

    #[tokio::test]
    async fn force_close_others_not_open_errors() {
        let m = mgr();
        let err = m.force_close_others("COM7", &HashSet::new()).await.unwrap_err();
        assert!(matches!(err, SerialError::NotOpen(_)));
    }

    #[tokio::test]
    async fn force_close_others_keeps_local_kicks_remote() {
        let m = mgr();
        let local = SessionId::next();
        let remote1 = SessionId::next();
        let remote2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), local).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), remote1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), remote2).await.unwrap();
        let keep = HashSet::from([local]);
        let kicked = m.force_close_others("COM7", &keep).await.unwrap();
        assert_eq!(kicked.len(), 2, "踢掉 2 个远程");
        assert_eq!(m.holder_count("COM7").await, Some(1));
        assert!(m.is_open("COM7").await, "本地还在,端口应保持");
    }

    #[tokio::test]
    async fn force_close_others_all_remote_teardown() {
        let m = mgr();
        let remote1 = SessionId::next();
        let remote2 = SessionId::next();
        m.acquire("COM7".into(), cfg(115200), remote1).await.unwrap();
        m.acquire("COM7".into(), cfg(115200), remote2).await.unwrap();
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
        let n_opened = [matches!(r1, AcquireResult::Opened { .. }), matches!(r2, AcquireResult::Opened { .. })]
            .iter()
            .filter(|&&x| x)
            .count();
        assert_eq!(n_opened, 1, "应有且仅有一个 Opened（另一为 Attached）");
        assert_eq!(m.holder_count("COM7").await, Some(2));
        // 关键：端口任务只有一个（旧 open 的并发竞态会泄漏/覆盖 handle）
        assert_eq!(m.list_open_ports().await.len(), 1, "并发 acquire 不应产生重复端口任务");
    }
}

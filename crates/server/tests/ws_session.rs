//! WS 接入层会话生命周期集成测试。
//!
//! 起内存 server（注入 FakeOpener，不碰真实串口），用真实 WS 客户端验证：
//! - open → `acquired` 回复（首开 opened=true / 附加 opened=false + holders）
//! - close → 末位才真关
//! - 客户端断连 → release_all → 持有者归零（不泄漏）
//!
//! 这套测试覆盖的正是适配层把 SessionId 串到 acquire/release/release_all 的 wiring，
//! 也是先前两次 bug（广播加标签 / 附加不发 HoldersChanged）的发源地。

use futures_util::{SinkExt, StreamExt};
use ss_core::{EventBus, PortOpener, SerialConfig, SerialError, SerialManager};
use ss_server::{create_router, AppState};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

/// connect_async 返回的流类型（MaybeTlsStream 包裹）。
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ===== 内存桩串口（与 core 单测同款：read 返 TimedOut 模拟空闲,保持端口连接态） =====

struct FakePort;
impl std::io::Read for FakePort {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        // 空闲:模拟无数据(读循环 continue,端口保持开)——返非 timeout 错误会触发设备断开
        // (drainer 标 disconnected),破坏本测试"附加"所依赖的连接态。
        Err(std::io::Error::from(std::io::ErrorKind::TimedOut))
    }
}
impl std::io::Write for FakePort {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
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

/// 起内存 server，返回 (ws_url, manager) 供测试驱动。
async fn boot() -> (String, Arc<SerialManager>) {
    let event_bus = Arc::new(EventBus::new(64));
    let manager = Arc::new(SerialManager::new(event_bus.clone(), Arc::new(FakeOpener)));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };
    let app = create_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("ws://{}/ws", addr), manager)
}

/// 读直到出现包含 needle 的文本消息（2s 超时，防卡死）。
async fn recv_until(ws: &mut Ws, needle: &str) -> String {
    let found = async {
        while let Some(msg) = ws.next().await {
            if let Ok(Message::Text(t)) = msg {
                if t.contains(needle) {
                    return t;
                }
            }
        }
        panic!("连接关闭，未收到包含 {:?} 的消息", needle);
    };
    timeout(Duration::from_secs(2), found)
        .await
        .unwrap_or_else(|_| panic!("等待包含 {:?} 的消息超时", needle))
}

async fn send_text(ws: &mut Ws, json: &str) {
    ws.send(Message::Text(json.into())).await.unwrap();
}

#[tokio::test]
async fn open_returns_acquired_and_attach_shows_holders() {
    let (url, _mgr) = boot().await;

    // 客户端 A：首开 → acquired(opened=true)
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut a, r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#).await;
    let acquired = recv_until(&mut a, "\"type\":\"acquired\"").await;
    assert!(acquired.contains("\"opened\":true"), "首开应为 opened=true: {}", acquired);

    // 客户端 B：附加 → acquired(opened=false, holders=2)
    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut b, r#"{"action":"open","port":"COM7","config":{"baud_rate":9600}}"#).await;
    let attached = recv_until(&mut b, "\"type\":\"acquired\"").await;
    assert!(attached.contains("\"opened\":false"), "第二客户端应附加: {}", attached);
    assert!(attached.contains("\"holders\":2"), "附加应显示 2 持有者: {}", attached);
    // 清理:close 两客户端(末位 teardown 退出读线程,免 runtime drop 卡在 spawn_blocking)
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    send_text(&mut b, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;
}

#[tokio::test]
async fn disconnect_releases_holders_no_leak() {
    let (url, manager) = boot().await;

    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut a, r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"acquired\"").await;

    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut b, r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#).await;
    let _ = recv_until(&mut b, "\"type\":\"acquired\"").await;
    assert_eq!(manager.holder_count("COM7").await, Some(2));

    // B 直接断连（不调 close）→ 服务端 release_all(B) → 持有者回到 1
    drop(b);
    // 轮询等待服务端清理（断连处理异步）
    let mut ok = false;
    for _ in 0..40 {
        if manager.holder_count("COM7").await == Some(1) {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ok, "B 断连后持有者应回到 1（release_all 生效，不泄漏）");
    // 清理:a close(末位 teardown 退出读线程)
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;
}

#[tokio::test]
async fn last_close_tears_down_port() {
    let (url, manager) = boot().await;

    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut a, r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"acquired\"").await;

    // A close → 末位 → 端口拆毁
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;

    let mut ok = false;
    for _ in 0..40 {
        if manager.holder_count("COM7").await.is_none() {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ok, "末位 close 应拆毁端口（holder_count → None）");
}

#[tokio::test]
async fn version_action_returns_server_version() {
    // 远程/Web 关于页通过此动作取版本。服务端回 CARGO_PKG_VERSION，
    // 与桌面端 Tauri getVersion() 共用 workspace 版本号（当前同为 0.1.0）。
    let (url, _mgr) = boot().await;
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(&mut a, r#"{"action":"version"}"#).await;
    let resp = recv_until(&mut a, "\"type\":\"version\"").await;
    let want = format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION"));
    assert!(resp.contains(&want), "期望包含 {}，实际: {}", want, resp);
}

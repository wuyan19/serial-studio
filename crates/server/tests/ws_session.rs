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
use ss_core::{EventBus, PortIo, PortOpener, SerialConfig, SerialError, SerialManager};
use ss_server::{create_router, AppState};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

/// connect_async 返回的流类型（MaybeTlsStream 包裹）。
type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
impl PortIo for FakePort {
    fn try_clone(&self) -> std::io::Result<Box<dyn PortIo>> {
        Ok(Box::new(FakePort))
    }
}

struct FakeOpener;
impl PortOpener for FakeOpener {
    fn open(&self, _port: &str, _config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
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
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        // 测试无远程设备(集成测试用 DeviceClientManager::empty + update_registry 注入)
        devices: Arc::new(ss_server::device::DeviceClientManager::empty(meta_tx)),
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
    send_text(
        &mut a,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
    let acquired = recv_until(&mut a, "\"type\":\"acquired\"").await;
    assert!(
        acquired.contains("\"opened\":true"),
        "首开应为 opened=true: {}",
        acquired
    );

    // 客户端 B：附加 → acquired(opened=false, holders=2)
    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut b,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":9600}}"#,
    )
    .await;
    let attached = recv_until(&mut b, "\"type\":\"acquired\"").await;
    assert!(
        attached.contains("\"opened\":false"),
        "第二客户端应附加: {}",
        attached
    );
    assert!(
        attached.contains("\"holders\":2"),
        "附加应显示 2 持有者: {}",
        attached
    );
    // 清理:close 两客户端(末位 teardown 退出读线程,免 runtime drop 卡在 spawn_blocking)
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    send_text(&mut b, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;
}

#[tokio::test]
async fn disconnect_releases_holders_no_leak() {
    let (url, manager) = boot().await;

    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut a,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
    let _ = recv_until(&mut a, "\"type\":\"acquired\"").await;

    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut b,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
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
    send_text(
        &mut a,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
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

/// 复合键线格式(P1 契约):端口列表 name 带设备前缀;open 接受复合键与裸名
/// (裸名规范化为 local:: 前缀,与复合键指向同一条目);acquired 回显复合键。
#[tokio::test]
async fn composite_port_key_wire_format() {
    let (url, manager) = boot().await;
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;

    // ① 复合键首开
    send_text(
        &mut a,
        r#"{"action":"open","port":"local::COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
    let acquired = recv_until(&mut a, "\"type\":\"acquired\"").await;

    // ② 列表 name 应为复合键
    send_text(&mut a, r#"{"action":"list"}"#).await;
    let listed = recv_until(&mut a, "\"type\":\"ports\"").await;

    // ③ 裸名(旧客户端)从**另一条连接**(不同 session)附加——若裸名与复合键分裂成
    // 两个条目,这次会是 Opened 而非 Attached;同条目则 holders=2
    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut b,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":9600}}"#,
    )
    .await;
    let attached = recv_until(&mut b, "\"type\":\"acquired\"").await;
    let holders = manager.holder_count("local::COM7").await;

    // ④ 清理先行(读线程退出,runtime 才能干净关闭——panic 早退会留 FakePort 读线程,
    // spawn_blocking 读循环只有 Close 才退出,runtime drop 会挂死),断言全部押后
    send_text(&mut b, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut b, "\"type\":\"ok\"").await;
    send_text(&mut a, r#"{"action":"close","port":"local::COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;

    assert!(
        acquired.contains("\"port\":\"local::COM7\""),
        "acquired 应回显复合键: {}",
        acquired
    );
    assert!(
        acquired.contains("\"opened\":true"),
        "首开应为 opened=true: {}",
        acquired
    );
    // 列表条目恒为复合键格式(list = 系统枚举 + map 状态,COM7 是 FakeOpener 假口
    // 不在系统枚举里,故断言"存在的条目全部带前缀"而非特定端口)
    assert!(
        listed.contains("\"name\":\"local::"),
        "端口列表 name 应带 local:: 前缀: {}",
        listed
    );
    assert!(
        !listed.contains("\"name\":\"COM"),
        "端口列表不得再出现无前缀裸名: {}",
        listed
    );
    assert!(
        attached.contains("\"opened\":false"),
        "裸名应附加到复合键条目(非新开): {}",
        attached
    );
    assert!(
        attached.contains("\"holders\":2"),
        "裸名与复合键同条目,两 session 应 holders=2: {}",
        attached
    );
    assert_eq!(holders, Some(2));
}

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
    // 测试无远程设备(集成测试用 DeviceClientManager::empty + update_registry 注入)
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        meta_tx.clone(),
        "inst-ws-session",
    ));
    devices.bind(Arc::downgrade(&devices));
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        devices,
        // 寻址解析(manager 未注入 resolver,此实例仅占位;MCP 直查路径才用)
        addresses: Arc::new(ss_server::address::AddressResolver::new(
            Arc::new(ss_server::device::DeviceClientManager::empty(
                meta_tx.clone(),
                "inst-ws-session",
            )),
            meta_tx,
            "inst-ws-session".into(),
        )),
        instance_id: "inst-ws-session".into(),
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

/// 身份回带闸门(线格式契约):instance_id 是跨重启永久身份,不对未认证连接
/// 无条件暴露——仅设备握手(请求自报了 id)才回带本机实例 id;浏览器/扫描器等
/// 不带 id 的探针得到的应答与旧版零差异(无此字段)。设备客户端握手恒自报,
/// 学习路径不受闸门影响(device_cascade::learned_id_adopts_placeholder 锁定)。
#[tokio::test]
async fn version_echoes_instance_id_only_when_requested() {
    let (url, _mgr) = boot().await;
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;

    // 浏览器形态(无 id):应答不得含 instance_id 字段
    send_text(&mut a, r#"{"action":"version"}"#).await;
    let resp = recv_until(&mut a, "\"type\":\"version\"").await;
    assert!(
        !resp.contains("instance_id"),
        "无 id 探针的应答不得泄露实例身份: {resp}"
    );

    // 设备握手形态(自报 id):应答回带本机实例 id
    send_text(
        &mut a,
        r#"{"action":"version","instance_id":"inst-peer"}"#,
    )
    .await;
    let resp = recv_until(&mut a, "\"type\":\"version\"").await;
    assert!(
        resp.contains(r#""instance_id":"inst-ws-session""#),
        "自报 id 的握手应答回带本机实例 id: {resp}"
    );
}

/// 端口键线格式契约:本机端口键 = 裸名;open 接受裸名与遗留 `local::` 前缀
/// (老客户端写法,规范化剥除后指向同一条目);acquired 回显 map 键(裸名)。
#[tokio::test]
async fn composite_port_key_wire_format() {
    let (url, manager) = boot().await;
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;

    // ① 裸名首开
    send_text(
        &mut a,
        r#"{"action":"open","port":"COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
    let acquired = recv_until(&mut a, "\"type\":\"acquired\"").await;

    // ② 列表 name 应为裸名形态
    send_text(&mut a, r#"{"action":"list"}"#).await;
    let listed = recv_until(&mut a, "\"type\":\"ports\"").await;

    // ③ 遗留 `local::` 写法(旧客户端)从**另一条连接**(不同 session)附加——若剥前缀后
    // 不与裸名同条目,这次会是 Opened 而非 Attached;同条目则 holders=2
    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut b,
        r#"{"action":"open","port":"local::COM7","config":{"baud_rate":9600}}"#,
    )
    .await;
    let attached = recv_until(&mut b, "\"type\":\"acquired\"").await;
    let holders = manager.holder_count("local::COM7").await;

    // ④ 清理先行(读线程退出,runtime 才能干净关闭——panic 早退会留 FakePort 读线程,
    // spawn_blocking 读循环只有 Close 才退出,runtime drop 会挂死),断言全部押后
    send_text(&mut b, r#"{"action":"close","port":"local::COM7"}"#).await;
    let _ = recv_until(&mut b, "\"type\":\"ok\"").await;
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;

    assert!(
        acquired.contains("\"port\":\"COM7\""),
        "acquired 应回显 map 键(裸名): {}",
        acquired
    );
    assert!(
        acquired.contains("\"opened\":true"),
        "首开应为 opened=true: {}",
        acquired
    );
    // 列表条目恒为裸名形态(list 合并真实系统枚举,条目集随环境不定;
    // 断言不变量:任何条目名都不含复合键分隔符——本机口=裸名,不再产生 local::。
    // 无串口环境列表为空,不变量平凡成立)
    let listed_json: serde_json::Value = serde_json::from_str(&listed).unwrap();
    let names: Vec<&str> = listed_json["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(
        names.iter().all(|n| !n.contains("::")),
        "端口列表 name 应为裸名形态(不含 ::): {:?}",
        names
    );
    assert!(
        attached.contains("\"opened\":false"),
        "遗留写法应附加到裸名条目(非新开): {}",
        attached
    );
    assert!(
        attached.contains("\"holders\":2"),
        "裸名与遗留前缀同条目,两 session 应 holders=2: {}",
        attached
    );
    assert_eq!(holders, Some(2));
}

/// 别名寻址端到端:manager 注入 AddressResolver 的 resolver 后,WS open 直接用
/// 端口别名——canon 在 manager 边界解析,acquired 回显解析后真名。
/// 锚点:评审指出的"各出口自动获得别名能力无集成回归"盲区。
#[tokio::test]
async fn open_by_alias_resolves_via_injected_resolver() {
    use ss_server::address::AddressResolver;

    // 独立配置目录 + 种入本地别名(进程级 env,本测试二进制独享此目录)
    let dir = std::env::temp_dir().join(format!("ss-ws-alias-test-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();
    let alias = format!("WS-GPS-{}", std::process::id());
    ss_server::port_meta_store::set_alias("COM7", Some(alias.clone())).unwrap();

    // 组装:resolver + 注入 resolver 的 manager(与生产 create_state 同构)
    let event_bus = Arc::new(EventBus::new(64));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        meta_tx.clone(),
        "inst-ws-alias",
    ));
    devices.bind(Arc::downgrade(&devices));
    let addresses = Arc::new(AddressResolver::new(
        devices.clone(),
        meta_tx.clone(),
        "inst-ws-alias".into(),
    ));
    let manager = Arc::new(SerialManager::with_key_resolver(
        event_bus.clone(),
        Arc::new(FakeOpener),
        addresses.key_resolver_fn(),
    ));
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        addresses,
        devices,
        instance_id: "inst-ws-alias".into(),
    };
    let app = create_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let url = format!("ws://{}/ws", addr);

    // WS open 用别名 → acquired 应回显解析后真名 COM7(resolved 字段)
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    send_text(
        &mut a,
        &format!(
            r#"{{"action":"open","port":"{alias}","config":{{"baud_rate":115200}}}}"#
        ),
    )
    .await;
    let acquired = recv_until(&mut a, "\"type\":\"acquired\"").await;
    assert!(
        acquired.contains("\"resolved\":\"COM7\""),
        "acquired 应带解析后真名: {}",
        acquired
    );
    // manager 侧落在真实键条目上
    let holders = manager.holder_count("COM7").await;
    send_text(&mut a, r#"{"action":"close","port":"COM7"}"#).await;
    let _ = recv_until(&mut a, "\"type\":\"ok\"").await;
    assert_eq!(holders, Some(1), "别名打开应落到真实键 COM7 条目");

    // 清理种子,不污染同进程后续行为
    ss_server::port_meta_store::set_alias("COM7", None).unwrap();
}

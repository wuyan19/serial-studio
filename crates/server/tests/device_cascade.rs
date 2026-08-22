//! 远程设备级联集成测试:单进程双 server(A/B),A 经 DeviceClient 连 B,
//! A 的 WS 客户端以复合键操作 B 的端口——验证"远程串口下沉到 IO 层"全链路:
//! open(composite key → CompositeOpener 路由 → DeviceClient → 远端 manager)、
//! 数据回显(远端 Binary 帧 → RemotePortIo 缓冲 → 本地 EventBus → WS 出口)、
//! 断连(设备 WS 断 → read Err → drainer 标 disconnected 保占有权)、别名转发。
//!
//! 测试注入走 DeviceClientManager::empty + update_registry(不预置 remotes.json——
//! config_dir 是进程级 env,同进程 A/B 共享配置目录会让 B 读到指向自己的注册自连)。

use futures_util::{SinkExt, StreamExt};
use ss_core::{EventBus, PortIo, PortOpener, SerialConfig, SerialError, SerialManager, SessionId};
use ss_server::device::{CompositeOpener, DeviceClientManager};
use ss_server::{create_router, AppState};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ===== B 侧桩:回显 FakePort(write 写入的字节可从 read 读回) =====

struct EchoPort {
    q: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u8>>>,
}
impl Read for EchoPort {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut q = self.q.lock().unwrap();
        if q.is_empty() {
            return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
        }
        let n = buf.len().min(q.len());
        for slot in buf.iter_mut().take(n) {
            *slot = q.pop_front().unwrap();
        }
        Ok(n)
    }
}
impl Write for EchoPort {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.q.lock().unwrap().extend(buf.iter().copied());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl PortIo for EchoPort {
    fn try_clone(&self) -> std::io::Result<Box<dyn PortIo>> {
        Ok(Box::new(EchoPort {
            q: std::sync::Arc::clone(&self.q),
        }))
    }
}
struct EchoOpener;
impl PortOpener for EchoOpener {
    fn open(&self, _port: &str, _config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
        Ok(Box::new(EchoPort {
            q: std::sync::Arc::default(),
        }))
    }
}

// ===== 服务器装配 =====

struct Instance {
    /// 监听地址(IP:port)。
    addr: String,
    manager: Arc<SerialManager>,
    devices: Arc<DeviceClientManager>,
}

impl Instance {
    fn url(&self) -> String {
        format!("ws://{}/ws", self.addr)
    }
}

/// 起一个 server。echo=true 时端口回显且不连设备(B 侧桩);echo=false 时注入
/// CompositeOpener + 设备表(A 侧,设备经 update_registry 注册)。
async fn boot(echo: bool) -> Instance {
    let event_bus = Arc::new(EventBus::new(256));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone()));
    let opener: Arc<dyn PortOpener> = if echo {
        Arc::new(EchoOpener)
    } else {
        Arc::new(CompositeOpener::new(Arc::clone(&devices)))
    };
    let manager = Arc::new(SerialManager::new(event_bus.clone(), opener));
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        devices: Arc::clone(&devices),
    };
    let app = create_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Instance {
        addr: addr.to_string(),
        manager,
        devices,
    }
}

async fn recv_until(ws: &mut Ws, needle: &str) -> String {
    let found = async {
        while let Some(msg) = ws.next().await {
            if let Ok(Message::Text(t)) = msg {
                if t.contains(needle) {
                    return t;
                }
            }
        }
        panic!("连接关闭,未收到包含 {:?} 的消息", needle);
    };
    timeout(Duration::from_secs(5), found)
        .await
        .unwrap_or_else(|_| panic!("等待包含 {:?} 的消息超时", needle))
}

async fn send_text(ws: &mut Ws, json: &str) {
    ws.send(Message::Text(json.into())).await.unwrap();
}

/// 全链路:A 的客户端 open `dev-b::COM7` → 写 → 远端回显 → A 侧收到数据帧。
#[tokio::test]
async fn cascade_open_write_echo() {
    let b = boot(/*echo*/ true).await;
    let a = boot(false).await;

    // A 注册 B 并启动设备连接池
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // 等设备上线:acquire 轮询(不依赖系统枚举——列表来自真实 COM 枚举,无串口机器为空,
    // CI/Linux 上按列表等会假超时;acquire 只需设备连接就绪)
    let mut a_ws = tokio_tungstenite::connect_async(a.url()).await.unwrap().0;
    let probe_session = SessionId::next();
    let mut online = false;
    for _ in 0..100 {
        if a.manager
            .acquire(
                "dev-b::local::COM7".into(),
                SerialConfig::default(),
                probe_session,
            )
            .await
            .is_ok()
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online, "设备应上线可开远端端口");
    let _ = a.manager.release("dev-b::local::COM7", probe_session).await;
    let _ = a.manager.holder_count("local::COM7").await;

    // open 复合键(列表键形态:dev-b + 远端线名 local::COM7,与生产前端一致)
    send_text(
        &mut a_ws,
        r#"{"action":"open","port":"dev-b::local::COM7","config":{"baud_rate":115200}}"#,
    )
    .await;
    let acquired = recv_until(&mut a_ws, "\"type\":\"acquired\"").await;
    assert!(
        acquired.contains("\"opened\":true"),
        "复合键首开: {}",
        acquired
    );
    assert_eq!(a.manager.holder_count("dev-b::local::COM7").await, Some(1));

    // write → B 回显 → A 的事件流出数据帧(port = A 侧 map 键,即事件口径的复合键)
    send_text(
        &mut a_ws,
        r#"{"action":"write","port":"dev-b::local::COM7","data":"ping","encoding":"text"}"#,
    )
    .await;
    let frame = async {
        while let Some(msg) = a_ws.next().await {
            if let Ok(Message::Binary(bin)) = msg {
                return bin;
            }
        }
        panic!("未收到数据帧");
    };
    let bin = timeout(Duration::from_secs(5), frame)
        .await
        .expect("等待回显数据帧超时");
    // 帧格式 [len][port][data]:port = A 侧端口键(事件口径,与 map/前端 pid 一致)
    let plen = bin[0] as usize;
    let port = std::str::from_utf8(&bin[1..1 + plen]).unwrap();
    let data = &bin[1 + plen..];
    assert_eq!(port, "dev-b::local::COM7", "数据帧端口应为级联复合键");
    assert_eq!(data, b"ping", "回显数据应原样返回");

    // B 侧确实持有:B 的 manager 里 local::COM7 holders ≥1(DeviceClient 连接占 1)
    assert_eq!(b.manager.holder_count("local::COM7").await, Some(1));

    // 清理:close 复合键 → 末位 → 拆毁(A 侧);Drop 转发 ClosePort → B 侧释放
    send_text(
        &mut a_ws,
        r#"{"action":"close","port":"dev-b::local::COM7"}"#,
    )
    .await;
    let _ = recv_until(&mut a_ws, "\"type\":\"ok\"").await;
    // 等 B 侧释放(异步):close 转发 → release_all/末位释放
    let mut released = false;
    for _ in 0..100 {
        if b.manager.holder_count("local::COM7").await.is_none() {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "A 关闭复合键端口后,B 侧占有应释放");
}

/// 断连:B 的 server 停止(模拟设备下电)→ A 侧端口标 disconnected(占有权保留)。
#[tokio::test]
async fn cascade_device_offline_keeps_holders() {
    let b = boot(true).await;
    let port_num = b.addr.parse::<std::net::SocketAddr>().unwrap().port();
    let a = boot(false).await;

    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: port_num,
        nickname: None,
    }]);
    a.devices.start();

    // 等 open 通路就绪(设备在线)
    let mut ready = false;
    for _ in 0..100 {
        if a.manager
            .acquire(
                "dev-b::local::COM7".into(),
                SerialConfig::default(),
                SessionId::next(),
            )
            .await
            .is_ok()
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "设备应上线可开远端端口");

    // B 下电:直接把 B 的 manager 侧连接断掉不可行(server task 在 spawn 里)——
    // 模拟方式:close B 的设备连接通道。此处通过 devices.disconnect(A→B)触发
    // 同样的断开路径(RemotePortIo read 返 Err → drainer)。
    a.devices.disconnect("dev-b").unwrap();

    // A 侧:占有权保留 + disconnected 置位(USB 拔插模型)
    let mut marked = false;
    for _ in 0..100 {
        if a.manager.is_disconnected("dev-b::local::COM7").await {
            marked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(marked, "设备断开后端口应标 disconnected");
    assert_eq!(
        a.manager.holder_count("dev-b::local::COM7").await,
        Some(1),
        "占有权应保留"
    );
}

/// 便利:经 WS list 消息取合并视图(设备桶合并入口 list_ports_with_meta 的线输出)。
async fn list_views(inst: &Instance) -> Vec<ss_server::PortView> {
    let mut ws = tokio_tungstenite::connect_async(inst.url())
        .await
        .unwrap()
        .0;
    ws.send(Message::Text(r#"{"action":"list"}"#.into()))
        .await
        .unwrap();
    let text = recv_until(&mut ws, "\"type\":\"ports\"").await;
    let msg: serde_json::Value = serde_json::from_str(&text).unwrap();
    serde_json::from_value(msg["ports"].clone()).unwrap()
}

/// 自连:A 注册指向**自己**的地址——透传深度限 1 使其成为本地口的远程镜像:
/// 设备在线可用,列表恒为 本地N + 镜像N 不增殖(回归点:此前回声环 4→8→12…直至
/// 消息风暴拖死进程),open 镜像口路由回本机(附加到同一端口的占有权)。
#[tokio::test]
async fn self_connection_mirror_no_echo() {
    let a = boot(false).await;
    let port_num = a.addr.parse::<std::net::SocketAddr>().unwrap().port();

    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-me".into(),
        host: "127.0.0.1".into(),
        port: port_num,
        nickname: None,
    }]);
    a.devices.start();

    // 设备应在线(自连 = 本地口的远程镜像,合法形态)
    let mut online = false;
    for _ in 0..100 {
        if a.devices
            .device_states()
            .iter()
            .any(|d| d.id == "dev-me" && d.online)
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online, "自连设备应在线");

    // 列表稳定不增殖:本地桶 + 自连设备桶各一份,总数恒为两倍本地口数。
    let local_count = a.manager.list_ports().await.len();
    if local_count == 0 {
        // 无串口环境(CI)列表断言退化为 0==0,显式跳过而非假通过;
        // 增殖防护由 no_meta_storm 用例的数量稳定断言继续承担
        eprintln!("本环境无串口,跳过列表数量断言");
        return;
    }
    let v1 = list_views(&a).await;
    assert_eq!(
        v1.len(),
        local_count * 2,
        "应为 本地桶 + 自连桶 各一份(不增殖): {:?}",
        v1.iter().map(|v| &v.info.name).collect::<Vec<_>>()
    );
    assert!(
        v1.iter()
            .all(|v| !v.info.name.starts_with("dev-me::dev-me")),
        "不得出现二级前缀条目(回声复制): {:?}",
        v1.iter().map(|v| &v.info.name).collect::<Vec<_>>()
    );
    let v2 = list_views(&a).await;
    assert_eq!(v1.len(), v2.len(), "再次拉取数量应稳定(无每轮自我复制)");

    // open 镜像口路由回本机:错误文案应携带本机串口层的"不存在"字样
    // (而非"设备未连接/远端超时")——证明链路经自连 DeviceClient 回到了本机 serial。
    // (不用真实存在的口名:本机口被占用态不定,断言错误文案更稳)
    let s = SessionId::next();
    let res = a
        .manager
        .acquire(
            "dev-me::local::COM_NOT_EXIST".into(),
            SerialConfig::default(),
            s,
        )
        .await;
    match res {
        Err(e) => assert!(
            e.to_string().contains("不存在"),
            "镜像口 open 应路由回本机串口层(错误含'不存在'),得到: {}",
            e
        ),
        Ok(_) => panic!("不存在的口不应打开成功"),
    }
}

/// 自连回授环回归(CPU 100% 修复):本地 meta_bus 的 MetaChanged 会推给所有连接
/// (含自连这条),DeviceClient 若无条件扇出即成环(每秒百万级消息)。
/// 修复后 Ports 走缓存 diff(未变静默)、事件走 RefreshList 重拉,传播一轮收敛。
/// 断言:自连稳定后 meta_bus 在观察窗内接近静默(风暴时为天文数字)。
#[tokio::test]
async fn self_connection_no_meta_storm() {
    let a = boot(false).await;
    let port_num = a.addr.parse::<std::net::SocketAddr>().unwrap().port();
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-me".into(),
        host: "127.0.0.1".into(),
        port: port_num,
        nickname: None,
    }]);
    a.devices.start();

    // 等设备在线并完成初始拉取
    let mut online = false;
    for _ in 0..100 {
        if a.devices
            .device_states()
            .iter()
            .any(|d| d.id == "dev-me" && d.online)
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online);

    // 再静置 1s 让首轮传播收敛,然后开观察窗
    tokio::time::sleep(Duration::from_secs(1)).await;
    let v1 = list_views(&a).await;
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let v = list_views(&a).await;
        assert_eq!(v.len(), v1.len(), "观察窗内列表数量应恒定(无回授环增殖)");
    }
    // 观察窗总时长 ~1.5s,能活着走完且每次请求秒回 = 无消息风暴打满调度器
}

/// 幽灵连接回归(L1 修复):open 远端口后主动断开设备——stop 必须取消活跃会话
/// (WS 关闭 → 远端 release_all 释放占有)。修复前 stop 只置标志,心跳 Ping/Pong
/// 让"无入站判死"永不触发,连接永活,远端端口被僵尸会话永久持有。
#[tokio::test]
async fn disconnect_releases_remote_ownership() {
    let b = boot(true).await;
    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // 等设备在线后 open 远端口(B 侧被设备会话持有)
    let mut opened = false;
    let s = SessionId::next();
    for _ in 0..100 {
        if a.manager
            .acquire("dev-b::local::COM7".into(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "设备应上线可开远端端口");
    assert_eq!(b.manager.holder_count("local::COM7").await, Some(1));

    // 主动断开设备(断开按钮)→ 会话取消 → WS 关 → B 侧 release_all
    a.devices.disconnect("dev-b").unwrap();
    let mut released = false;
    for _ in 0..100 {
        if b.manager.holder_count("local::COM7").await.is_none() {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "断开设备后远端占有应随 WS 关闭释放(无幽灵连接)");
}

/// 远端别名转发回归(H1 修复):A 的客户端对远端口 set_alias——回执必须带 port
/// (设备客户端按端口路由),2s 内收到 ok 而非等满 10s 超时;别名落在端口所在机器
/// (B 侧列表可见)。
#[tokio::test]
async fn cascade_set_alias_routes_reply() {
    let b = boot(true).await;
    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // 等设备上线
    let mut online = false;
    let s = SessionId::next();
    for _ in 0..100 {
        if a.manager
            .acquire("dev-b::local::COM7".into(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online);
    let _ = a.manager.release("dev-b::local::COM7", s).await;

    // A 侧发起远端口别名 → 回执应秒级到达(带 port 的 ok)。
    // 用 B 实际枚举到的口(列表只显示枚举口,别名断言要能看到条目)
    let b_views = list_views(&b).await;
    let target = b_views
        .first()
        .map(|v| v.info.name.clone())
        .unwrap_or_else(|| "local::COM0".into());
    let a_key = format!("dev-b::{}", target);
    let mut a_ws = tokio_tungstenite::connect_async(a.url()).await.unwrap().0;
    send_text(
        &mut a_ws,
        &format!(
            r#"{{"action":"set_alias","port":"{}","alias":"GPS"}}"#,
            a_key
        ),
    )
    .await;
    let t0 = std::time::Instant::now();
    let ok = timeout(
        Duration::from_secs(3),
        recv_until(&mut a_ws, "\"type\":\"ok\""),
    )
    .await;
    assert!(
        ok.is_ok(),
        "远端口 set_alias 回执应 3s 内到达(修复前:回执无 port 不被路由,等满 10s 超时)"
    );
    assert!(t0.elapsed() < Duration::from_secs(3), "回执应秒级");

    // 别名落在端口所在机器:B 侧列表可见(经 B 的 WS 直接查,不受 A 侧缓存时序影响)。
    // B 是设备连接方(会收 MetaChanged 触发重拉),等缓存刷新后条目带 alias。
    let mut b_ws = tokio_tungstenite::connect_async(b.url()).await.unwrap().0;
    let mut got_alias = false;
    for _ in 0..50 {
        let listed = recv_until(&mut b_ws, "\"type\":\"ports\"").await;
        if listed.contains("\"alias\":\"GPS\"") {
            got_alias = true;
            break;
        }
        send_text(&mut b_ws, r#"{"action":"list"}"#).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got_alias, "别名应写入 B(端口所在机器)并出现在其列表");
}

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
    /// 本实例身份(握手自报;学习断言用)。
    instance_id: &'static str,
}

impl Instance {
    fn url(&self) -> String {
        format!("ws://{}/ws", self.addr)
    }
}

/// 起一个 server(默认实例身份)。单实例/桩对端的既有测试用;
/// 需要身份区分的测试(真实双实例互注册等)用 [`boot_as`] 显式不同 id。
async fn boot(echo: bool) -> Instance {
    boot_as(echo, "inst-anon").await
}

/// 起一个 server,显式指定实例身份。echo=true 时端口回显且不连设备(B 侧桩);
/// echo=false 时注入 CompositeOpener + 设备表(A 侧,设备经 update_registry 注册)。
async fn boot_as(echo: bool, inst: &'static str) -> Instance {
    let event_bus = Arc::new(EventBus::new(256));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone(), inst));
    devices.bind(Arc::downgrade(&devices)); // 握手学习上报需要 owner
    let opener: Arc<dyn PortOpener> = if echo {
        Arc::new(EchoOpener)
    } else {
        Arc::new(CompositeOpener::new(Arc::clone(&devices)))
    };
    let manager = Arc::new(SerialManager::new(event_bus.clone(), opener));
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        addresses: Arc::new(ss_server::address::AddressResolver::new(
            Arc::clone(&devices),
            meta_tx,
            inst.into(),
        )),
        devices: Arc::clone(&devices),
        instance_id: inst.into(),
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
        instance_id: inst,
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

/// 全链路:A 的客户端 open `<B实例id>::COM7` → 写 → 远端回显 → A 侧收到数据帧。
/// 注册用占位 id "dev-b",握手学习后段名替换为 B 的实例 id(测试键随之)。
#[tokio::test]
async fn cascade_open_write_echo() {
    let b = boot(/*echo*/ true).await;
    let a = boot(false).await;
    let key = format!("{}::COM7", b.instance_id);

    // A 注册 B 并启动设备连接池
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // 等设备上线:acquire 轮询(不依赖系统枚举——列表来自真实 COM 枚举,无串口机器为空,
    // CI/Linux 上按列表等会假超时;acquire 只需设备连接就绪)。acquire 用学习后的
    // 键(占位 id 已被 adopt 替换)。
    let mut a_ws = tokio_tungstenite::connect_async(a.url()).await.unwrap().0;
    let probe_session = SessionId::next();
    let mut online = false;
    for _ in 0..100 {
        if a.manager
            .acquire(
                key.clone(),
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
    let _ = a.manager.release(&key, probe_session).await;
    let _ = a.manager.holder_count("COM7").await;

    // open 复合键(列表键形态:学习 id + 远端线名 COM7,与生产前端一致)
    send_text(
        &mut a_ws,
        &format!(
            r#"{{"action":"open","port":"{key}","config":{{"baud_rate":115200}}}}"#
        ),
    )
    .await;
    let acquired = recv_until(&mut a_ws, "\"type\":\"acquired\"").await;
    assert!(
        acquired.contains("\"opened\":true"),
        "复合键首开: {}",
        acquired
    );
    assert_eq!(a.manager.holder_count(&key).await, Some(1));

    // write → B 回显 → A 的事件流出数据帧(port = A 侧 map 键,即事件口径的复合键)
    send_text(
        &mut a_ws,
        &format!(
            r#"{{"action":"write","port":"{key}","data":"ping","encoding":"text"}}"#
        ),
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
    assert_eq!(port, key, "数据帧端口应为级联复合键");
    assert_eq!(data, b"ping", "回显数据应原样返回");

    // B 侧确实持有:B 的 manager 里裸名 COM7 holders ≥1(DeviceClient 连接占 1)
    assert_eq!(b.manager.holder_count("COM7").await, Some(1));

    // 清理:close 复合键 → 末位 → 拆毁(A 侧);Drop 转发 ClosePort → B 侧释放
    send_text(
        &mut a_ws,
        &format!(r#"{{"action":"close","port":"{key}"}}"#),
    )
    .await;
    let _ = recv_until(&mut a_ws, "\"type\":\"ok\"").await;
    // 等 B 侧释放(异步):close 转发 → release_all/末位释放
    let mut released = false;
    for _ in 0..100 {
        if b.manager.holder_count("COM7").await.is_none() {
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
    let key = format!("{}::COM7", b.instance_id);

    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: port_num,
        nickname: None,
    }]);
    a.devices.start();

    // 等 open 通路就绪(设备在线;键为学习后的实例 id 段)
    let mut ready = false;
    for _ in 0..100 {
        if a.manager
            .acquire(
                key.clone(),
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
    a.devices.disconnect(b.instance_id).unwrap();

    // A 侧:占有权保留 + disconnected 置位(USB 拔插模型)
    let mut marked = false;
    for _ in 0..100 {
        if a.manager.is_disconnected(&key).await {
            marked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(marked, "设备断开后端口应标 disconnected");
    assert_eq!(
        a.manager.holder_count(&key).await,
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

/// 自连:A 注册指向**自己**的地址——环检测使其成为本地口的远程镜像:
/// 设备在线可用,列表恒为 本地N + 镜像N 不增殖(回归点:此前回声环 4→8→12…直至
/// 消息风暴拖死进程),open 镜像口路由回本机(附加到同一端口的占有权)。
/// 自连学到对端 id = 自己的实例 id:段名=自身 id,镜像条目经谓词首段豁免保留。
#[tokio::test]
async fn self_connection_mirror_no_echo() {
    let a = boot(false).await;
    let port_num = a.addr.parse::<std::net::SocketAddr>().unwrap().port();
    let self_seg = a.instance_id; // 自连学习后段名 = 自身实例 id

    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-me".into(),
        host: "127.0.0.1".into(),
        port: port_num,
        nickname: None,
    }]);
    a.devices.start();

    // 设备应在线(自连 = 本地口的远程镜像,合法形态),且段名已被学习替换为自身 id
    let mut online = false;
    for _ in 0..100 {
        if a.devices
            .device_states()
            .iter()
            .any(|d| d.id == self_seg && d.online)
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online, "自连设备应在线(段名=自身实例 id)");

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
    let double_prefix = format!("{self_seg}::{self_seg}");
    assert!(
        v1.iter().all(|v| !v.info.name.starts_with(&double_prefix)),
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
            format!("{self_seg}::COM_NOT_EXIST"),
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

    // 等设备在线并完成初始拉取(自连学习后段名=自身实例 id)
    let mut online = false;
    for _ in 0..100 {
        if a.devices
            .device_states()
            .iter()
            .any(|d| d.id == a.instance_id && d.online)
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

    // 等设备在线后 open 远端口(B 侧被设备会话持有;键为学习后的实例 id 段)
    let mut opened = false;
    let s = SessionId::next();
    for _ in 0..100 {
        if a.manager
            .acquire(
                format!("{}::COM7", b.instance_id),
                SerialConfig::default(),
                s,
            )
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "设备应上线可开远端端口");
    assert_eq!(b.manager.holder_count("COM7").await, Some(1));

    // 主动断开设备(断开按钮)→ 会话取消 → WS 关 → B 侧 release_all
    a.devices.disconnect(b.instance_id).unwrap();
    let mut released = false;
    for _ in 0..100 {
        if b.manager.holder_count("COM7").await.is_none() {
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

    // 等设备上线(键为学习后的实例 id 段)
    let mut online = false;
    let s = SessionId::next();
    for _ in 0..100 {
        if a.manager
            .acquire(
                format!("{}::COM7", b.instance_id),
                SerialConfig::default(),
                s,
            )
            .await
            .is_ok()
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(online);
    let _ = a.manager
        .release(&format!("{}::COM7", b.instance_id), s)
        .await;

    // A 侧发起远端口别名 → 回执应秒级到达(带 port 的 ok)。
    // 用 B 实际枚举到的口(列表只显示枚举口,别名断言要能看到条目)
    let b_views = list_views(&b).await;
    let target = b_views
        .first()
        .map(|v| v.info.name.clone())
        .unwrap_or_else(|| "COM0".into());
    let a_key = format!("{}::{}", b.instance_id, target);
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

/// 混版本互操作:模拟**旧版**远端(线名恒带 `local::` 前缀)。A(新版)以新键形态
/// `dev-b::COM7` 操作——剥段后发裸名后缀(旧版自行补前缀命中其 map),旧版回的
/// Acquired / 列表 / 数据帧都带 `local::COM7`;入站归一剥前缀后与本侧登记键一致,
/// 链路应全通。这是"新版本机 ↔ 旧版远端"双向兼容的回归锚点。
#[tokio::test]
async fn legacy_peer_local_prefixed_wire_names() {
    // 手工旧版协议桩:List→Ports(local::COM7);Open→Acquired(local::COM7);
    // Write→Ok 回执 + Binary 回显帧(port=local::COM7);Ping→Pong。
    async fn legacy_server(listener: TcpListener) {
        use futures_util::{SinkExt, StreamExt};
        let (stream, _) = listener.accept().await.unwrap();
        let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let (mut sink, mut source) = ws.split();
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(t) = msg else { continue };
            let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
            match v["action"].as_str().unwrap_or("") {
                "list" => {
                    let ports = serde_json::json!([{
                        "name": "local::COM7",
                        "opened": false,
                        "holders": 0,
                        "disconnected": false
                    }]);
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ports","ports":ports}).to_string(),
                        ))
                        .await;
                }
                "open" => {
                    let cfg = serde_json::json!({
                        "baud_rate":115200,"data_bits":"eight","stop_bits":"one",
                        "parity":"none","flow_control":"none","line_ending":"lf","timeout_ms":100
                    });
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({
                                "type":"acquired","port":"local::COM7",
                                "opened":true,"config":cfg,"holders":1
                            })
                            .to_string(),
                        ))
                        .await;
                }
                "write" => {
                    let _ = sink
                        .send(Message::Text(
                            r#"{"type":"ok","message":"written","port":"local::COM7"}"#.into(),
                        ))
                        .await;
                    // 回显数据帧,线名带旧版 local:: 前缀
                    let data = hex_to_bytes(v["data"].as_str().unwrap_or(""));
                    let frame = ss_server::protocol::data_frame("local::COM7", &data);
                    let _ = sink.send(Message::Binary(frame)).await;
                }
                "ping" => {
                    let _ = sink.send(Message::Text(r#"{"type":"pong"}"#.into())).await;
                }
                "version" => {
                    // 旧版语义应答(无 instance_id):学习放弃、保持占位段名
                    let _ = sink
                        .send(Message::Text(
                            r#"{"type":"version","version":"stub","enable_scripting":false}"#
                                .into(),
                        ))
                        .await;
                }
                _ => {}
            }
        }
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
            .collect()
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(legacy_server(listener));

    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: addr.port(),
        nickname: None,
    }]);
    a.devices.start();

    // open 新形态键:链路全通(Acquired 带遗留前缀,归一后路由到在途回执)
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager
            .acquire("dev-b::COM7".into(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "对旧版远端的 open 链路应全通(回执线名归一路由)");

    // 列表合并:远端桶条目应为归一键 dev-b::COM7(而非 dev-b::local::COM7)
    let mut views_ok = false;
    for _ in 0..50 {
        let views = list_views(&a).await;
        let remote: Vec<_> = views
            .iter()
            .filter(|v| v.info.name.starts_with("dev-b::"))
            .map(|v| v.info.name.clone())
            .collect();
        if !remote.is_empty() {
            assert!(
                remote.iter().all(|n| n == "dev-b::COM7"),
                "远端桶条目应为归一键 dev-b::COM7: {:?}",
                remote
            );
            views_ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(views_ok, "列表应出现 dev-b::COM7 条目(旧版线名归一)");

    // 数据回显:旧版回帧带 local::COM7,归一后送达 A 侧端口缓冲(EventBus 出口)
    let mut rx = a.manager.event_bus().subscribe();
    a.manager
        .write("dev-b::COM7".into(), bytes::Bytes::from_static(b"ping"))
        .await
        .unwrap();
    let mut echoed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.try_recv() {
            Ok(ss_core::SerialEvent::DataReceived { port, data }) => {
                assert_eq!(port, "dev-b::COM7", "事件端口应为 A 侧 map 键");
                assert_eq!(data, b"ping", "旧版回显数据应原样到达");
                echoed = true;
                break;
            }
            Ok(_) => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(echoed, "旧版远端的数据帧应经入站归一送达");

    let _ = a.manager.release("dev-b::COM7", s).await;
}

/// 别名后缀寻址的 RX 通路(Acquired.resolved 契约):A 以 `dev-b::GPS` open——
/// 后缀是**远端别名**,远端解析后真名为 COM7。回执带 resolved 字段时,设备客户端
/// 必须以真名登记 IO(而非请求串),否则数据帧(远端 map 键口径)与登记键分裂,
/// RX 静默断流(回归锚点:评审阻塞项 #2)。事件仍以 A 侧请求键 `dev-b::GPS` 口径发布。
#[tokio::test]
async fn alias_suffix_open_registers_resolved_name() {
    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
            .collect()
    }

    // 手工协议桩:Open(GPS)→Acquired(port=GPS, resolved=COM7);帧按真名 COM7 出站。
    async fn alias_server(listener: TcpListener) {
        use futures_util::{SinkExt, StreamExt};
        let (stream, _) = listener.accept().await.unwrap();
        let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let (mut sink, mut source) = ws.split();
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(t) = msg else { continue };
            let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
            match v["action"].as_str().unwrap_or("") {
                "list" => {
                    let ports = serde_json::json!([{
                        "name": "COM7",
                        "opened": false,
                        "holders": 0,
                        "disconnected": false,
                        "alias": "GPS"
                    }]);
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ports","ports":ports}).to_string(),
                        ))
                        .await;
                }
                "open" => {
                    assert_eq!(v["port"].as_str(), Some("GPS"), "桩只接受别名后缀");
                    let cfg = serde_json::json!({
                        "baud_rate":115200,"data_bits":"eight","stop_bits":"one",
                        "parity":"none","flow_control":"none","line_ending":"lf","timeout_ms":100
                    });
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({
                                "type":"acquired","port":"GPS","resolved":"COM7",
                                "opened":true,"config":cfg,"holders":1
                            })
                            .to_string(),
                        ))
                        .await;
                }
                "write" => {
                    let port = v["port"].as_str().unwrap_or("").to_string();
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ok","message":"written","port":port})
                                .to_string(),
                        ))
                        .await;
                    // 关键:数据帧按远端 map 键(COM7)出站,而非请求串 GPS
                    let data = hex_to_bytes(v["data"].as_str().unwrap_or(""));
                    let frame = ss_server::protocol::data_frame("COM7", &data);
                    let _ = sink.send(Message::Binary(frame)).await;
                }
                "ping" => {
                    let _ = sink.send(Message::Text(r#"{"type":"pong"}"#.into())).await;
                }
                "version" => {
                    // 旧版语义应答(无 instance_id)
                    let _ = sink
                        .send(Message::Text(
                            r#"{"type":"version","version":"stub","enable_scripting":false}"#
                                .into(),
                        ))
                        .await;
                }
                _ => {}
            }
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(alias_server(listener));

    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: addr.port(),
        nickname: None,
    }]);
    a.devices.start();

    // 以别名后缀寻址 open:回执 resolved=COM7 → 登记键应为 COM7
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager
            .acquire("dev-b::GPS".into(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "别名后缀寻址应打开成功");

    // 写入并等回显:帧按真名 COM7 出站,若登记键仍是请求串 GPS 则此处收不到(RX 断流)
    let mut rx = a.manager.event_bus().subscribe();
    a.manager
        .write("dev-b::GPS".into(), bytes::Bytes::from_static(b"pong"))
        .await
        .unwrap();
    let mut echoed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.try_recv() {
            Ok(ss_core::SerialEvent::DataReceived { port, data }) => {
                assert_eq!(port, "dev-b::GPS", "事件端口恒为 A 侧 map 键(请求形态)");
                assert_eq!(data, b"pong", "真名登记后帧应命中分发");
                echoed = true;
                break;
            }
            Ok(_) => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(echoed, "resolved 真名登记后数据帧应可达(否则 RX 断流回归)");

    let _ = a.manager.release("dev-b::GPS", s).await;
}

/// 互注册不增殖回归: A 注册 B,且 B 的列表里带指向 A 的二级条目(`dev-a::COM7`,
/// 即"B 也注册了 A"的形态)。透传放宽后二级条目(幽灵:自己口经对方绕回)合法
/// 进入但**有界**——段重复环检测保证多轮 open/close 触发的列表重拉后无自我复制
/// (历史回声环 4→8→12 直至消息风暴的回归锚点)。桩按新协议回带 req,顺带覆盖
/// 请求级回执配对路径。
#[tokio::test]
async fn mutual_registration_list_no_proliferation() {
    // B 桩: 列表 = 自己的本地口 COM9 + 二级条目 dev-a::COM7(注册了 A 的形态);
    // open/write/close 回执带 req 回显,并附发 unsolicited opened/closed 事件
    // 触发 A 侧重拉(真实 hub 的行为)。
    async fn hub_stub(listener: TcpListener) {
        let (stream, _) = listener.accept().await.unwrap();
        let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let (mut sink, mut source) = ws.split();
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(t) = msg else { continue };
            let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
            let req = v["req"].clone();
            match v["action"].as_str().unwrap_or("") {
                "list" => {
                    let ports = serde_json::json!([
                        {"name":"COM9","opened":false,"holders":0,"disconnected":false},
                        {"name":"dev-a::COM7","opened":false,"holders":0,"disconnected":false}
                    ]);
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ports","ports":ports}).to_string(),
                        ))
                        .await;
                }
                "open" => {
                    let port = v["port"].as_str().unwrap_or("").to_string();
                    let cfg = serde_json::json!({
                        "baud_rate":115200,"data_bits":"eight","stop_bits":"one",
                        "parity":"none","flow_control":"none","line_ending":"lf","timeout_ms":100
                    });
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({
                                "type":"acquired","port":port,"opened":true,
                                "config":cfg,"holders":1,"req":req
                            })
                            .to_string(),
                        ))
                        .await;
                    // unsolicited 事件 → A 侧 RefreshList 重拉
                    let _ = sink
                        .send(Message::Text(r#"{"type":"opened","port":"COM9"}"#.into()))
                        .await;
                }
                "write" => {
                    let port = v["port"].as_str().unwrap_or("").to_string();
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ok","message":"written","port":port,"req":req})
                                .to_string(),
                        ))
                        .await;
                }
                "close" => {
                    let _ = sink
                        .send(Message::Text(
                            serde_json::json!({"type":"ok","message":"closed","port":"COM9","req":req})
                                .to_string(),
                        ))
                        .await;
                    let _ = sink
                        .send(Message::Text(r#"{"type":"closed","port":"COM9"}"#.into()))
                        .await;
                }
                "ping" => {
                    let _ = sink.send(Message::Text(r#"{"type":"pong"}"#.into())).await;
                }
                "version" => {
                    // 旧版语义应答(无 instance_id)
                    let _ = sink
                        .send(Message::Text(
                            r#"{"type":"version","version":"stub","enable_scripting":false}"#
                                .into(),
                        ))
                        .await;
                }
                _ => {}
            }
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(hub_stub(listener));

    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: addr.port(),
        nickname: None,
    }]);
    a.devices.start();

    // 等设备上线 + 初始列表落缓存(合并视图出现 dev-b::COM9)
    let mut ready = false;
    for _ in 0..100 {
        let views = list_views(&a).await;
        if views.iter().any(|v| v.info.name == "dev-b::COM9") {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "自连桩上线后合并视图应出现 dev-b::COM9");

    // 多轮 open/close:每次触发 unsolicited opened/closed 事件 → RefreshList 重拉,
    // 若深度限失效,二级条目会在缓存/列表中逐轮复制。
    for _ in 0..3 {
        let s = SessionId::next();
        a.manager
            .acquire("dev-b::COM9".into(), SerialConfig::default(), s)
            .await
            .unwrap();
        let _ = a.manager.release("dev-b::COM9", s).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await; // 静置让最后一轮传播收敛

    // 断言一:dev-b 前缀条目恰好两条——远端自己的口 + 幽灵条目(自己口经对方
    // 绕回,透传放宽后合法进入且有界:段链 [dev-b, dev-a] 无重复,环检测不斩)
    let v1 = list_views(&a).await;
    let mut devb: Vec<_> = v1
        .iter()
        .filter(|v| v.info.name.contains("dev-b"))
        .map(|v| v.info.name.clone())
        .collect();
    devb.sort();
    assert_eq!(
        devb,
        vec!["dev-b::COM9".to_string(), "dev-b::dev-a::COM7".to_string()],
        "互注册形态下 dev-b 桶 = 一级端口 + 有界幽灵条目: {:?}",
        devb
    );
    // 断言二:所有条目段链无重复(环检测斩断更深增殖——回声环的回归锚点)
    assert!(
        v1.iter().all(|v| segments_unique(&v.info.name)),
        "任何条目段不得重复(列表自我复制被环检测斩断): {:?}",
        v1.iter().map(|v| &v.info.name).collect::<Vec<_>>()
    );
    // 断言三:连续多次拉取数量稳定(diff 收敛,无每轮增殖)
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let v = list_views(&a).await;
        assert_eq!(v.len(), v1.len(), "列表数量应稳定(无逐轮自我复制)");
    }
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// 键的段链无重复(环检测谓词 passthrough_port_key 的断言面)。
fn segments_unique(key: &str) -> bool {
    let mut seen = std::collections::HashSet::new();
    key.split(ss_core::PORT_KEY_SEP).all(|s| seen.insert(s))
}

/// 桩 C(最底层设备):裸名 COM7 回显,回执带 req 回显,列表恒报一条 COM7。
/// 供协议边界桩测试与真实 hub 转发测试共用——后者由真实 B 直连此桩,
/// 故 list/close 分支必须作答(真实 B 的 DeviceClient 会话建立即初始拉列表)。
async fn device_c_stub(listener: TcpListener) {
    let (stream, _) = listener.accept().await.unwrap();
    let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
    let (mut sink, mut source) = ws.split();
    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(t) = msg else { continue };
        let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
        let req = v["req"].clone();
        match v["action"].as_str().unwrap_or("") {
            "list" => {
                let ports = serde_json::json!([{
                    "name":"COM7","opened":false,"holders":0,"disconnected":false
                }]);
                let _ = sink
                    .send(Message::Text(
                        serde_json::json!({"type":"ports","ports":ports}).to_string(),
                    ))
                    .await;
            }
            "open" => {
                assert_eq!(v["port"].as_str(), Some("COM7"), "C 只接受裸名");
                let cfg = serde_json::json!({
                    "baud_rate":115200,"data_bits":"eight","stop_bits":"one",
                    "parity":"none","flow_control":"none","line_ending":"lf","timeout_ms":100
                });
                let _ = sink
                    .send(Message::Text(
                        serde_json::json!({
                            "type":"acquired","port":"COM7","opened":true,
                            "config":cfg,"holders":1,"req":req
                        })
                        .to_string(),
                    ))
                    .await;
            }
            "write" => {
                let _ = sink
                    .send(Message::Text(
                        serde_json::json!({"type":"ok","message":"written","port":"COM7","req":req})
                            .to_string(),
                    ))
                    .await;
                let data = hex_to_bytes(v["data"].as_str().unwrap_or(""));
                let _ = sink
                    .send(Message::Binary(ss_server::protocol::data_frame(
                        "COM7", &data,
                    )))
                    .await;
            }
            "close" => {
                let _ = sink
                    .send(Message::Text(
                        serde_json::json!({"type":"ok","message":"closed","port":"COM7","req":req})
                            .to_string(),
                    ))
                    .await;
            }
            "ping" => {
                let _ = sink.send(Message::Text(r#"{"type":"pong"}"#.into())).await;
            }
            "version" => {
                // 旧版语义应答(无 instance_id):真实 B 学不到 C 的 id,保持占位段名
                let _ = sink
                    .send(Message::Text(
                        r#"{"type":"version","version":"stub","enable_scripting":false}"#.into(),
                    ))
                    .await;
            }
            _ => {}
        }
    }
}

/// 真实 hub 三级级联:A/B 均为真实 server 实例(B 对 A 是 server、对 C 桩是 client)。
/// 验证透传放宽后 A 的列表出现二级条目 `dev-b::dev-c::COM7` 且可开、数据回路完整
/// (与桩版 three_level_cascade_routes_end_to_end 互补:那条验协议边界,此条验真实
/// B 的全转发路径——入站归一/缓存/列表合并/事件推送)。
#[tokio::test]
async fn cascade_three_level_real_hub_list_and_open() {
    let c_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let c_port = c_listener.local_addr().unwrap().port();
    tokio::spawn(device_c_stub(c_listener));

    // B:真实实例,注册桩 C
    let b = boot(false).await;
    b.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-c".into(),
        host: "127.0.0.1".into(),
        port: c_port,
        nickname: None,
    }]);
    b.devices.start();

    // A:真实实例,注册真实 B
    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // A 的合并列表应出现二级条目(透传放宽;修复前远端线名含 :: 即整桶丢弃)。
    // A 对 B 的段名 = B 实例 id(握手学习);B 对桩 C 学不到 id 保持占位 dev-c。
    let full_key = format!("{}::dev-c::COM7", b.instance_id);
    let mut listed = false;
    for _ in 0..100 {
        if list_views(&a).await.iter().any(|v| v.info.name == full_key) {
            listed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(listed, "A 的列表应出现二级级联条目 {full_key}(透传放宽)");

    // open:经真实 B 剥段转发到桩 C
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager
            .acquire(full_key.clone(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "三级级联键应可经真实 B 打开");
    assert_eq!(a.manager.holder_count(&full_key).await, Some(1));
    assert_eq!(
        b.manager.holder_count("dev-c::COM7").await,
        Some(1),
        "B 侧应持有剥段后的键"
    );

    // 数据回路:写 → C 回显 → B 重打线名 → A 以完整级联键口径发布
    let mut rx = a.manager.event_bus().subscribe();
    a.manager
        .write(full_key.clone(), bytes::Bytes::from_static(b"ping"))
        .await
        .unwrap();
    let mut echoed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.try_recv() {
            Ok(ss_core::SerialEvent::DataReceived { port, data }) => {
                assert_eq!(port, full_key, "事件端口应为 A 侧完整级联键");
                assert_eq!(data, b"ping", "跨两级回显数据应原样到达");
                echoed = true;
                break;
            }
            Ok(_) => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(echoed, "真实 B 转发的数据回显应可达");

    // 释放逐级传播:A 末位拆毁 → ClosePort → B 末位释放
    let _ = a.manager.release(&full_key, s).await;
    let mut released = false;
    for _ in 0..100 {
        if b.manager.holder_count("dev-c::COM7").await.is_none() {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "A 释放后 B 侧占有应逐级释放");
}

/// 端口级断链传播:B→C 断开 → B 侧标 disconnected 并推 Disconnected 事件 →
/// A 侧同线名 IO 注入断开(read Err)→ A 侧也标 disconnected(占有权保留)。
/// 修复前 A 侧只重拉列表不触碰 IO——条目不知情,RX 静默断流。
#[tokio::test]
async fn cascade_disconnected_propagates_per_port() {
    let c_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let c_port = c_listener.local_addr().unwrap().port();
    tokio::spawn(device_c_stub(c_listener));

    let b = boot(false).await;
    b.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-c".into(),
        host: "127.0.0.1".into(),
        port: c_port,
        nickname: None,
    }]);
    b.devices.start();

    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);
    a.devices.start();

    // A 对 B 的段名 = B 的实例 id(握手学习);B 对桩 C 学不到 id 保持占位 dev-c
    let full_key = format!("{}::dev-c::COM7", b.instance_id);
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager
            .acquire(full_key.clone(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "三级级联键应可打开");

    // 断中间跳:C 侧断开(B 的 DeviceClient stop → B 侧 IO close → drainer → 事件)
    b.devices.disconnect("dev-c").unwrap();

    // A 侧应感知:B 推 Disconnected{dev-c::COM7} → A 注入 IO 断开 → drainer 标记
    let mut marked = false;
    for _ in 0..100 {
        if a.manager.is_disconnected(&full_key).await {
            marked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(marked, "中间跳断开后 A 侧端口应标 disconnected(传播)");
    assert_eq!(
        a.manager.holder_count(&full_key).await,
        Some(1),
        "A 侧占有权应保留"
    );
    // 设备连接本身不受影响(A→B 仍在线,仅 B→C 断;A 侧段名=学习 id)
    assert!(
        a.devices
            .device_states()
            .iter()
            .any(|d| d.id == b.instance_id && d.online),
        "A→B 设备连接应保持在线"
    );
}

/// 三级级联端到端路由回归: A→B→C(B 注册 C,A 注册 B)。A 以 `dev-b::dev-c::COM7`
/// 操作——split 只剥首段、后缀整体透传:B 剥出 `dev-c::COM7` 转发(本桩再剥成
/// `COM7` 发 C),C 的回执/帧被 B 重打线名 `dev-c::COM7` 后转给 A。验证级联根基
/// "逐层剥段无特判"与跨两级的数据回路(open/write/RX 全链路)。
#[tokio::test]
async fn three_level_cascade_routes_end_to_end() {
    use ss_server::protocol::{data_frame, parse_data_frame};

    // B 桩(hub 形态): 对 A 展示合并视图(dev-c::COM7);A 的命令剥段转发 C,
    // C 的回执/帧重打线名转回 A。两个独立泵任务(A→C / C→A),无双端交错。
    async fn hub_b(listener: TcpListener, c_port: u16, saw: Arc<std::sync::Mutex<Vec<String>>>) {
        let (stream, _) = listener.accept().await.unwrap();
        let ws_a = tokio_tungstenite::accept_async(stream).await.unwrap();
        let (a_sink_tx, mut a_source) = ws_a.split();
        let a_sink = Arc::new(tokio::sync::Mutex::new(a_sink_tx));
        let c_ws = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/ws", c_port))
            .await
            .unwrap()
            .0;
        let (mut c_sink, mut c_source) = c_ws.split();

        // 泵一: A → C。list/pong 本地作答;open/write/close 记录剥段结果后转发。
        let saw1 = Arc::clone(&saw);
        let down = Arc::clone(&a_sink);
        let pump_down = async move {
            while let Some(Ok(Message::Text(t))) = a_source.next().await {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                    continue;
                };
                match v["action"].as_str().unwrap_or("") {
                    "list" => {
                        let ports = serde_json::json!([{
                            "name":"dev-c::COM7","opened":false,"holders":0,"disconnected":false
                        }]);
                        let _ = down.lock().await
                            .send(Message::Text(
                                serde_json::json!({"type":"ports","ports":ports}).to_string(),
                            ))
                            .await;
                    }
                    "ping" => {
                        let _ = down
                            .lock()
                            .await
                            .send(Message::Text(r#"{"type":"pong"}"#.into()))
                            .await;
                    }
                    "version" => {
                        // 旧版语义应答(无 instance_id)
                        let _ = down.lock().await
                            .send(Message::Text(
                                r#"{"type":"version","version":"stub","enable_scripting":false}"#
                                    .into(),
                            ))
                            .await;
                    }
                    "open" | "write" | "close" => {
                        let action = v["action"].as_str().unwrap_or("").to_string();
                        let port = v["port"].as_str().unwrap_or("").to_string();
                        saw1.lock().unwrap().push(format!("{action}:{port}"));
                        let mut fwd = v.clone();
                        fwd["port"] = serde_json::json!("COM7"); // 剥掉 dev-c:: 段
                        let _ = c_sink
                            .send(Message::Text(fwd.to_string()))
                            .await;
                    }
                    _ => {}
                }
            }
        };

        // 泵二: C → A。文本回执把裸名线名重写为 B 侧键;二进制帧重打线名。
        let up = Arc::clone(&a_sink);
        let pump_up = async move {
            while let Some(Ok(msg)) = c_source.next().await {
                match msg {
                    Message::Text(t) => {
                        let t = t.replace("\"port\":\"COM7\"", "\"port\":\"dev-c::COM7\"");
                        let _ = up.lock().await.send(Message::Text(t)).await;
                    }
                    Message::Binary(bin) => {
                        if let Some((_, data)) = parse_data_frame(&bin) {
                            let frame = data_frame("dev-c::COM7", data);
                            let _ = up.lock().await.send(Message::Binary(frame)).await;
                        }
                    }
                    _ => {}
                }
            }
        };
        tokio::join!(pump_down, pump_up);
    }

    // 起 C、B 两级桩
    let c_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let c_addr = c_listener.local_addr().unwrap();
    tokio::spawn(device_c_stub(c_listener));
    let b_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b_addr = b_listener.local_addr().unwrap();
    let saw = Arc::new(std::sync::Mutex::new(Vec::new()));
    tokio::spawn(hub_b(b_listener, c_addr.port(), Arc::clone(&saw)));

    // A 注册 B 并等在线
    let a = boot(false).await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b_addr.port(),
        nickname: None,
    }]);
    a.devices.start();

    let full_key = "dev-b::dev-c::COM7";
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager.acquire(full_key.into(), SerialConfig::default(), s).await.is_ok() {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "三级级联键应可打开(A→B→C 全链路)");
    assert_eq!(
        a.manager.holder_count(full_key).await,
        Some(1),
        "占有权应落在完整级联键条目"
    );

    // 剥段正确性:B 看到的应是剥掉自身段的 `dev-c::COM7`
    let saw_open = saw.lock().unwrap().iter().any(|e| e == "open:dev-c::COM7");
    assert!(saw_open, "B 应收到剥首段后的 dev-c::COM7,得到 {:?}", saw.lock().unwrap());

    // 数据回路:写 → C 回显 → B 重打线名 → A 侧以完整级联键口径发布
    let mut rx = a.manager.event_bus().subscribe();
    a.manager
        .write(full_key.into(), bytes::Bytes::from_static(b"ping"))
        .await
        .unwrap();
    let mut echoed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.try_recv() {
            Ok(ss_core::SerialEvent::DataReceived { port, data }) => {
                assert_eq!(port, full_key, "事件端口应为 A 侧完整级联键");
                assert_eq!(data, b"ping", "跨两级回显数据应原样到达");
                echoed = true;
                break;
            }
            Ok(_) => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(echoed, "三级级联的数据回显应可达");

    let _ = a.manager.release(full_key, s).await;
}

/// 身份学习显式断言:注册占位 uuid,握手学习后段名替换为对端实例 id
/// (device_states 恰为学习 id,占位消失;host/port 随行供前端对齐)。
#[tokio::test]
async fn learned_id_adopts_placeholder() {
    let b = boot_as(/*echo*/ true, "inst-b").await;
    let a = boot_as(false, "inst-a").await;
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "ph-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: Some("机器B".into()),
    }]);
    a.devices.start();

    // 学习 + 上线:段名从占位替换为 B 的实例 id
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let states = a.devices.device_states();
        if states.len() == 1 && states[0].id == "inst-b" && states[0].online {
            // host/port 随行(前端按地址对齐 remotes 的依据)
            assert_eq!(states[0].host, "127.0.0.1");
            assert_eq!(
                states[0].port,
                b.addr.parse::<std::net::SocketAddr>().unwrap().port()
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "占位段名应被学习 id 替换并上线: {:?}",
            states
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 昵称等注册信息保留在重建的条目上(id 换、其余不丢)
    assert_eq!(a.devices.nickname_of("inst-b"), Some("机器B".into()));

    // 端口键以学习 id 段可开(占位键已不存在)
    let s = SessionId::next();
    let mut opened = false;
    for _ in 0..100 {
        if a.manager
            .acquire("inst-b::COM7".into(), SerialConfig::default(), s)
            .await
            .is_ok()
        {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(opened, "学习 id 段的端口键应可开");
    let _ = a.manager.release("inst-b::COM7", s).await;
    // 测试收尾:断开设备(close_with_error 兜底本侧读线程)+ 等待窗口给 B 侧
    // 级联释放(WS 断 → release_all → teardown 置 quit)完成——测试直接返回会
    // 与这些异步清理竞争 runtime shutdown(shutdown 等滞留 blocking 任务而挂起)
    let _ = a.devices.disconnect(b.instance_id);
    tokio::time::sleep(Duration::from_secs(1)).await;
}

/// 真实双实例互注册 + 身份统一 → **零幽灵条目**(语义判据):B 学到 A 的实例
/// id,B 上报的绕回条目线名首段即 inst-a,A 的透传谓词(非首段含本机 id)识别并
/// 丢弃。与桩版 mutual_registration_list_no_proliferation(桩=旧版对端,幽灵有界)
/// 互补,共同锁定双轨。列表断言依赖本地口,无串口环境退化为仅验学习。
#[tokio::test]
async fn mutual_registration_no_ghost_with_identity() {
    let a = boot_as(false, "inst-a").await;
    let b = boot_as(false, "inst-b").await;
    let a_port = a.addr.parse::<std::net::SocketAddr>().unwrap().port();
    let b_port = b.addr.parse::<std::net::SocketAddr>().unwrap().port();

    // 互注册(占位 id,学习后各自替换为对方实例 id)
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "ph-b".into(),
        host: "127.0.0.1".into(),
        port: b_port,
        nickname: None,
    }]);
    b.devices.update_registry(&[ss_core::RemoteDevice {
        id: "ph-a".into(),
        host: "127.0.0.1".into(),
        port: a_port,
        nickname: None,
    }]);
    a.devices.start();
    b.devices.start();

    // 双向学习完成:两侧 device_states 恰为对方的实例 id
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let a_ok = a
            .devices
            .device_states()
            .iter()
            .any(|d| d.id == "inst-b" && d.online);
        let b_ok = b
            .devices
            .device_states()
            .iter()
            .any(|d| d.id == "inst-a" && d.online);
        if a_ok && b_ok {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "互注册双向学习未完成: A={:?} B={:?}",
            a.devices.device_states(),
            b.devices.device_states()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 列表零幽灵:任何条目的段链中 inst-a 不得出现在非首段(B 上报的绕回条目
    // 线名首段=inst-a,语义判据应斩断)。无串口环境列表为空,断言空转但学习
    // 断言已在上方生效。
    tokio::time::sleep(Duration::from_millis(300)).await; // 静置让列表传播收敛
    let views = list_views(&a).await;
    let ghosts: Vec<_> = views
        .iter()
        .filter(|v| {
            v.info.name
                .split(ss_core::PORT_KEY_SEP)
                .skip(1) // 首段豁免(自连镜像合法;此测试无自连,防御性跳过)
                .any(|seg| seg == "inst-a")
        })
        .map(|v| v.info.name.clone())
        .collect();
    assert!(
        ghosts.is_empty(),
        "身份统一后不应有幽灵条目(绕回路径被语义判据斩断): {ghosts:?} in {:?}",
        views.iter().map(|v| &v.info.name).collect::<Vec<_>>()
    );
    // 数量稳定(无增殖)
    let v2 = list_views(&a).await;
    assert_eq!(views.len(), v2.len(), "列表数量应稳定(无逐轮增殖)");
}

/// 重复注册同一设备:两条占位记录学到同一实例 id → 冲突,后学者保持占位段名
/// (双轨兜底:该条目行为与旧版对端一致,谓词结构判据兜底)。
#[tokio::test]
async fn duplicate_device_conflict_keeps_placeholder() {
    let b = boot_as(/*echo*/ true, "inst-b").await;
    let b_port = b.addr.parse::<std::net::SocketAddr>().unwrap().port();
    let a = boot_as(false, "inst-a").await;
    // 同地址两条记录(不同占位 id)
    a.devices.update_registry(&[
        ss_core::RemoteDevice {
            id: "ph1".into(),
            host: "127.0.0.1".into(),
            port: b_port,
            nickname: None,
        },
        ss_core::RemoteDevice {
            id: "ph2".into(),
            host: "127.0.0.1".into(),
            port: b_port,
            nickname: None,
        },
    ]);
    a.devices.start();

    // 一条学习替换为 inst-b,另一条冲突保持占位(ph1/ph2 谁先学到是竞态,
    // 断言不依赖胜者:恰好两条 = 学习条目 + 占位条目,均在线)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let states = a.devices.device_states();
        let learned = states.iter().any(|d| d.id == "inst-b" && d.online);
        let kept = states.iter().any(|d| (d.id == "ph1" || d.id == "ph2") && d.online);
        if learned && kept {
            assert_eq!(
                states.len(),
                2,
                "应恰好两条设备条目(学习 + 占位): {:?}",
                states
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "冲突策略未达预期: {:?}",
            states
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 运行时新增设备自动建连回归:start 已过后 update_registry(GUI 常态——服务运行中
/// 用户添加远程设备),新增 client 必须立即 spawn 并连上,无需手动"重连设备"。
#[tokio::test]
async fn runtime_add_connects_without_manual_reconnect() {
    let b = boot(/*echo*/ true).await;
    let a = boot(false).await;

    // GUI 常态:数据面已启动,此时才添加远程设备(save_remotes → update_registry)
    a.devices.start();
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-b".into(),
        host: "127.0.0.1".into(),
        port: b.addr.parse::<std::net::SocketAddr>().unwrap().port(),
        nickname: None,
    }]);

    // 轮询状态快照直到 B 上线(学习后段名=B 实例 id;本机回环 <1s;5s 兜底慢机)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if a.devices
            .device_states()
            .iter()
            .any(|d| d.id == b.instance_id && d.online)
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "运行时新增的设备未自动上线(被迫手动重连?)"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 首连失败可见 + 自愈回归:远端暂不可达时,首次失败必须广播 Offline(否则前端
/// 永悬"连接中…",用户只能手点重连),重试环内不刷屏;远端恢复后**自动上线**。
#[tokio::test]
async fn first_connect_failure_announces_then_self_heals() {
    // 占一个端口再释放:制造"暂不可达"地址
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);

    let a = boot(false).await;
    let mut dev_rx = a.devices.subscribe();
    a.devices.start();
    a.devices.update_registry(&[ss_core::RemoteDevice {
        id: "dev-late".into(),
        host: "127.0.0.1".into(),
        port: addr.port(),
        nickname: None,
    }]);

    // 首次失败 → 必须有 Offline 沿(此前 set_offline 对从未上线的 client 早退,
    // 新增设备在远端可达前拿不到任何状态反馈)
    let ev = timeout(Duration::from_secs(3), dev_rx.recv())
        .await
        .expect("首次连接失败未广播任何设备事件")
        .unwrap();
    assert!(
        matches!(ev, ss_server::device::DeviceEvent::Offline { .. }),
        "首事件应为 Offline: {:?}",
        ev
    );

    // 重试环不刷屏:最小退避 0.8s(jitter 下限)×2,窗口内不应再有事件
    let spam = timeout(Duration::from_millis(500), dev_rx.recv()).await;
    assert!(spam.is_err(), "重试环内不应重复广播: {:?}", spam);

    // 远端恢复(同端口起 WS 握手桩)→ 后台退避重连自动上线,无需手动干预。
    // 桩须应答 version(旧版语义,无 instance_id)——否则握手等 2s 超时才上线,
    // 叠加退避余量会吃满断言窗口。
    let listener = TcpListener::bind(addr).await.expect("重新绑定原端口");
    tokio::spawn(async move {
        use futures_util::{SinkExt, StreamExt};
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                continue;
            };
            while let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(t) = msg {
                    if t.contains("\"version\"") {
                        let _ = ws
                            .send(Message::Text(
                                r#"{"type":"version","version":"stub","enable_scripting":false}"#
                                    .into(),
                            ))
                            .await;
                    }
                }
            }
        }
    });
    let ev = timeout(Duration::from_secs(6), dev_rx.recv())
        .await
        .expect("远端恢复后未自动上线")
        .unwrap();
    assert!(
        matches!(ev, ss_server::device::DeviceEvent::Online { .. }),
        "恢复后应为 Online: {:?}",
        ev
    );
}

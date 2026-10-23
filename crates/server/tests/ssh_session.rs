//! SSH 后端集成测试：russh 内置 server 起假 SSH 主机（回显 PTY），
//! 验证 SshManager 端到端通路——认证、open/write/read、多实例隔离、close。
//!
//! 不碰真实网络与真实 sshd：server 监听 127.0.0.1:0（随机端口），密码认证。
//! 配置目录经 SERIAL_STUDIO_CONFIG_DIR 隔离（TOFU known_hosts 落盘不污染）。

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Session};
use russh::{Channel, ChannelId};
use ss_core::{PortIo, SerialConfig};
use ss_server::ssh::{self, SshAuthRecord, SshEndpointRecord, SshHostRecord, SshManager};

// ===== 假 SSH 服务器（回显一切数据；PTY/shell 请求成功） =====

#[derive(Clone, Default)]
struct EchoSshServer;

impl server::Server for EchoSshServer {
    type Handler = Self;
    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

impl server::Handler for EchoSshServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-password" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<russh::server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

/// 起回显 SSH 服务器，返回 (host, port)。
async fn spawn_echo_ssh_server() -> (String, u16) {
    let (host, port, _abort) = spawn_echo_ssh_server_abortable().await;
    (host, port)
}

/// 可中止版:指纹变更测试需要停掉旧 server 再于同端口起新 key 的 server。
async fn spawn_echo_ssh_server_abortable() -> (String, u16, tokio::task::AbortHandle) {
    let config = Arc::new(server_config());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                let _ = server::run_stream(config, socket, EchoSshServer).await;
            });
        }
    });
    (addr.ip().to_string(), addr.port(), task.abort_handle())
}

fn server_config() -> server::Config {
    server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_secs(1),
        keys: vec![russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap()],
        ..Default::default()
    }
}

// ===== 测试辅助 =====

fn record(id: &str, host: &str, port: u16) -> SshHostRecord {
    SshHostRecord {
        id: id.into(),
        host: host.into(),
        port,
        username: "testuser".into(),
        nickname: None,
        auth: SshAuthRecord::Password {
            password: "correct-password".into(),
        },
        endpoints: vec![SshEndpointRecord {
            name: "shell".into(),
            r#type: "shell".into(),
            alias: None,
        }],
    }
}

/// 读 PortIo 直到收集满 want 字节或超时（TimedOut 续轮——与 port_task 读循环同纪律）。
fn read_until(io: &mut Box<dyn PortIo>, want: usize, timeout: Duration) -> Vec<u8> {
    let mut out = Vec::new();
    let deadline = std::time::Instant::now() + timeout;
    let mut buf = [0u8; 256];
    while out.len() < want && std::time::Instant::now() < deadline {
        match io.read(&mut buf) {
            Ok(n) if n > 0 => out.extend_from_slice(&buf[..n]),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => panic!("读失败: {e}"),
        }
    }
    out
}

// ===== 测试 =====
/// 测试辅助:信任指定设备的 host key(新策略:首连不自动 TOFU,须显式确认)。
/// trust_host_key 是同步阻塞(block_on),须在 spawn_blocking 里调。
async fn trust(mgr: &SshManager, host_id: &str) {
    let rec = mgr
        .registry_snapshot()
        .into_iter()
        .find(|r| r.id == host_id)
        .unwrap();
    let fp = tokio::task::spawn_blocking(move || ssh::session::trust_host_key(rec))
        .await
        .unwrap()
        .expect("trust 失败");
    assert!(fp.starts_with("SHA256:"), "指纹形态: {fp}");
}

/// 端到端主干：open（建连+认证+PTY+shell）→ write → 回显 read → drop 关闭。
#[tokio::test]
async fn open_write_read_roundtrip() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("sshdev1", &host, port)]);
    trust(&mgr, "sshdev1").await;

    let m = Arc::clone(&mgr);
    let mut io = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev1", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("open 失败");

    // PortIo 是同步阻塞接口(write 内 recv_timeout 等回执)——必须 spawn_blocking,
    // 在 current_thread 测试 runtime 的 async 上下文直接调会冻结唯一线程(命令循环停摆)。
    let echoed = tokio::task::spawn_blocking(move || {
        io.write_all(b"ping-ssh\n").unwrap();
        read_until(&mut io, b"ping-ssh\n".len(), Duration::from_secs(5))
    })
    .await
    .unwrap();
    assert_eq!(echoed, b"ping-ssh\n", "回显服务器应原样返回");
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 多实例：shell 与 shell@2 两条独立 PTY,各写各读互不串流。
#[tokio::test]
async fn multiple_instances_isolated() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-multi-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("sshdev2", &host, port)]);
    trust(&mgr, "sshdev2").await;

    let m = Arc::clone(&mgr);
    let mut io1 = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev2", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("首实例 open 失败");

    let m2 = Arc::clone(&mgr);
    let mut io2 = tokio::task::spawn_blocking(move || {
        m2.open_blocking("sshdev2", "shell@2", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("第二实例 open 失败");

    // 同 roundtrip:阻塞 IO 全部 spawn_blocking(两个实例各自一任务,可并行)
    let h1 = tokio::task::spawn_blocking(move || {
        io1.write_all(b"from-instance-1\n").unwrap();
        read_until(&mut io1, b"from-instance-1\n".len(), Duration::from_secs(5))
    });
    let h2 = tokio::task::spawn_blocking(move || {
        io2.write_all(b"from-instance-2\n").unwrap();
        read_until(&mut io2, b"from-instance-2\n".len(), Duration::from_secs(5))
    });
    assert_eq!(h1.await.unwrap(), b"from-instance-1\n");
    assert_eq!(h2.await.unwrap(), b"from-instance-2\n");
}

/// 注册表变更终结既有会话(回归:此前 update_registry 只换内存表,旧连接滞留,
/// 新终端静默挂旧 host/凭据直到连接碰巧死亡)。变更后旧 IO 应读到断开错误,
/// 重信任(新 host:port 首连)后重开走第二台服务器。
#[tokio::test]
async fn update_registry_kills_changed_session() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-regsync-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host1, port1) = spawn_echo_ssh_server().await;
    let (host2, port2) = spawn_echo_ssh_server().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("sshdev3", &host1, port1)]);
    trust(&mgr, "sshdev3").await;

    let m = Arc::clone(&mgr);
    let mut io = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev3", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("open 失败");

    let m = Arc::clone(&mgr);
    let (echoed, drop_err) = tokio::task::spawn_blocking(move || {
        io.write_all(b"ping-old\n").unwrap();
        let echoed = read_until(&mut io, b"ping-old\n".len(), Duration::from_secs(5));
        // 同 id 换 host/port → 会话应终结;旧 IO 此后读到断开错误(非 TimedOut)
        m.update_registry(vec![record("sshdev3", &host2, port2)]);
        let mut drop_err = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut buf = [0u8; 64];
        while drop_err.is_empty() && std::time::Instant::now() < deadline {
            match io.read(&mut buf) {
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => drop_err = e.to_string(),
                Ok(_) => {} // 先排空残余回显
            }
        }
        (echoed, drop_err)
    })
    .await
    .unwrap();
    assert_eq!(echoed, b"ping-old\n", "变更前回显正常");
    assert!(
        !drop_err.is_empty(),
        "变更注册表后旧会话应断开(5s 内无断开错误)"
    );

    // 新记录生效:重开走第二台服务器(不同 host key,须重新信任)
    trust(&mgr, "sshdev3").await;
    let m = Arc::clone(&mgr);
    let mut io2 = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev3", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("变更后重开失败");
    let echoed2 = tokio::task::spawn_blocking(move || {
        io2.write_all(b"ping-new\n").unwrap();
        read_until(&mut io2, b"ping-new\n".len(), Duration::from_secs(5))
    })
    .await
    .unwrap();
    assert_eq!(echoed2, b"ping-new\n", "重开应连上新记录的服务器");
}

/// 密码错误：open 回执带认证失败信息（不 panic,错误进 SerialError::OpenFailed）。
#[tokio::test]
async fn wrong_password_reports_auth_failure() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-auth-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mut rec = record("sshdev3", &host, port);
    rec.auth = SshAuthRecord::Password {
        password: "wrong".into(),
    };
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![rec]);
    trust(&mgr, "sshdev3").await;

    let m = Arc::clone(&mgr);
    let result = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev3", "shell", &SerialConfig::default())
    })
    .await
    .unwrap();
    match result {
        Err(ss_core::SerialError::OpenFailed {
            message, detail, ..
        }) => {
            assert!(
                message.contains("认证失败"),
                "错误信息应含认证失败: {message}"
            );
            let cls = detail.as_deref().and_then(ssh::SshOpenError::from_detail);
            assert_eq!(
                cls,
                Some(ssh::SshOpenError::AuthFailed {
                    method: "密码".into()
                }),
                "detail 应分类为 AuthFailed(重输闭环触发器)"
            );
        }
        Err(other) => panic!("应报 OpenFailed 认证失败,得到: {other:?}"),
        Ok(_) => panic!("错误密码不应 open 成功"),
    }
}

/// resize 走通(回显服务器忽略 window_change;不崩即算过)。
#[tokio::test]
async fn resize_is_idempotent_noop() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-resize-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("sshdev4", &host, port)]);
    trust(&mgr, "sshdev4").await;

    let m = Arc::clone(&mgr);
    let mut io = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev4", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("open 失败");

    let (got, got2) = tokio::task::spawn_blocking(move || {
        io.write_all(b"before-resize\n").unwrap();
        let a = read_until(&mut io, b"before-resize\n".len(), Duration::from_secs(5));
        mgr.resize_blocking("sshdev4", "shell", 120, 40);
        mgr.resize_blocking("sshdev4", "shell@9", 80, 24); // 不存在实例:静默
        std::thread::sleep(Duration::from_millis(150));
        io.write_all(b"after-resize\n").unwrap();
        let b = read_until(&mut io, b"after-resize\n".len(), Duration::from_secs(5));
        (a, b)
    })
    .await
    .unwrap();
    assert_eq!(got, b"before-resize\n");
    assert_eq!(got2, b"after-resize\n");
}

// 实例分配纯函数的回归(不经网络)在 ssh::mod tests;此处补一条全键口径:
#[test]
fn next_instance_full_key_semantics() {
    let occ = vec!["sshdev::shell".to_string(), "sshdev::shell@3".to_string()];
    assert_eq!(ssh::next_instance_key("sshdev", "shell", &occ), "shell@2");
}

// ===== WS 层 CRUD 集成（handler 胶水：ssh_save/ssh_list/ssh_next_instance） =====

use futures_util::{SinkExt, StreamExt};
use ss_core::{EventBus, SerialManager};
use ss_server::{create_router, AppState};
use tokio_tungstenite::tungstenite::Message;

/// 起 server(空设备表 + 真 SshManager,无 opener 需要——SSH 动作不触 open)。
/// 返回 (ws_url, ssh 管理器)——测试驱动注册表/别名。
async fn boot_ws() -> (String, Arc<SshManager>) {
    let event_bus = Arc::new(EventBus::new(64));
    let manager = Arc::new(SerialManager::new(
        event_bus.clone(),
        Arc::new(ss_core::RealPortOpener), // 占位:SSH 动作不经 manager open
    ));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        meta_tx.clone(),
        "inst-ssh-ws",
    ));
    devices.bind(Arc::downgrade(&devices));
    let ssh = Arc::new(SshManager::from_registry());
    let state = AppState {
        manager,
        event_bus,
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        addresses: Arc::new(ss_server::address::AddressResolver::new(
            Arc::clone(&devices),
            Arc::new(ss_server::ssh::SshManager::empty()),
            meta_tx,
            "inst-ssh-ws".into(),
        )),
        devices,
        ssh: Arc::clone(&ssh),
        instance_id: "inst-ssh-ws".into(),
    };
    let app = create_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("ws://{}/ws", addr), ssh)
}

#[tokio::test]
async fn ws_ssh_save_list_next_roundtrip() {
    let (url, _ssh) = boot_ws().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // save:全量写两台(密钥+密码,camelCase 线格式) → 应回 ssh_hosts
    let save = r#"{"action":"ssh_save","hosts":[
        {"id":"h1","host":"192.0.2.10","port":22,"username":"root","auth":{"type":"key","keyPath":"~/.ssh/id_ed25519"},"endpoints":[{"name":"shell","type":"shell"}]},
        {"id":"h2","host":"192.0.2.11","port":2222,"username":"pi","nickname":"车间网关","auth":{"type":"password","password":"pw"},"endpoints":[{"name":"shell","type":"shell","alias":"控制台"}]}]}"#;
    ws.send(Message::Text(save.into())).await.unwrap();
    let echo = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                if t.contains("\"ssh_hosts\"") {
                    return t;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(
        echo.contains("车间网关") && echo.contains("控制台"),
        "回推注册表含昵称与端点别名: {echo}"
    );
    assert!(echo.contains("keyPath"), "线格式 camelCase: {echo}");

    // list:另一连接拉取 → 同表
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws2.send(Message::Text(r#"{"action":"ssh_list"}"#.into()))
        .await
        .unwrap();
    let listed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws2.next().await {
                if t.contains("\"ssh_hosts\"") {
                    return t;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(listed.contains("192.0.2.11"));

    // next_instance:无占用 → shell
    ws2.send(Message::Text(
        r#"{"action":"ssh_next_instance","host_id":"h1","base":"shell"}"#.into(),
    ))
    .await
    .unwrap();
    let inst = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws2.next().await {
                if t.contains("\"ssh_instance\"") {
                    return t;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(
        inst.contains(r#""name":"shell""#),
        "首个实例名 = shell: {inst}"
    );

    // save 后端点兜底:缺 endpoints 的条目保存 → 回推补默认 shell
    ws2.send(Message::Text(r#"{"action":"ssh_save","hosts":[{"id":"h3","host":"192.0.2.12","port":22,"username":"a","auth":{"type":"agent"}}]}"#.into())).await.unwrap();
    let fixed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws2.next().await {
                if t.contains("\"ssh_hosts\"") && t.contains("h3") {
                    return t;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(
        fixed.contains("\"name\":\"shell\""),
        "端点缺失走默认兜底: {fixed}"
    );
}

/// Bug 回归 1:新建终端后实例行(shell@2)必须出现在 list(此前只有 tab 没有
/// 侧栏行——list 合并未把 manager 快照中的 SSH 实例合入)。
/// 用 FakeOpener 直开(绕过真实 russh,验证的是 list 合并逻辑而非连接)。
#[tokio::test]
async fn instance_rows_visible_in_list() {
    use ss_core::{PortIo, PortOpener};

    struct FakePort;
    impl std::io::Read for FakePort {
        fn read(&mut self, _b: &mut [u8]) -> std::io::Result<usize> {
            // 真实串口语义:阻塞到超时才返回(瞬间返回的桩与 core 读循环的组合未经测试验证)
            std::thread::sleep(Duration::from_millis(50));
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
    struct FakeOpen;
    impl PortOpener for FakeOpen {
        fn open(
            &self,
            _p: &str,
            _c: &SerialConfig,
        ) -> Result<Box<dyn PortIo>, ss_core::SerialError> {
            Ok(Box::new(FakePort))
        }
    }

    let event_bus = Arc::new(EventBus::new(64));
    let manager = Arc::new(SerialManager::new(event_bus.clone(), Arc::new(FakeOpen)));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        meta_tx.clone(),
        "inst-ssh-list",
    ));
    let ssh = Arc::new(SshManager::empty());
    ssh.update_registry(vec![record("hlist", "192.0.2.50", 22)]);
    let state = AppState {
        manager: manager.clone(),
        event_bus,
        meta_bus: Arc::new(meta_tx.clone()),
        script_bus: Arc::new(tokio::sync::broadcast::channel(16).0),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        addresses: Arc::new(ss_server::address::AddressResolver::new(
            devices.clone(),
            Arc::clone(&ssh) as Arc<SshManager>,
            meta_tx,
            "inst-ssh-list".into(),
        )),
        devices,
        ssh: Arc::clone(&ssh),
        instance_id: "inst-ssh-list".into(),
    };
    // open 两个实例(shell + shell@2)——占有权进 manager 快照。session 留到结尾
    // release:port_task 读线程是 spawn_blocking 死循环,不 release 则 runtime drop
    // 等不到读线程退出,测试进程挂死(ws_session 同款 FakePort 皆以 close 收尾,故不挂)。
    let sess1 = ss_core::SessionId::next();
    let sess2 = ss_core::SessionId::next();
    let s1 = manager
        .acquire("hlist::shell".into(), SerialConfig::default(), sess1)
        .await;
    assert!(s1.is_ok(), "{s1:?}");
    let s2 = manager
        .acquire("hlist::shell@2".into(), SerialConfig::default(), sess2)
        .await;
    assert!(s2.is_ok(), "{s2:?}");

    // list 合并:端点行 + 两个实例行都在

    let views = ss_server::list_ports_with_meta(&state).await;

    let names: Vec<&str> = views.iter().map(|v| v.info.name.as_str()).collect();
    assert!(names.contains(&"hlist::shell"), "端点行存在: {names:?}");
    assert!(
        names.contains(&"hlist::shell@2"),
        "实例行存在(bug1): {names:?}"
    );
    let inst = views
        .iter()
        .find(|v| v.info.name == "hlist::shell@2")
        .unwrap();
    assert!(
        inst.info.opened && inst.info.holders >= 1,
        "实例行是真实态: {:?}",
        inst.info
    );
    // 基端点行 holders 回填(用户 bug:首开 shell 行不显数字)
    let base = views
        .iter()
        .find(|v| v.info.name == "hlist::shell")
        .unwrap();
    assert_eq!(base.info.holders, 1, "基端点行应回填本地 holders");
    assert!(base.info.opened, "基端点行 opened 由快照覆盖");

    // 收尾:释放两端点,读线程退出,runtime 才能关闭
    let _ = manager.release("hlist::shell", sess1).await;
    let _ = manager.release("hlist::shell@2", sess2).await;
}

/// Bug 回归 2:脚本寻址「设备昵称::shell」必须解析到 SSH 设备 id(此前 SSH 昵称
/// 不在首段甄别来源,透传后报"未打开")。直测 resolver。
/// tokio::test:resolver 惰性 watcher 在无 runtime 的同步测试里 tokio::spawn 会 panic。
#[tokio::test]
async fn ssh_nickname_resolves_in_addressing() {
    let (tx, _) = tokio::sync::broadcast::channel(4);
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        tx.clone(),
        "self",
    ));
    let ssh = Arc::new(SshManager::empty());
    ssh.update_registry(vec![SshHostRecord {
        id: "uuid-ssh-1".into(),
        host: "192.0.2.60".into(),
        port: 22,
        username: "root".into(),
        nickname: Some("switch-dev".into()),
        auth: SshAuthRecord::Agent,
        endpoints: vec![SshEndpointRecord {
            name: "shell".into(),
            r#type: "shell".into(),
            alias: None,
        }],
    }]);
    let r = ss_server::address::AddressResolver::new(
        devices,
        Arc::clone(&ssh),
        tx.clone(),
        "self".into(),
    );
    let resolved = r.resolve_for_test("switch-dev::shell");
    assert_eq!(
        resolved, "uuid-ssh-1::shell",
        "SSH 设备昵称应解析为 id(bug2)"
    );

    // 端点别名(裸名寻址):「控制台」→ uuid-ssh-1::shell
    ssh.set_ssh_alias("uuid-ssh-1", "shell", Some("控制台".into()))
        .unwrap();
    let r2 = ss_server::address::AddressResolver::new(
        Arc::new(ss_server::device::DeviceClientManager::empty(
            tx.clone(),
            "self",
        )),
        Arc::clone(&ssh),
        tokio::sync::broadcast::channel(4).0,
        "self".into(),
    );
    let resolved2 = r2.resolve_for_test("控制台");
    assert_eq!(resolved2, "uuid-ssh-1::shell", "SSH 端点别名应解析(bug2)");

    // 实例别名(内存表):set_alias 到 shell@2 后解析
    ssh.set_ssh_alias("uuid-ssh-1", "shell@2", Some("tmp".into()))
        .unwrap();
    let r3 = ss_server::address::AddressResolver::new(
        Arc::new(ss_server::device::DeviceClientManager::empty(
            tokio::sync::broadcast::channel(4).0,
            "self",
        )),
        ssh,
        tokio::sync::broadcast::channel(4).0,
        "self".into(),
    );
    assert_eq!(
        r3.resolve_for_test("tmp"),
        "uuid-ssh-1::shell@2",
        "实例别名应解析"
    );
}

/// 指纹生命周期(bug 回归+新策略):首连拒绝(HostKeyUnknown,带指纹) → 信任后可开
/// → 服务器换 key 后再开拒绝(HostKeyChanged,带新旧指纹)。
/// 同端口换 key:先 abort 旧 server 任务,再用新 key 在同端口起新 server。
#[tokio::test]
async fn host_key_lifecycle_unknown_then_changed() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-hk-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    // 起第一台(随机端口,key1,可中止——第三步同端口换 key 需要)
    let (host, port, server1) = spawn_echo_ssh_server_abortable().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("hk", &host, port)]);

    // 1) 首连:拒绝 + 分类 HostKeyUnknown(带指纹与算法)
    let m1 = Arc::clone(&mgr);
    let r1 = tokio::task::spawn_blocking(move || {
        m1.open_blocking("hk", "shell", &SerialConfig::default())
    })
    .await
    .unwrap();
    match &r1 {
        Err(ss_core::SerialError::OpenFailed { detail, .. }) => {
            let cls = detail
                .as_deref()
                .and_then(ssh::SshOpenError::from_detail)
                .unwrap();
            match cls {
                ssh::SshOpenError::HostKeyUnknown {
                    fingerprint,
                    key_type,
                } => {
                    assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
                    assert!(!key_type.is_empty());
                }
                other => panic!("应分类 HostKeyUnknown,得到 {other:?}"),
            }
        }
        _ => panic!("首连应被拒(确认制)"),
    }

    // 2) 信任后:可开可读写
    trust(&mgr, "hk").await;
    let m2 = Arc::clone(&mgr);
    let mut io = tokio::task::spawn_blocking(move || {
        m2.open_blocking("hk", "shell", &SerialConfig::default())
    })
    .await
    .unwrap()
    .expect("信任后应可开");
    // PortIo 阻塞接口须 spawn_blocking(直接调会冻结 current_thread runtime,写回执永不到达)
    let echoed = tokio::task::spawn_blocking(move || {
        io.write_all(b"hi\n").unwrap();
        read_until(&mut io, 3, Duration::from_secs(5))
    })
    .await
    .unwrap();
    assert_eq!(echoed, b"hi\n");

    // 3) 同端口换 key(新 server):先停旧 server 释放端口,再起新 key 的 server。
    //    旧 manager 的会话池仍持活连接(abort 只停 accept)——换新 manager 实例驱动
    //    新建连:known_hosts 落盘共享,新连即对上新 key → HostKeyChanged。
    server1.abort();
    tokio::time::sleep(Duration::from_millis(300)).await; // 端口释放窗口
    let server2 = tokio::net::TcpListener::bind(format!("{host}:{port}"))
        .await
        .unwrap();
    let cfg2 = Arc::new(server_config());
    let t2 = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = server2.accept().await else {
                break;
            };
            let cfg = Arc::clone(&cfg2);
            tokio::spawn(async move {
                let _ = server::run_stream(cfg, socket, EchoSshServer).await;
            });
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let m3 = Arc::new(SshManager::empty());
    m3.update_registry(vec![record("hk", &host, port)]);
    let r3 = tokio::task::spawn_blocking(move || {
        m3.open_blocking("hk", "shell", &SerialConfig::default())
    })
    .await
    .unwrap();
    match &r3 {
        Err(ss_core::SerialError::OpenFailed { detail, .. }) => {
            let cls = detail
                .as_deref()
                .and_then(ssh::SshOpenError::from_detail)
                .unwrap();
            match cls {
                ssh::SshOpenError::HostKeyChanged {
                    known, received, ..
                } => {
                    assert!(known.starts_with("SHA256:") && received.starts_with("SHA256:"));
                    assert_ne!(known, received, "新旧指纹应不同");
                }
                other => panic!("应分类 HostKeyChanged,得到 {other:?}"),
            }
        }
        _ => panic!("指纹变更应被拒"),
    }
    t2.abort();
}

/// 线格式契约:SshOpenError 的 serde 形态(camelCase/蛇形 tag)与 detail 往返。
#[test]
fn ssh_open_error_wire_shape() {
    let e = ssh::SshOpenError::HostKeyUnknown {
        fingerprint: "SHA256:abc".into(),
        key_type: "ED25519".into(),
    };
    let json = e.to_detail();
    assert!(json.contains(r#""kind":"host_key_unknown""#), "{json}");
    assert!(json.contains(r#""keyType":"ED25519""#), "{json}");
    assert_eq!(ssh::SshOpenError::from_detail(&json), Some(e));
    // 兼容:detail 缺失的 OpenFailed(外 tag 枚举形)仍可反序列化,detail=None
    let legacy = r#"{"OpenFailed":{"port":"COM5","message":"x"}}"#;
    let e: ss_core::SerialError = serde_json::from_str(legacy).unwrap();
    assert!(matches!(
        e,
        ss_core::SerialError::OpenFailed { detail: None, .. }
    ));
}

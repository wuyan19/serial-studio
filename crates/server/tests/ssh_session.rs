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

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

/// 起回显 SSH 服务器，返回 (host, port)。
async fn spawn_echo_ssh_server() -> (String, u16) {
    let config = Arc::new(server_config());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else { break };
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                let _ = server::run_stream(config, socket, EchoSshServer).await;
            });
        }
    });
    (addr.ip().to_string(), addr.port())
}

fn server_config() -> server::Config {
    server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_secs(1),
        keys: vec![
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
                .unwrap(),
        ],
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
        auth: SshAuthRecord::Password { password: "correct-password".into() },
        endpoints: vec![SshEndpointRecord { name: "shell".into(), r#type: "shell".into(), alias: None }],
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

/// 端到端主干：open（建连+认证+PTY+shell）→ write → 回显 read → drop 关闭。
#[tokio::test]
async fn open_write_read_roundtrip() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![record("sshdev1", &host, port)]);

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

/// 密码错误：open 回执带认证失败信息（不 panic,错误进 SerialError::OpenFailed）。
#[tokio::test]
async fn wrong_password_reports_auth_failure() {
    let dir = std::env::temp_dir().join(format!("ss-ssh-test-auth-{}", std::process::id()));
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (host, port) = spawn_echo_ssh_server().await;
    let mut rec = record("sshdev3", &host, port);
    rec.auth = SshAuthRecord::Password { password: "wrong".into() };
    let mgr = Arc::new(SshManager::empty());
    mgr.update_registry(vec![rec]);

    let m = Arc::clone(&mgr);
    let result = tokio::task::spawn_blocking(move || {
        m.open_blocking("sshdev3", "shell", &SerialConfig::default())
    })
    .await
    .unwrap();
    match result {
        Err(ss_core::SerialError::OpenFailed { message, .. }) => {
            assert!(message.contains("认证失败"), "错误信息应含认证失败: {message}");
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

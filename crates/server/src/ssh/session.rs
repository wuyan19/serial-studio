//! 单台 SSH 设备的连接会话：一条 russh 连接(懒建) + 每实例一条 PTY channel。
//!
//! 生命周期与 DeviceClient 同构:命令循环任务持有 russh Handle(异步侧),同步侧
//! (manager 的 spawn_blocking)经 std mpsc 发命令、等回执——open_blocking /
//! SshPortIo::write 都不碰异步 API。**实例任务**独占 Channel(wait 需 &mut,写与
//! resize 经实例内命令通道串行化,select 无借用冲突),channel 数据 → SshSharedIo
//! 推→拉缓冲(port_io.rs)。连接断(命令失败)→ dead 置位 + 全部实例 shared 置
//! closed → 上层 drainer 标 disconnected → reopen 时 SshManager 重建整条会话
//! (新连接),与"USB 拔插后重开"同模型。
//!
//! Host key 校验:TOFU——首连指纹记入 ssh_known_hosts.json;已记录且不匹配则
//! 拒绝(check_server_key 返 false,日志带两端指纹),下次连接仍拒绝直到人工清除。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::keys::ssh_key::HashAlg;
use russh::{Channel, ChannelMsg};

use super::port_io::SshSharedIo;
use super::store::{self, SshAuthRecord, SshHostRecord};

/// 会话级命令(同步侧 → 命令循环)。实例级操作转发给实例任务(见 InstanceCmd)。
pub(crate) enum SshCommand {
    /// 打开一个实例(channel + PTY + shell)。shared 由调用方创建,回执成功后
    /// SshPortIo 即可读;失败信息映射 SerialError::OpenFailed 口径。
    Open {
        instance: String,
        shared: Arc<SshSharedIo>,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Write {
        instance: String,
        data: Vec<u8>,
        reply: std::sync::mpsc::Sender<std::io::Result<()>>,
    },
    /// 关闭实例(SshPortIo drop 触发):移出实例表 → 实例任务收尾。
    CloseInstance { instance: String },
    /// PTY 尺寸变更(xterm fit → window_change)。
    Resize { instance: String, cols: u32, rows: u32 },
}

/// 实例内命令(命令循环 → 实例任务)。
enum InstanceCmd {
    Data(Vec<u8>, std::sync::mpsc::Sender<std::io::Result<()>>),
    Resize(u32, u32),
}

/// 一台设备的会话句柄(同步侧持有)。dead = 连接已断,open_blocking 据此重建。
pub(crate) struct SshSession {
    pub(crate) cmd_tx: tokio::sync::mpsc::UnboundedSender<SshCommand>,
    pub(crate) dead: Arc<AtomicBool>,
}

/// 连接总预算(TCP + 握手 + 认证),超时报 OpenFailed。
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 建连 + 认证 + 命令循环。连接失败:dead 置位 + **排空在途命令**(Open 立即回执
/// 失败原因,调用方不等满超时),随后任务退出。
pub(crate) async fn run_session(
    record: SshHostRecord,
    mut cmd_rx: tokio::sync::mpsc::UnboundedReceiver<SshCommand>,
    dead: Arc<AtomicBool>,
) {
    let handle = match connect_and_auth(&record).await {
        Ok(h) => h,
        Err(e) => {
            dead.store(true, Ordering::Release);
            tracing::warn!("SSH 设备 {}({}) 连接失败: {}", record.label(), record.id, e);
            while let Ok(cmd) = cmd_rx.try_recv() {
                if let SshCommand::Open { reply, .. } = cmd {
                    let _ = reply.send(Err(format!("连接失败: {e}")));
                }
            }
            return;
        }
    };
    command_loop(handle, record, &mut cmd_rx, dead).await
}

// ===== host key(TOFU) =====

struct HostKeyChecker {
    host: String,
    port: u16,
}

fn fingerprint_of(pk: &PublicKeyOrCertificate) -> String {
    match pk {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
        PublicKeyOrCertificate::Certificate(c) => c.public_key().fingerprint(HashAlg::Sha256),
    }
    .to_string()
}

impl client::Handler for HostKeyChecker {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = fingerprint_of(key);
        match store::known_fingerprint(&self.host, self.port) {
            None => {
                tracing::info!("SSH 首连 {}:{} 记住指纹 {fp}(TOFU)", self.host, self.port);
                let _ = store::remember_fingerprint(&self.host, self.port, &fp);
                Ok(true)
            }
            Some(known) if known == fp => Ok(true),
            Some(known) => {
                tracing::error!(
                    "SSH 主机指纹变更(疑似中间人)! {}:{} 已信任 {known},现收到 {fp} —— 拒绝连接",
                    self.host,
                    self.port
                );
                Ok(false)
            }
        }
    }
}

// ===== 连接与认证 =====

async fn connect_and_auth(record: &SshHostRecord) -> Result<Handle<HostKeyChecker>, String> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            ..<_>::default()
        });
        let checker = HostKeyChecker { host: record.host.clone(), port: record.port };
        let mut handle = client::connect(config, (record.host.as_str(), record.port), checker)
            .await
            .map_err(|e| format!("连接 {}:{} 失败: {e}", record.host, record.port))?;
        if !authenticate(&mut handle, &record.username, &record.auth).await? {
            return Err(format!(
                "认证失败(user={}, 方式={})",
                record.username,
                auth_label(&record.auth)
            ));
        }
        Ok(handle)
    })
    .await
    .map_err(|_| format!("连接 {}:{} 超时({}秒)", record.host, record.port, CONNECT_TIMEOUT.as_secs()))?
}

/// 设备测试连接(管理弹窗「测试」):建连 + host key 校验 + 认证,随即断开。
/// 不经过会话池(不创建/复用 SshSession)——测试是只读探测,不留连接。
/// pub:tauri-app 的 ssh_test 命令(本地 IPC 出口)同样调用。
pub async fn test_connection(record: SshHostRecord) -> Result<(), String> {
    let handle = connect_and_auth(&record).await?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "test ok", "Serial Studio")
        .await;
    Ok(())
}

fn auth_label(auth: &SshAuthRecord) -> &'static str {
    match auth {
        SshAuthRecord::Key { .. } => "密钥",
        SshAuthRecord::Agent => "Agent",
        SshAuthRecord::Password { .. } => "密码",
    }
}

/// `~` 展开到用户主目录(load_secret_key 不展开)。
fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        if !home.is_empty() {
            return format!("{home}{}{rest}", std::path::MAIN_SEPARATOR);
        }
    }
    p.to_string()
}

async fn authenticate(
    handle: &mut Handle<HostKeyChecker>,
    user: &str,
    auth: &SshAuthRecord,
) -> Result<bool, String> {
    match auth {
        SshAuthRecord::Password { password } => {
            let r = handle
                .authenticate_password(user, password.clone())
                .await
                .map_err(|e| e.to_string())?;
            Ok(r.success())
        }
        SshAuthRecord::Key { key_path } => {
            let key = load_secret_key(expand_tilde(key_path), None)
                .map_err(|e| format!("读取密钥 {key_path} 失败: {e}"))?;
            let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
            let r = handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| e.to_string())?;
            Ok(r.success())
        }
        SshAuthRecord::Agent => {
            // Windows=Pageant 命名管道,其余=SSH_AUTH_SOCK;逐身份尝试
            #[cfg(windows)]
            let mut agent = AgentClient::connect_pageant()
                .await
                .map_err(|e| format!("无法连接 SSH Agent(Pageant): {e}"))?;
            #[cfg(not(windows))]
            let mut agent = AgentClient::connect_env()
                .await
                .map_err(|e| format!("无法连接 SSH Agent(SSH_AUTH_SOCK): {e}"))?;
            let identities = agent
                .request_identities()
                .await
                .map_err(|e| format!("Agent 列举身份失败: {e}"))?;
            if identities.is_empty() {
                return Err("SSH Agent 中没有可用密钥(先 ssh-add)".into());
            }
            for id in identities {
                let pk = id.public_key().clone().into_owned();
                let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
                if handle
                    .authenticate_publickey_with(user, pk, hash, &mut agent)
                    .await
                    .map_err(|e| e.to_string())?
                    .success()
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

// ===== 命令循环 =====

/// 命令循环:路由会话级命令到实例任务。连接级错误 → 标 dead + 关全部实例。
async fn command_loop(
    handle: Handle<HostKeyChecker>,
    record: SshHostRecord,
    cmd_rx: &mut tokio::sync::mpsc::UnboundedReceiver<SshCommand>,
    dead: Arc<AtomicBool>,
) {
    let mut instances: HashMap<String, tokio::sync::mpsc::UnboundedSender<InstanceCmd>> = HashMap::new();
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SshCommand::Open { instance, shared, reply } => {
                let r = match handle.channel_open_session().await {
                    Ok(mut channel) => match open_pty_shell(&mut channel).await {
                        Ok(()) => {
                            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                            tokio::spawn(instance_task(channel, shared, rx));
                            instances.insert(instance.clone(), tx);
                            tracing::info!(
                                "SSH 实例就绪 {} :: {} ({}@{}:{})",
                                record.id,
                                instance,
                                record.username,
                                record.host,
                                record.port
                            );
                            Ok(())
                        }
                        Err(e) => Err(format!("请求 PTY/shell 失败: {e}")),
                    },
                    Err(e) => Err(format!("打开通道失败: {e}")),
                };
                let failed = r.is_err();
                let _ = reply.send(r);
                if failed && handle.is_closed() {
                    break; // 连接已死 → 走统一收尾
                }
            }
            SshCommand::Write { instance, data, reply } => {
                match instances.get(&instance) {
                    Some(tx) => {
                        if tx.send(InstanceCmd::Data(data, reply)).is_err() {
                            instances.remove(&instance); // 实例任务已退:清理映射
                        }
                    }
                    None => {
                        // 实例不在(已断开):直接回执错误,别让写侧等满 4s
                        let _ = reply.send(Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            format!("SSH 实例 {instance} 不在本会话(已断开?)"),
                        )));
                    }
                }
            }
            SshCommand::CloseInstance { instance } => {
                instances.remove(&instance); // drop tx → 实例任务收尾
            }
            SshCommand::Resize { instance, cols, rows } => {
                if let Some(tx) = instances.get(&instance) {
                    let _ = tx.send(InstanceCmd::Resize(cols, rows));
                }
            }
        }
    }
    // 统一收尾:命令通道关闭(会话被重建/进程退出)或连接死亡
    dead.store(true, Ordering::Release);
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "bye", "Serial Studio")
        .await;
}

/// 请求 PTY(80×24 初始,后续 resize 跟随) + 交互 shell。
async fn open_pty_shell(channel: &mut Channel<client::Msg>) -> Result<(), russh::Error> {
    channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await?;
    channel.request_shell(true).await?;
    Ok(())
}

/// 实例任务:独占 Channel。写/resize 经 InstanceCmd(select 内不触碰 channel,
/// 借用无冲突);通道数据 → shared.push;通道结束/命令源消失 → shared 置 closed。
async fn instance_task(
    mut channel: Channel<client::Msg>,
    shared: Arc<SshSharedIo>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<InstanceCmd>,
) {
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let closer = |done: &AtomicBool| {
        // 幂等:首个关闭原因生效
        if !done.swap(true, Ordering::AcqRel) {
            shared.close_with_error(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "SSH 会话已结束",
            ));
        }
    };
    loop {
        let cmd = tokio::select! {
            biased;
            c = rx.recv() => match c {
                Some(c) => c,
                None => break, // 命令源消失(实例关闭) → 收尾
            },
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        shared.push(&data);
                        continue;
                    }
                    Some(_) => continue, // XonXoff / ExitStatus 等控制消息,忽略
                    None => break, // 通道关闭(Eof/Close/断连)
                }
            }
        };
        // select 之外串行执行 channel 写——&mut 借用无冲突
        match cmd {
            InstanceCmd::Data(data, reply) => {
                let r = channel
                    .data_bytes(data)
                    .await
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::ConnectionReset, e.to_string()));
                let _ = reply.send(r);
            }
            InstanceCmd::Resize(cols, rows) => {
                let _ = channel.window_change(cols, rows, 0, 0).await;
            }
        }
    }
    closer(&done);
}

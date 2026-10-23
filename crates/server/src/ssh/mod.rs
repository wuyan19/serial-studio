//! SSH 设备管理层：注册表 + 每主机会话池 + 对 core 的 PortOpener 路由。
//!
//! 抽象定位:与 `device/`(远程 ss 设备)平行的**第二种非本机端口来源**——
//! "一台 SSH 设备 = 一个可寻址的端口提供方"(CLAUDE.md 的设备抽象),端点/实例是
//! 它的端口名。`CompositeOpener` 按复合键首段路由:本机 → serial,SSH 注册表 id →
//! 本模块,其余 → DeviceClientManager。会话懒建(首次 open 才连)、断连即弃
//! (dead 标记,下次 open 重建)——不常驻重连,与远程设备层的 eager 模式有意不同
//! (SSH 有认证开销且无需远端枚举)。
//!
//! 模块划分:
//! - `store.rs`   注册表/已知指纹持久化(ssh_hosts.json / ssh_known_hosts.json)
//! - `session.rs` 单主机 russh 连接:认证、命令循环、实例任务(PTY channel)
//! - `port_io.rs` PortIo 桥接(推→拉缓冲 + 命令通道写,镜像 device/port_io.rs)
//! - 本文件      管理器门面:注册表同步、会话池、open_blocking(CompositeOpener 入口)、
//!   实例键分配(纯函数)

pub mod port_io;
pub mod session;
pub mod store;

pub use session::auth_label as auth_label_of;
pub use store::{SshAuthRecord, SshEndpointRecord, SshHostRecord};

use serde::{Deserialize, Serialize};
use ss_core::{PortIo, SerialConfig, SerialError};
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use port_io::{SshPortIo, SshSharedIo};
use session::{run_session, SshCommand, SshSession};

fn compose_key(host_id: &str, name: &str) -> String {
    format!("{host_id}{}{name}", ss_core::PORT_KEY_SEP)
}

/// 分类错误 → SerialError::OpenFailed(message=文案,detail=JSON)。
fn open_failed(instance: &str, e: SshOpenError) -> SerialError {
    SerialError::OpenFailed {
        port: instance.to_string(),
        message: e.message(),
        detail: Some(e.to_detail()),
    }
}

/// open 命令回执等待上限:覆盖 连接(15s) + 通道/PTY 建立。
const OPEN_REPLY_TIMEOUT: Duration = Duration::from_secs(20);

/// SSH open 失败的结构化分类(线格式 tag=kind/字段 camelCase,前端据此弹对应交互:
/// auth_failed → 重输密码闭环;host_key_unknown → 首连指纹确认;
/// host_key_changed → 红色警告确认)。经 SerialError::OpenFailed.detail(JSON 文本)
/// 穿越 core,server 层回执时解析为 ServerMsg::Error.ssh 字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SshOpenError {
    /// 认证失败(密码错/密钥不被接受)。method = 设备配置的认证方式。
    AuthFailed { method: String },
    /// 首连:服务器指纹未登记(需用户确认后 ssh_trust_host 记录再重开)。
    HostKeyUnknown {
        fingerprint: String,
        key_type: String,
    },
    /// 指纹变更(合法重装或中间人——由用户核对决断,UI 走严重警告样式)。
    HostKeyChanged {
        known: String,
        received: String,
        key_type: String,
    },
    /// 其它失败(网络/超时/通道)——freeform 文本,前端按普通错误 toast。
    Other { message: String },
}

impl SshOpenError {
    /// 人类可读文案(SerialError::OpenFailed.message 用;日志/Telnet/MCP 消费)。
    pub fn message(&self) -> String {
        match self {
            SshOpenError::AuthFailed { method } => format!("认证失败(方式={method})"),
            SshOpenError::HostKeyUnknown { fingerprint, key_type } => {
                format!("首次连接,服务器指纹未确认({key_type} {fingerprint})")
            }
            SshOpenError::HostKeyChanged { known, received, key_type } => format!(
                "服务器指纹已变更({key_type}):已信任 {known},现收到 {received}——若非你方重装请勿继续"
            ),
            SshOpenError::Other { message } => message.clone(),
        }
    }

    /// 构造 Other 变体的便捷方法。
    pub fn into_freeform(message: String) -> Self {
        SshOpenError::Other { message }
    }

    /// detail 字段编码(core 的 OpenFailed 只收不透明 JSON 字符串)。
    pub fn to_detail(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// detail 字段解码(server 回执侧)。
    pub fn from_detail(json: &str) -> Option<Self> {
        serde_json::from_str(json).ok()
    }
}

/// SSH 设备管理器。挂在 AppState(跨 ServiceSupervisor 热重启保留)。
pub struct SshManager {
    /// 内存权威注册表(构造时读盘;save/remove 后同步)。
    registry: Mutex<Vec<SshHostRecord>>,
    /// hostId → 会话(懒建;dead 会话在下次 open 时替换)。
    sessions: Mutex<Vec<(String, Arc<SshSession>)>>,
    /// 实例别名(运行时,内存):实例全键 → 别名。实例是运行时产物,别名随实例
    /// 生灭——关闭/断开即失,不落盘(区别于端点定义别名,后者在注册表)。
    instance_aliases: Mutex<std::collections::HashMap<String, String>>,
}

impl SshManager {
    /// 读 ssh_hosts.json 构造(生产组装点)。
    pub fn from_registry() -> Self {
        Self {
            registry: Mutex::new(
                store::load()
                    .into_iter()
                    .map(store::ensure_default_endpoints)
                    .collect(),
            ),
            sessions: Mutex::new(Vec::new()),
            instance_aliases: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 空管理器(测试)。
    pub fn empty() -> Self {
        Self {
            registry: Mutex::new(Vec::new()),
            sessions: Mutex::new(Vec::new()),
            instance_aliases: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 全量替换注册表(ssh_save 后调用)。端点缺失兜底默认 shell。
    /// 变更/删除的设备同步终结其活会话——否则 ensure_session 持续返回旧连接,
    /// 新终端静默挂在旧 host/凭据上直到连接碰巧死亡。
    pub fn update_registry(&self, list: Vec<SshHostRecord>) {
        let new_list: Vec<SshHostRecord> = list
            .into_iter()
            .map(store::ensure_default_endpoints)
            .collect();
        // 三把锁各自独立短持,不嵌套(与读路径的加锁顺序无交叉)
        let old: std::collections::HashMap<String, SshHostRecord> = self
            .registry
            .lock()
            .unwrap()
            .iter()
            .map(|r| (r.id.clone(), r.clone()))
            .collect();
        let changed_or_removed: std::collections::HashSet<&String> = old
            .iter()
            .filter(|(id, r)| new_list.iter().all(|n| &n.id != *id || n != *r))
            .map(|(id, _)| id)
            .collect();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|(id, s)| {
            if changed_or_removed.contains(id) {
                let _ = s.cmd_tx.send(SshCommand::Shutdown);
                tracing::info!("SSH 设备 {} 记录已变更/删除,终结既有会话", id);
                false
            } else {
                true
            }
        });
        drop(sessions);
        *self.registry.lock().unwrap() = new_list;
    }

    /// 注册表快照(list 合并 / WS ssh_list / 路由判定用)。
    pub fn registry_snapshot(&self) -> Vec<SshHostRecord> {
        self.registry.lock().unwrap().clone()
    }

    /// 复合键首段是否为已注册 SSH 设备(CompositeOpener 路由判定)。
    pub fn has_host(&self, host_id: &str) -> bool {
        self.registry
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.id == host_id)
    }

    /// 注册表全部设备昵称(撞词检查用)。
    pub fn registry_nicknames(&self) -> Vec<String> {
        self.registry
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| {
                r.nickname
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
            })
            .map(str::to_string)
            .collect()
    }

    /// 设备昵称查询(AddressResolver::nickname_of 双来源之一)。
    pub fn nickname_of(&self, dev_id: &str) -> Option<String> {
        self.registry
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.id == dev_id)
            .and_then(|r| r.nickname.as_deref())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
    }

    /// 设备昵称 → id 列表(AddressResolver 首段甄别;与 DeviceClientManager 同构)。
    pub fn ids_by_nickname(&self, nick: &str) -> Vec<String> {
        self.registry
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.nickname.as_deref().map(str::trim) == Some(nick))
            .map(|r| r.id.clone())
            .collect()
    }

    /// 注册表端点+内存实例别名的快照(AddressResolver 索引构建用)。
    /// 返回 (别名, 完整键) 对;实例别名是运行时的,随 rebuild 周期可见。
    pub fn alias_pairs(&self) -> Vec<(String, String)> {
        let reg = self.registry.lock().unwrap();
        let inst = self.instance_aliases.lock().unwrap();
        let mut pairs: Vec<(String, String)> = reg
            .iter()
            .flat_map(|r| {
                r.endpoints.iter().filter_map(|ep| {
                    ep.alias
                        .as_ref()
                        .map(|a| (a.clone(), compose_key(&r.id, &ep.name)))
                })
            })
            .collect();
        pairs.extend(inst.iter().map(|(k, a)| (a.clone(), k.clone())));
        pairs
    }

    /// 各设备端点真实名集合(小写)——别名"真实名恒优先"判据(AddressResolver 用)。
    pub fn device_real_leaves(
        &self,
    ) -> std::collections::HashMap<String, std::collections::HashSet<String>> {
        self.registry
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r.id.clone(),
                    r.endpoints.iter().map(|e| e.name.to_lowercase()).collect(),
                )
            })
            .collect()
    }

    /// 实例别名查询(list 合并注入)。
    pub fn instance_alias_of(&self, instance_full_key: &str) -> Option<String> {
        self.instance_aliases
            .lock()
            .unwrap()
            .get(instance_full_key)
            .cloned()
    }

    /// 设置别名(端点优先,实例兜底)。端点命中写注册表(落盘);实例命中写内存表
    /// (运行时生灭)。二者都 miss 时报错(调用方 set_alias_and_notify 的 ssh 分支)。
    pub fn set_ssh_alias(
        &self,
        host_id: &str,
        name: &str,
        alias: Option<String>,
    ) -> Result<bool, String> {
        let trimmed = alias
            .filter(|a| !a.trim().is_empty())
            .map(|a| a.trim().to_string());
        // 先试端点(注册表)
        {
            let mut list = self.registry.lock().unwrap().clone();
            if let Some(rec) = list.iter_mut().find(|r| r.id == host_id) {
                if let Some(ep) = rec.endpoints.iter_mut().find(|e| e.name == name) {
                    ep.alias = trimmed.clone();
                    store::save(&list)?;
                    *self.registry.lock().unwrap() = list;
                    return Ok(true);
                }
            }
        }
        // 再试实例(内存)
        let key = compose_key(host_id, name);
        let mut inst = self.instance_aliases.lock().unwrap();
        match trimmed {
            Some(a) => {
                inst.insert(key, a);
                Ok(true)
            }
            None => {
                inst.remove(&key);
                Ok(true) // 清除别名幂等成功(不存在也 OK)
            }
        }
    }

    /// CompositeOpener 入口(同步阻塞,manager 的 spawn_blocking 里调)。
    /// `rest` = 端点名或实例名(shell / shell@2);全键 `${hostId}::${rest}` 是命令路由键。
    pub fn open_blocking(
        &self,
        host_id: &str,
        rest: &str,
        config: &SerialConfig,
    ) -> Result<Box<dyn PortIo>, SerialError> {
        let record = self
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == host_id)
            .ok_or_else(|| SerialError::NotFound(format!("{host_id}::{rest}")))?;
        // 端点校验:实例名剥 @N 后必须是已定义端点
        let base = rest.split('@').next().unwrap_or(rest);
        if !record.endpoints.iter().any(|e| e.name == base) {
            return Err(open_failed(
                &format!("{host_id}::{rest}"),
                SshOpenError::into_freeform(format!("SSH 设备 {} 没有端点 {base}", record.label())),
            ));
        }
        let instance = format!("{host_id}::{rest}");
        let session = self.ensure_session(&record);

        let shared = Arc::new(SshSharedIo::new(port_io::read_timeout_of(config)));
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), SshOpenError>>();
        session
            .cmd_tx
            .send(SshCommand::Open {
                instance: instance.clone(),
                shared: Arc::clone(&shared),
                reply: reply_tx,
            })
            .map_err(|_| {
                open_failed(
                    &instance,
                    SshOpenError::into_freeform("SSH 会话任务已退出".into()),
                )
            })?;
        // 分片等待:每 200ms 检查 dead(连接失败快速失败,不等满 20s)。deadline 兜底。
        let deadline = std::time::Instant::now() + OPEN_REPLY_TIMEOUT;
        loop {
            match reply_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(())) => {
                    return Ok(Box::new(SshPortIo::new(
                        shared,
                        session.cmd_tx.clone(),
                        instance,
                    )))
                }
                Ok(Err(e)) => {
                    if session.dead.load(Ordering::Acquire) {
                        self.drop_session(host_id); // 连接级失败:清池,下次重建
                    }
                    return Err(open_failed(&instance, e));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if session.dead.load(Ordering::Acquire) {
                        self.drop_session(host_id);
                        return Err(open_failed(
                            &instance,
                            SshOpenError::into_freeform(
                                "SSH 连接失败(不可达或握手错误,详见服务端日志)".into(),
                            ),
                        ));
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(open_failed(
                            &instance,
                            SshOpenError::into_freeform(format!(
                                "打开超时({}秒)",
                                OPEN_REPLY_TIMEOUT.as_secs()
                            )),
                        ));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(open_failed(
                        &instance,
                        SshOpenError::into_freeform("SSH 会话任务退出(回执通道关闭)".into()),
                    ));
                }
            }
        }
    }

    /// 信任服务器指纹(确认弹窗的"信任并连接"):直连一次,记录指纹即断,不动会话池。
    /// 返回记录的指纹(供 UI 回显)。
    pub fn trust_host_key_blocking(&self, host_id: &str) -> Result<String, String> {
        let rec = self
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == host_id)
            .ok_or_else(|| format!("未知 SSH 设备: {host_id}"))?;
        session::trust_host_key(rec)
    }

    /// PTY 尺寸变更(WS resize 动作 → 这里)。找不到会话/实例则静默(幂等)。
    pub fn resize_blocking(&self, host_id: &str, rest: &str, cols: u32, rows: u32) {
        let sessions = self.sessions.lock().unwrap().clone();
        if let Some(s) = sessions.iter().find(|(id, _)| id == host_id) {
            let _ = s.1.cmd_tx.send(SshCommand::Resize {
                instance: format!("{host_id}::{rest}"),
                cols,
                rows,
            });
        }
    }

    /// 取活会话;没有/已死则 spawn 新任务(russh 连接在任务内异步进行,命令排队)。
    /// 须在 tokio 上下文调用(spawn_blocking 内满足)。
    fn ensure_session(&self, record: &SshHostRecord) -> Arc<SshSession> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.iter().find(|(id, _)| id == &record.id) {
            if !s.1.dead.load(Ordering::Acquire) {
                return Arc::clone(&s.1);
            }
            sessions.retain(|(id, _)| id != &record.id); // 死会话清池
        }
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let dead = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = Arc::new(SshSession {
            cmd_tx: cmd_tx.clone(),
            dead: Arc::clone(&dead),
        });
        let rt = tokio::runtime::Handle::current();
        rt.spawn(run_session(record.clone(), cmd_rx, dead));
        sessions.push((record.id.clone(), Arc::clone(&session)));
        session
    }

    fn drop_session(&self, host_id: &str) {
        self.sessions
            .lock()
            .unwrap()
            .retain(|(id, _)| id != host_id);
    }
}

/// 实例键分配(纯函数,WS `ssh_next_instance` 用):给定该设备已占用的**全键**集合,
/// 返回下一个空闲实例的裸名。base 空闲 → base;否则取 `{base}@{n}` 最小空闲 n。
/// 取空闲而非单调递增:关掉 @2 后再新建复用 @2,避免长期运行序号无界增长
/// (与 UI 预览的"只增"略有差异——tab 已关即无混淆对象,复用无害)。
pub fn next_instance_key(host_id: &str, base: &str, occupied_full_keys: &[String]) -> String {
    let base_key = format!("{host_id}{}{base}", ss_core::PORT_KEY_SEP);
    let taken: HashSet<&str> = occupied_full_keys
        .iter()
        .filter(|k| {
            k.starts_with(&base_key)
                && k.len() > base_key.len()
                && k.as_bytes()[base_key.len()] == b'@'
        })
        .map(|k| ss_core::split_port_key(k).1)
        .collect();
    if !occupied_full_keys.contains(&base_key) {
        return base.to_string();
    }
    let mut n = 2u32;
    let mut cand = format!("{base}@{n}");
    while taken.contains(cand.as_str()) {
        n += 1;
        cand = format!("{base}@{n}");
    }
    cand
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn next_instance_first_is_base() {
        assert_eq!(next_instance_key("h", "shell", &[]), "shell");
        assert_eq!(
            next_instance_key("h", "shell", &[key("other::shell"), key("h::COM5")]),
            "shell"
        );
    }

    #[test]
    fn next_instance_appends_smallest_free() {
        let occ = vec![key("h::shell"), key("h::shell@2"), key("h::shell@3")];
        assert_eq!(next_instance_key("h", "shell", &occ), "shell@4");
        // 关掉 @2 → 复用最小空闲
        let occ = vec![key("h::shell"), key("h::shell@3")];
        assert_eq!(next_instance_key("h", "shell", &occ), "shell@2");
    }

    #[test]
    fn next_instance_ignores_other_hosts() {
        let occ = vec![key("h2::shell"), key("h2::shell@2"), key("h::shell")];
        assert_eq!(next_instance_key("h", "shell", &occ), "shell@2");
    }

    /// open 端点校验:未定义端点 → OpenFailed(注册表语义,不碰网络)。
    #[test]
    fn open_unknown_endpoint_rejected() {
        let m = SshManager::empty();
        m.update_registry(vec![SshHostRecord {
            id: "h1".into(),
            host: "192.0.2.1".into(),
            port: 22,
            username: "root".into(),
            nickname: None,
            auth: SshAuthRecord::Agent,
            endpoints: vec![SshEndpointRecord {
                name: "shell".into(),
                r#type: "shell".into(),
                alias: None,
            }],
        }]);
        let err = match m.open_blocking("h1", "exec:foo", &SerialConfig::default()) {
            Ok(_) => panic!("未定义端点应报错"),
            Err(e) => e,
        };
        assert!(matches!(err, SerialError::OpenFailed { .. }), "{err:?}");
        // 未知设备 → NotFound(CompositeOpener 路由前的兜底语义)
        let err = match m.open_blocking("nope", "shell", &SerialConfig::default()) {
            Ok(_) => panic!("未知设备应报错"),
            Err(e) => e,
        };
        assert!(matches!(err, SerialError::NotFound { .. }));
    }
}

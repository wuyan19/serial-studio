//! Local policy and short-lived credentials for protected remote connections.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use uuid::Uuid;

const MAX_SESSION_AGE: Duration = Duration::from_secs(8 * 60 * 60);
const MAX_SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
const ATTEMPT_WINDOW: Duration = Duration::from_secs(60);
const SOURCE_ATTEMPTS: u8 = 5;
const TOTAL_ATTEMPTS: u8 = 30;
const MAX_SESSIONS: usize = 128;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessScope {
    #[default]
    All,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AccessTarget {
    Ssh { id: String },
    Serial { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessConfig {
    pub enabled: bool,
    #[serde(default)]
    pub allow_http: bool,
    #[serde(default)]
    pub scope: AccessScope,
    #[serde(default)]
    pub targets: Vec<AccessTarget>,
    #[serde(default = "default_refresh")]
    pub refresh_minutes: u16,
    #[serde(default = "default_tls_port")]
    pub tls_port: u16,
    #[serde(default)]
    pub tls_cert: String,
    #[serde(default)]
    pub tls_key: String,
}

fn default_refresh() -> u16 {
    5
}

fn default_tls_port() -> u16 {
    18702
}

impl Default for AccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_http: false,
            scope: AccessScope::All,
            targets: Vec::new(),
            refresh_minutes: default_refresh(),
            tls_port: default_tls_port(),
            tls_cert: String::new(),
            tls_key: String::new(),
        }
    }
}

impl AccessConfig {
    pub fn https_available(&self) -> bool {
        self.enabled && !self.tls_cert.trim().is_empty() && !self.tls_key.trim().is_empty()
    }

    pub(crate) fn allows_verification(&self, secure: bool) -> bool {
        self.enabled && (secure || self.allow_http)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(1..=10).contains(&self.refresh_minutes) {
            return Err("验证码有效期必须为 1–10 分钟".into());
        }
        if self.tls_port == 0 {
            return Err("HTTPS 端口不能为 0".into());
        }
        let cert = !self.tls_cert.trim().is_empty();
        let key = !self.tls_key.trim().is_empty();
        if self.enabled && ((!self.allow_http && !cert) || cert != key) {
            return Err("开启远程访问验证前，请配置 HTTPS 证书和私钥".into());
        }
        if self.enabled && self.scope == AccessScope::Selected && self.targets.is_empty() {
            return Err("请至少选择一个受保护的连接".into());
        }
        if self.targets.iter().any(|target| match target {
            AccessTarget::Ssh { id } | AccessTarget::Serial { id } => id.trim().is_empty(),
        }) {
            return Err("受保护的连接标识不能为空".into());
        }
        Ok(())
    }

    pub fn protects(&self, canonical_port: &str) -> bool {
        if !self.enabled {
            return false;
        }
        if self.scope == AccessScope::All {
            return true;
        }
        self.targets.iter().any(|target| match target {
            AccessTarget::Ssh { id } => canonical_port
                .strip_prefix(id)
                .is_some_and(|rest| rest.starts_with(ss_core::PORT_KEY_SEP)),
            AccessTarget::Serial { id } => {
                let (owner, name) = serial_route(id);
                let (port_owner, port_name) = serial_route(canonical_port);
                owner == port_owner && name.eq_ignore_ascii_case(port_name)
            }
        })
    }
}

fn serial_route(key: &str) -> (&str, &str) {
    let key = key.strip_prefix("local::").unwrap_or(key);
    let (owner, name) = key.rsplit_once(ss_core::PORT_KEY_SEP).unwrap_or(("", key));
    // macOS exposes both callout and dial-in paths for the same serial device.
    let name = name
        .strip_prefix("/dev/cu.")
        .or_else(|| name.strip_prefix("/dev/tty."))
        .or_else(|| name.strip_prefix(r"\\.\"))
        .unwrap_or(name);
    (owner, name)
}

#[derive(Serialize)]
pub struct AccessStatus {
    pub config: AccessConfig,
    pub code: Option<String>,
    pub expires_in: u64,
    pub session_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    Disabled,
    InvalidCode,
    RateLimited,
    Capacity,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Disabled => "远程访问验证未启用",
            Self::InvalidCode => "验证码无效或已过期",
            Self::RateLimited => "验证尝试过多，请稍后再试",
            Self::Capacity => "远程授权会话已达上限",
        })
    }
}

impl std::error::Error for VerifyError {}

struct Code {
    digits: String,
    expires_at: Instant,
}

struct Session {
    secure: bool,
    started: Instant,
    active: Instant,
}

impl Session {
    fn valid(&self, now: Instant) -> bool {
        now.duration_since(self.started) < MAX_SESSION_AGE
            && now.duration_since(self.active) < MAX_SESSION_IDLE
    }
}

struct AttemptWindow {
    start: Instant,
    count: u8,
}

struct Runtime {
    config: AccessConfig,
    code: Option<Code>,
    sessions: HashMap<String, Session>,
    source_attempts: HashMap<IpAddr, AttemptWindow>,
    total_attempts: AttemptWindow,
}

impl Runtime {
    fn new(config: AccessConfig) -> Self {
        Self {
            config,
            code: None,
            sessions: HashMap::new(),
            source_attempts: HashMap::new(),
            total_attempts: AttemptWindow {
                start: Instant::now(),
                count: 0,
            },
        }
    }

    fn rotate(&mut self, now: Instant) {
        self.code = self.config.enabled.then(|| Code {
            digits: new_code(self.code.as_ref().map(|code| code.digits.as_str())),
            expires_at: now + Duration::from_secs(u64::from(self.config.refresh_minutes) * 60),
        });
    }

    fn refresh(&mut self, now: Instant) {
        if self.config.enabled && self.code.as_ref().is_none_or(|code| code.expires_at <= now) {
            self.rotate(now);
        }
        self.sessions.retain(|_, session| session.valid(now));
    }

    fn status(&mut self, now: Instant) -> AccessStatus {
        self.refresh(now);
        AccessStatus {
            config: self.config.clone(),
            code: self.code.as_ref().map(|code| code.digits.clone()),
            expires_in: self.code.as_ref().map_or(0, |code| {
                code.expires_at
                    .saturating_duration_since(now)
                    .as_millis()
                    .div_ceil(1000) as u64
            }),
            session_count: self.sessions.len(),
        }
    }

    fn check_attempt_limit(&mut self, peer: IpAddr, now: Instant) -> Result<(), VerifyError> {
        if now.duration_since(self.total_attempts.start) >= ATTEMPT_WINDOW {
            self.total_attempts = AttemptWindow {
                start: now,
                count: 0,
            };
        }
        self.source_attempts
            .retain(|_, entry| now.duration_since(entry.start) < ATTEMPT_WINDOW);
        if self.total_attempts.count >= TOTAL_ATTEMPTS
            || self
                .source_attempts
                .get(&peer)
                .is_some_and(|entry| entry.count >= SOURCE_ATTEMPTS)
        {
            return Err(VerifyError::RateLimited);
        }
        Ok(())
    }

    fn record_failure(&mut self, peer: IpAddr, now: Instant) {
        self.total_attempts.count += 1;
        self.source_attempts
            .entry(peer)
            .or_insert(AttemptWindow {
                start: now,
                count: 0,
            })
            .count += 1;
    }
}

fn new_code(previous: Option<&str>) -> String {
    const RANGE: u64 = 100_000_000;
    const LIMIT: u64 = (1_u64 << 32) / RANGE * RANGE;
    loop {
        // UUID v4 bytes 0–3 contain only randomness; rejection avoids modulo bias.
        let random = Uuid::new_v4();
        let bytes = random.as_bytes();
        let sample = u64::from(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
        if sample < LIMIT {
            let code = format!("{:08}", sample % RANGE);
            if Some(code.as_str()) != previous {
                return code;
            }
        }
    }
}

fn codes_equal(expected: &str, given: &str) -> bool {
    expected.len() == given.len()
        && expected
            .bytes()
            .zip(given.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}

pub struct AccessControl {
    state: Mutex<Runtime>,
    changes: watch::Sender<u64>,
    storage: PolicyStorage,
}

enum PolicyStorage {
    Memory,
    File(PathBuf),
    Unavailable,
}

impl Default for AccessControl {
    fn default() -> Self {
        Self::new(AccessConfig::default(), PolicyStorage::Memory)
    }
}

impl AccessControl {
    fn new(config: AccessConfig, storage: PolicyStorage) -> Self {
        Self {
            state: Mutex::new(Runtime::new(config)),
            changes: watch::channel(0).0,
            storage,
        }
    }

    pub fn load() -> Self {
        Self::load_from(crate::config::config_dir().map(|dir| dir.join("remote-access.json")))
    }

    fn load_from(path: Option<PathBuf>) -> Self {
        let config = match path.as_deref().map(read_config) {
            Some(Ok(config)) => config,
            Some(Err(err)) => {
                tracing::error!(%err, "Unable to read remote access policy; blocking legacy remote access");
                AccessConfig {
                    enabled: true,
                    ..AccessConfig::default()
                }
            }
            None => {
                tracing::error!(
                    "Unable to locate configuration directory; blocking legacy remote access"
                );
                AccessConfig {
                    enabled: true,
                    ..AccessConfig::default()
                }
            }
        };
        Self::new(
            config,
            path.map_or(PolicyStorage::Unavailable, PolicyStorage::File),
        )
    }

    pub fn config(&self) -> AccessConfig {
        self.state.lock().unwrap().config.clone()
    }

    pub fn configure(&self, config: AccessConfig) -> Result<(), String> {
        config.validate()?;
        let mut state = self.state.lock().unwrap();
        match &self.storage {
            PolicyStorage::File(path) => write_config(path, &config)?,
            PolicyStorage::Unavailable => return Err("无法定位远程访问验证配置目录".into()),
            PolicyStorage::Memory => {}
        }
        if config != state.config {
            state.config = config;
            state.rotate(Instant::now());
            state.sessions.clear();
            self.bump_revision();
        }
        Ok(())
    }

    pub fn status(&self) -> AccessStatus {
        self.state.lock().unwrap().status(Instant::now())
    }

    pub fn rotate_code(&self) -> AccessStatus {
        let mut state = self.state.lock().unwrap();
        let now = Instant::now();
        state.rotate(now);
        state.status(now)
    }

    pub fn revision(&self) -> u64 {
        *self.changes.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn bump_revision(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub fn revoke_all(&self) {
        let mut state = self.state.lock().unwrap();
        state.sessions.clear();
        state.rotate(Instant::now());
        self.bump_revision();
    }

    pub fn revoke(&self, token: &str) {
        let mut state = self.state.lock().unwrap();
        if state.sessions.remove(token).is_some() {
            // Wake connection tasks without invalidating unrelated sessions.
            self.changes.send_modify(|_| {});
        }
    }

    pub fn verify(&self, code: &str, peer: IpAddr, secure: bool) -> Result<String, VerifyError> {
        let mut state = self.state.lock().unwrap();
        if !state.config.allows_verification(secure) {
            return Err(VerifyError::Disabled);
        }
        let now = Instant::now();
        let peer = peer.to_canonical();
        state.check_attempt_limit(peer, now)?;
        state.refresh(now);
        if !state
            .code
            .as_ref()
            .is_some_and(|current| codes_equal(&current.digits, code))
        {
            state.record_failure(peer, now);
            return Err(VerifyError::InvalidCode);
        }
        if state.sessions.len() >= MAX_SESSIONS {
            return Err(VerifyError::Capacity);
        }
        state.rotate(now);
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        state.sessions.insert(
            token.clone(),
            Session {
                secure,
                started: now,
                active: now,
            },
        );
        Ok(token)
    }

    pub fn validate(&self, token: &str, touch: bool, secure: bool) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(session) = state.sessions.get_mut(token) else {
            return false;
        };
        let now = Instant::now();
        if !session.valid(now) {
            state.sessions.remove(token);
            return false;
        }
        if session.secure != secure {
            return false;
        }
        if touch {
            session.active = now;
        }
        true
    }

    pub fn protects(&self, canonical_port: &str) -> bool {
        self.state.lock().unwrap().config.protects(canonical_port)
    }

    pub fn blocked_all(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.config.enabled && state.config.scope == AccessScope::All
    }
}

fn read_config(path: &Path) -> Result<AccessConfig, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(AccessConfig::default()),
        Err(err) => return Err(err.to_string()),
    };
    let config: AccessConfig = serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
    config.validate()?;
    Ok(config)
}

fn write_config(path: &Path, config: &AccessConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|err| err.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| err.to_string())?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protected() -> AccessConfig {
        AccessConfig {
            enabled: true,
            tls_cert: "fixture.pem".into(),
            tls_key: "fixture-key.pem".into(),
            ..AccessConfig::default()
        }
    }

    #[test]
    fn selected_targets_match_canonical_routes() {
        let access = AccessControl::default();
        assert!(!access.protects("COM7"));
        access
            .configure(AccessConfig {
                scope: AccessScope::Selected,
                targets: vec![
                    AccessTarget::Ssh { id: "ssh-1".into() },
                    AccessTarget::Serial { id: "COM7".into() },
                    AccessTarget::Serial {
                        id: "remote::mac::/dev/cu.fixture".into(),
                    },
                ],
                ..protected()
            })
            .unwrap();
        assert!(access.protects("COM7"));
        assert!(access.protects("com7"));
        assert!(access.protects(r"\\.\COM7"));
        assert!(access.protects("remote::mac::/dev/tty.fixture"));
        assert!(access.protects("ssh-1::shell@2"));
        assert!(!access.protects("ssh-10::shell"));
        assert!(!access.protects("device::COM7"));
        assert!(!access.blocked_all());
    }

    #[test]
    fn codes_are_single_use_and_rotation_does_not_revoke_sessions() {
        let access = AccessControl::new(protected(), PolicyStorage::Memory);
        let peer = IpAddr::from([127, 0, 0, 1]);
        let code = access.status().code.unwrap();
        let token = access.verify(&code, peer, true).unwrap();
        assert_eq!(
            access.verify(&code, peer, true),
            Err(VerifyError::InvalidCode)
        );
        let revision = access.revision();
        access.rotate_code();
        assert_eq!(access.revision(), revision);
        assert!(access.validate(&token, true, true));
        access.revoke_all();
        assert_ne!(access.revision(), revision);
        assert!(!access.validate(&token, false, true));
    }

    #[test]
    fn failures_survive_code_rotation_and_ipv4_mapped_addresses_share_the_limit() {
        let access = AccessControl::new(protected(), PolicyStorage::Memory);
        let peer = IpAddr::from([127, 0, 0, 1]);
        for _ in 0..SOURCE_ATTEMPTS {
            assert_eq!(
                access.verify("bad", peer, true),
                Err(VerifyError::InvalidCode)
            );
        }
        let code = access.rotate_code().code.unwrap();
        assert_eq!(
            access.verify(&code, "::ffff:127.0.0.1".parse().unwrap(), true),
            Err(VerifyError::RateLimited)
        );
        assert!(access
            .verify(&code, IpAddr::from([127, 0, 0, 2]), true)
            .is_ok());
    }

    #[test]
    fn idle_and_absolute_deadlines_are_enforced() {
        let now = Instant::now();
        let session = Session {
            secure: true,
            started: now,
            active: now,
        };
        assert!(session.valid(now + MAX_SESSION_IDLE - Duration::from_secs(1)));
        assert!(!session.valid(now + MAX_SESSION_IDLE));
        let active_session = Session {
            secure: true,
            started: now,
            active: now + MAX_SESSION_AGE,
        };
        assert!(!active_session.valid(now + MAX_SESSION_AGE));
    }

    #[test]
    fn corrupt_policy_blocks_remote_access_and_never_persists_credentials() {
        let path = std::env::temp_dir().join(format!("ss-access-{}.json", Uuid::new_v4()));
        let access = AccessControl::load_from(Some(path.clone()));
        assert!(!access.config().enabled);
        access.configure(protected()).unwrap();
        let code = access.status().code.unwrap();
        let token = access
            .verify(&code, IpAddr::from([127, 0, 0, 1]), true)
            .unwrap();
        assert_eq!(read_config(&path).unwrap(), protected());
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, serde_json::to_value(protected()).unwrap());
        assert!(!AccessControl::load_from(Some(path.clone())).validate(&token, false, true));
        std::fs::write(&path, "{}").unwrap();
        assert!(AccessControl::load_from(Some(path.clone())).blocked_all());
        std::fs::remove_file(path).unwrap();
    }
}

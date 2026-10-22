//! SSH 设备注册表持久化：配置目录 ssh_hosts.json + known_hosts.json。
//!
//! 与 remotes_store 同构：进程内锁串行化 fs、损坏回退空、全量覆盖写。
//! 字段 serde 用 camelCase 与前端 TS `SshHost` 对齐（WS 线上 JSON 直通）。
//! 凭据（密码/密钥路径）存于此文件——明文落盘是设计决策（见 docs/ssh-support-design.md
//! 的安全边界），UI 有明示；后续可升级系统 keychain。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 进程内串行化所有 ssh_hosts.json / known_hosts.json 的 fs 访问。
static LOCK: Mutex<()> = Mutex::new(());

/// 认证方式（判别联合，线上 tag="type"、字段 camelCase——与前端 TS 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum SshAuthRecord {
    Key { key_path: String },
    Agent,
    Password { password: String },
}

/// 端点定义：设备上一个可打开的会话目标（v1 仅 shell）。
/// alias 由 set_alias_and_notify 的 ssh 分支写入（与串口别名同一入口）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshEndpointRecord {
    pub name: String,
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

/// 一台 SSH 设备（注册表条目）。id 即复合键首段（devId）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshHostRecord {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub auth: SshAuthRecord,
    #[serde(default)]
    pub endpoints: Vec<SshEndpointRecord>,
}

impl SshHostRecord {
    /// 展示名：昵称优先，回退 user@host。
    pub fn label(&self) -> String {
        self.nickname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}@{}", self.username, self.host))
    }
}

/// 注册表兜底：端点缺失/为空时视作一个默认 shell（兼容手编文件与旧数据）。
pub fn ensure_default_endpoints(mut rec: SshHostRecord) -> SshHostRecord {
    if rec.endpoints.iter().all(|e| e.name.is_empty()) {
        rec.endpoints = vec![SshEndpointRecord {
            name: "shell".into(),
            r#type: "shell".into(),
            alias: None,
        }];
    }
    rec
}

fn hosts_file(dir: &Path) -> PathBuf {
    dir.join("ssh_hosts.json")
}

fn known_file(dir: &Path) -> PathBuf {
    dir.join("ssh_known_hosts.json")
}

/// 读 ssh_hosts.json（不存在/损坏 → 空）。
pub fn load() -> Vec<SshHostRecord> {
    let _g = LOCK.lock().expect("ssh store lock poisoned");
    crate::config::config_dir()
        .map(|d| {
            std::fs::read_to_string(hosts_file(&d))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

/// 全量写 ssh_hosts.json（内存权威整张覆盖，前端 save 全量）。
pub fn save(list: &[SshHostRecord]) -> Result<(), String> {
    let _g = LOCK.lock().expect("ssh store lock poisoned");
    let dir = crate::config::config_dir().ok_or("无法定位配置目录")?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(hosts_file(&dir), json).map_err(|e| format!("写入 ssh_hosts.json 失败: {e}"))
}

/// 已信任的服务器指纹表：`host:port` → `SHA256:...`（TOFU，见 session.rs）。
pub fn load_known_hosts() -> HashMap<String, String> {
    let _g = LOCK.lock().expect("ssh store lock poisoned");
    crate::config::config_dir()
        .map(|d| {
            std::fs::read_to_string(known_file(&d))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

fn save_known_hosts(map: &HashMap<String, String>) -> Result<(), String> {
    let dir = crate::config::config_dir().ok_or("无法定位配置目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(known_file(&dir), json).map_err(|e| format!("写入 ssh_known_hosts.json 失败: {e}"))
}

pub fn known_host_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 查询已信任指纹（None = 首次连接）。
pub fn known_fingerprint(host: &str, port: u16) -> Option<String> {
    let _g = LOCK.lock().expect("ssh store lock poisoned");
    load_known_hosts_locked().get(&known_host_key(host, port)).cloned()
}

/// 记住指纹（TOFU 首连 / 显式信任）。
pub fn remember_fingerprint(host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
    let _g = LOCK.lock().expect("ssh store lock poisoned");
    let mut map = load_known_hosts_locked();
    map.insert(known_host_key(host, port), fingerprint.to_string());
    save_known_hosts(&map)
}

fn load_known_hosts_locked() -> HashMap<String, String> {
    crate::config::config_dir()
        .map(|d| {
            std::fs::read_to_string(known_file(&d))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, host: &str, auth: SshAuthRecord) -> SshHostRecord {
        SshHostRecord {
            id: id.into(),
            host: host.into(),
            port: 22,
            username: "root".into(),
            nickname: None,
            auth,
            endpoints: vec![],
        }
    }

    /// 线上 JSON（前端 camelCase 口径）可无损反序列化——线协议契约。
    #[test]
    fn wire_camel_case_roundtrip() {
        let json = r#"{"id":"u1","host":"192.168.1.9","port":2222,"username":"pi","nickname":"网关","auth":{"type":"key","keyPath":"~/.ssh/id_ed25519"},"endpoints":[{"name":"shell","type":"shell","alias":"控制台"}]}"#;
        let r: SshHostRecord = serde_json::from_str(json).unwrap();
        assert_eq!(r.auth, SshAuthRecord::Key { key_path: "~/.ssh/id_ed25519".into() });
        assert_eq!(r.endpoints[0].alias.as_deref(), Some("控制台"));
        let back = serde_json::to_string(&r).unwrap();
        assert!(back.contains("\"keyPath\""), "序列化保持 camelCase: {back}");
    }

    #[test]
    fn password_auth_shape() {
        let json = r#"{"id":"u2","host":"h","port":22,"username":"a","auth":{"type":"password","password":"pw"}}"#;
        let r: SshHostRecord = serde_json::from_str(json).unwrap();
        assert_eq!(r.auth, SshAuthRecord::Password { password: "pw".into() });
        assert!(r.endpoints.is_empty(), "端点缺失走 ensure_default_endpoints 兜底");
        let fixed = ensure_default_endpoints(r);
        assert_eq!(fixed.endpoints[0].name, "shell");
    }

    #[test]
    fn label_prefers_nickname() {
        let mut r = rec("u3", "10.0.0.5", SshAuthRecord::Agent);
        assert_eq!(r.label(), "root@10.0.0.5");
        r.nickname = Some("车间网关".into());
        assert_eq!(r.label(), "车间网关");
    }
}

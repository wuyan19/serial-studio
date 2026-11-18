//! 被测设备注册表（devices.json）：设备 = 身份（一台被调试的机器），
//! 通道 = 接入方式，**通道携带完整接入配置**（P2.6"通道归设备"）——
//! 串口通道内联打开参数（波特率/校验/…），SSH 通道内联主机+认证（admin@ 与
//! support@ 是一台设备的两条通道）。
//!
//! SSH 凭据库（ssh.json）降级为连接层实现细节：设备保存时把 SSH 通道投影进
//! 凭据库（id 稳定 → 端口键 `sshUuid::shell` 跨编辑不变），用户不再直接管理。
//!
//! 校验闸门：设备名唯一；串口端口跨设备不共用；SSH id 与 host:port 跨设备
//! 不重复；SSH 字段完整性。占用粒度即设备级（见 lease.rs）。

use serde::{Deserialize, Serialize};
use ss_core::SerialConfig;
use ss_server::AppState;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// SSH 通道的完整配置（内联）。id 稳定（= 凭据库键/端口键首段）：编辑保留、
/// 新建生成——端口寻址与会话池跨编辑不漂移。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshChannelConfig {
    #[serde(default = "gen_uuid")]
    pub id: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub auth: ss_server::ssh::SshAuthRecord,
    /// 允许旧版 MAC（hmac-sha1）——只支持旧算法的老交换机才开（同
    /// serial-studio 的按主机开关，投影透传给凭据库/会话建立）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_legacy_mac: bool,
}

fn default_ssh_port() -> u16 {
    22
}
fn gen_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl SshChannelConfig {
    /// 测试夹具：按 id 造一条 Agent 认证的通道（lease/topology 测试用）。
    #[cfg(test)]
    pub fn ssh_fixture(id: &str) -> Self {
        Self {
            id: id.into(),
            host: "192.0.2.70".into(),
            port: 22,
            username: "root".into(),
            nickname: None,
            auth: ss_server::ssh::SshAuthRecord::Agent,
            allow_legacy_mac: false,
        }
    }

    /// 展示名：昵称回退 user@host。
    pub fn label(&self) -> String {
        self.nickname
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}@{}", self.username, self.host))
    }

    /// 投影为凭据库条目（端点固定默认 shell——v1 不做端点管理）。
    /// allow_legacy_mac 透传（老交换机兼容开关，与 serial-studio 同语义）。
    pub fn to_host_record(&self) -> ss_server::ssh::SshHostRecord {
        ss_server::ssh::SshHostRecord {
            allow_legacy_mac: self.allow_legacy_mac,
            id: self.id.clone(),
            host: self.host.trim().into(),
            port: self.port,
            username: self.username.trim().into(),
            nickname: self.nickname.clone().filter(|n| !n.trim().is_empty()),
            auth: self.auth.clone(),
            endpoints: vec![ss_server::ssh::SshEndpointRecord {
                name: "shell".into(),
                r#type: "shell".into(),
                alias: None,
            }],
        }
    }
}

/// 接入通道。serial 的 port 为本机裸名或级联端口键（设备插在另一台 ss 主机），
/// config 内联打开参数；ssh 内联完整登录配置。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Channel {
    Serial {
        port: String,
        #[serde(default)]
        config: SerialConfig,
    },
    Ssh(SshChannelConfig),
}

impl Channel {
    pub fn label(&self) -> String {
        match self {
            Channel::Serial { port, config } => format!("串口 {port}·{}bps", config.baud_rate),
            Channel::Ssh(s) => format!("SSH {}", s.label()),
        }
    }

    /// 通道是否覆盖写入端口键 w：serial 精确比对端口键；ssh 比对复合键首段
    /// （id 的任意端点与实例行都算该通道）。
    pub fn covers(&self, w: &str) -> bool {
        match self {
            Channel::Serial { port, .. } => port == w,
            Channel::Ssh(s) => ss_core::split_port_key(w).0 == s.id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub channels: Vec<Channel>,
}

/// 创建/更新请求体（channels 即定型形态；校验在此层）。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DeviceInput {
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub channels: Vec<Channel>,
}

// ===== 存储（照 topology store 模式）=====

static LOCK: Mutex<()> = Mutex::new(());

fn file_at(dir: &Path) -> PathBuf {
    dir.join("devices.json")
}

fn write_locked(p: &Path, list: &[Device]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

/// 读 devices.json。原文含 P2.5 的 `"ref"` 标记（SSH 通道引用凭据库）时执行
/// 一次性迁移：ref 查凭据库展开内联（查无则弃该通道并留痕），串口通道补默认
/// config；迁完重写。
pub fn load() -> Vec<Device> {
    let _g = LOCK.lock().expect("device store lock poisoned");
    let Some(dir) = ss_server::config::config_dir() else {
        return Vec::new();
    };
    let path = file_at(&dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    if !raw.contains("\"ref\"") {
        return serde_json::from_str(&raw).unwrap_or_default();
    }
    // 旧形态迁移
    #[derive(Deserialize)]
    struct LegacyChannel {
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        port: Option<String>,
        #[serde(default)]
        r#ref: Option<String>,
    }
    #[derive(Deserialize)]
    struct LegacyDevice {
        id: String,
        name: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        location: String,
        #[serde(default)]
        channels: Vec<LegacyChannel>,
    }
    let Ok(legacy) = serde_json::from_str::<Vec<LegacyDevice>>(&raw) else {
        return Vec::new();
    };
    let ssh_hosts = ss_server::ssh::store::load();
    let migrated = legacy
        .into_iter()
        .map(|d| Device {
            id: d.id,
            name: d.name,
            model: d.model,
            location: d.location,
            channels: d
                .channels
                .into_iter()
                .filter_map(|c| match c.kind.as_str() {
                    "serial" => c.port.map(|port| Channel::Serial {
                        port,
                        config: SerialConfig::default(),
                    }),
                    "ssh" => {
                        let id = c.r#ref?;
                        let rec = ssh_hosts.iter().find(|h| h.id == id)?;
                        Some(Channel::Ssh(SshChannelConfig {
                            id: rec.id.clone(),
                            host: rec.host.clone(),
                            port: rec.port,
                            username: rec.username.clone(),
                            nickname: rec.nickname.clone(),
                            auth: rec.auth.clone(),
                            allow_legacy_mac: false,
                        }))
                    }
                    _ => None,
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    let _ = write_locked(&path, &migrated);
    tracing::info!("设备通道已迁移为内联配置形态（{} 台）", migrated.len());
    migrated
}

fn save(list: &[Device]) -> Result<(), String> {
    let _g = LOCK.lock().expect("device store lock poisoned");
    let p = ss_server::config::config_dir()
        .map(|d| file_at(&d))
        .ok_or("无法定位配置目录")?;
    write_locked(&p, list)
}

/// 校验（create/update 共用闸门）：名称非空且同表唯一（update 排除自身）；
/// 串口端口跨设备不共用；SSH id 与 host:port 跨设备不重复；SSH 字段完整。
/// 收集全部错误一次报告。
fn validate(input: &DeviceInput, self_id: Option<&str>, existing: &[Device]) -> Result<(), String> {
    let mut errors = Vec::new();
    let name = input.name.trim();
    if name.is_empty() {
        errors.push("设备名称不能为空白".into());
    } else if existing
        .iter()
        .any(|d| d.name == name && d.id != self_id.unwrap_or(""))
    {
        errors.push(format!("设备名称「{name}」已存在，请换一个"));
    }
    // 其它设备已占的串口端口 / SSH（id 与 host:port）
    let mut used_serial: Vec<&str> = Vec::new();
    let mut used_ssh_id: Vec<&str> = Vec::new();
    let mut used_ssh_addr: Vec<(String, u16)> = Vec::new();
    for d in existing {
        if Some(d.id.as_str()) == self_id {
            continue;
        }
        for ch in &d.channels {
            match ch {
                Channel::Serial { port, .. } => used_serial.push(port),
                Channel::Ssh(s) => {
                    used_ssh_id.push(&s.id);
                    used_ssh_addr.push((s.host.trim().to_string(), s.port));
                }
            }
        }
    }
    for ch in &input.channels {
        match ch {
            Channel::Serial { port, .. } => {
                let p = port.trim();
                if p.is_empty() {
                    errors.push("串口通道的端口不能为空".into());
                }
                if used_serial.iter().any(|u| u.eq_ignore_ascii_case(p)) {
                    errors.push(format!("串口「{p}」已是其它设备的通道"));
                }
                if input
                    .channels
                    .iter()
                    .filter(|c| matches!(c, Channel::Serial { port, .. } if port.eq_ignore_ascii_case(p)))
                    .count()
                    > 1
                {
                    errors.push(format!("串口「{p}」在通道列表中重复"));
                }
            }
            Channel::Ssh(s) => {
                if s.host.trim().is_empty() {
                    errors.push("SSH 通道的主机地址不能为空".into());
                }
                if s.username.trim().is_empty() {
                    errors.push(format!("SSH 通道「{}」的用户名不能为空", s.label()));
                }
                if input
                    .channels
                    .iter()
                    .filter(|c| matches!(c, Channel::Ssh(x) if x.id == s.id))
                    .count()
                    > 1
                {
                    errors.push(format!("SSH 通道「{}」在通道列表中重复", s.label()));
                }
                if used_ssh_id.contains(&s.id.as_str()) {
                    errors.push(format!("SSH 通道「{}」的 id 与其它设备冲突", s.label()));
                }
                let addr = (s.host.trim().to_string(), s.port);
                if used_ssh_addr.contains(&addr) {
                    errors.push(format!(
                        "SSH 通道「{}」与其它设备同地址（{}:{}）",
                        s.label(),
                        addr.0,
                        addr.1
                    ));
                }
                match &s.auth {
                    ss_server::ssh::SshAuthRecord::Key { key_path }
                        if key_path.trim().is_empty() =>
                    {
                        errors.push(format!("SSH 通道「{}」的密钥路径不能为空", s.label()));
                    }
                    ss_server::ssh::SshAuthRecord::Password { password } if password.is_empty() => {
                        errors.push(format!(
                            "SSH 通道「{}」缺少密码（编辑时留空=沿用已存密码由前端补齐后提交）",
                            s.label()
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// trait helper：让错误文案用 label()（避免 match 臂里借用问题的小手段）。
/// 把设备的 SSH 通道投影进凭据库（ssh.json + SshManager 注册表）。
/// removed_ids：本次显式删除的通道 id（设备删除路径）——孤儿凭据保留，
/// 显式删除的不保留。
fn sync_ssh_registry(devices: &[Device], removed_ids: &[String], state: &AppState) {
    let mut entries: Vec<ss_server::ssh::SshHostRecord> = devices
        .iter()
        .flat_map(|d| {
            d.channels.iter().filter_map(|c| match c {
                Channel::Ssh(s) => Some(s.to_host_record()),
                _ => None,
            })
        })
        .collect();
    // 保留未归属任何设备的既有凭据（历史孤儿），除非本次显式删除
    for old in ss_server::ssh::store::load() {
        let owned = entries.iter().any(|e| e.id == old.id);
        let removed = removed_ids.contains(&old.id);
        if !owned && !removed {
            entries.push(old);
        }
    }
    if ss_server::ssh::store::save(&entries).is_ok() {
        state.ssh.update_registry(entries);
    }
}

pub fn create(input: &DeviceInput, state: &AppState) -> Result<Device, String> {
    let mut list = load();
    validate(input, None, &list)?;
    let dev = Device {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name.trim().into(),
        model: input.model.trim().into(),
        location: input.location.trim().into(),
        channels: normalize_channels(input.channels.clone()),
    };
    list.push(dev.clone());
    save(&list)?;
    sync_ssh_registry(&list, &[], state);
    Ok(dev)
}

/// 空 SSH 通道 id → 生成稳定 uuid（UI 新建时传 "" 覆盖了 serde default 的场景）。
fn normalize_channels(channels: Vec<Channel>) -> Vec<Channel> {
    channels
        .into_iter()
        .map(|c| match c {
            Channel::Ssh(mut s) if s.id.trim().is_empty() => {
                s.id = gen_uuid();
                Channel::Ssh(s)
            }
            other => other,
        })
        .collect()
}

pub fn update(id: &str, input: &DeviceInput, state: &AppState) -> Result<Device, String> {
    let mut list = load();
    validate(input, Some(id), &list)?;
    let dev = list
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("设备不存在: {id}"))?;
    dev.name = input.name.trim().into();
    dev.model = input.model.trim().into();
    dev.location = input.location.trim().into();
    dev.channels = normalize_channels(input.channels.clone());
    let updated = dev.clone();
    save(&list)?;
    sync_ssh_registry(&list, &[], state);
    Ok(updated)
}

/// 删除设备；被拓扑引用时拒绝并列出拓扑名。其 SSH 通道的凭据随之删除。
pub fn delete(id: &str, state: &AppState) -> Result<Device, String> {
    let mut list = load();
    let pos = list
        .iter()
        .position(|d| d.id == id)
        .ok_or_else(|| format!("设备不存在: {id}"))?;
    let referrers: Vec<String> = crate::topology::load()
        .into_iter()
        .filter(|t| t.members.iter().any(|m| m.device == id))
        .map(|t| t.name)
        .collect();
    if !referrers.is_empty() {
        return Err(format!(
            "设备被拓扑引用（{}），先从这些拓扑移除再删除",
            referrers.join("、")
        ));
    }
    let removed = list.remove(pos);
    save(&list)?;
    let removed_ids: Vec<String> = removed
        .channels
        .iter()
        .filter_map(|c| match c {
            Channel::Ssh(s) => Some(s.id.clone()),
            _ => None,
        })
        .collect();
    sync_ssh_registry(&list, &removed_ids, state);
    Ok(removed)
}

/// 按 id 或名称查找。
pub fn find(id_or_name: &str) -> Option<Device> {
    let key = id_or_name.trim();
    load().into_iter().find(|d| d.id == key || d.name == key)
}

/// 端口键 → 属主设备（占用判定与写闸的映射核心）。遍历注册表比对通道；
/// devices.json 量级小，每次查表读文件可接受（后续可加缓存）。
pub fn device_of_port(port_key: &str) -> Option<Device> {
    load()
        .into_iter()
        .find(|d| d.channels.iter().any(|ch| ch.covers(port_key)))
}

/// 设备在当前已开端口中覆盖的端口键（强释放收口用）。
pub fn open_ports_of_device(dev: &Device, open_ports: &[String]) -> Vec<String> {
    open_ports
        .iter()
        .filter(|p| dev.channels.iter().any(|ch| ch.covers(p)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        ensure_test_config_dir, make_state, reset_stores, unique_name, STORE_LOCK,
    };
    use ss_server::ssh::SshAuthRecord;

    /// allow_legacy_mac 投影透传（老交换机 hmac-sha1 兼容开关）。
    #[test]
    fn legacy_mac_passthrough_to_host_record() {
        let mut s = SshChannelConfig::ssh_fixture("ssh-lm");
        assert!(!s.to_host_record().allow_legacy_mac, "默认关");
        s.allow_legacy_mac = true;
        assert!(s.to_host_record().allow_legacy_mac, "开则透传到凭据库条目");
    }

    fn serial(port: &str, baud: u32) -> Channel {
        Channel::Serial {
            port: port.into(),
            config: SerialConfig {
                baud_rate: baud,
                ..SerialConfig::default()
            },
        }
    }
    fn ssh(host: &str, user: &str) -> Channel {
        Channel::Ssh(SshChannelConfig {
            id: gen_uuid(),
            host: host.into(),
            port: 22,
            username: user.into(),
            nickname: None,
            auth: SshAuthRecord::Password {
                password: "pw".into(),
            },
            allow_legacy_mac: false,
        })
    }
    fn input(name: &str, channels: Vec<Channel>) -> DeviceInput {
        DeviceInput {
            name: name.into(),
            model: String::new(),
            location: String::new(),
            channels,
        }
    }

    #[test]
    fn covers_by_channel_type() {
        let s = serial("COM4", 115200);
        assert!(s.covers("COM4"));
        assert!(!s.covers("COM5"));
        assert!(
            s.label().contains("115200"),
            "串口标签带波特率: {}",
            s.label()
        );
        let sid = match &ssh("192.0.2.1", "root") {
            Channel::Ssh(s2) => s2.id.clone(),
            _ => unreachable!(),
        };
        let c = Channel::Ssh(SshChannelConfig {
            id: sid.clone(),
            host: "192.0.2.1".into(),
            port: 22,
            username: "root".into(),
            nickname: Some("车间网关".into()),
            auth: SshAuthRecord::Agent,
            allow_legacy_mac: false,
        });
        assert!(c.covers(&format!("{sid}::shell")), "SSH 通道覆盖端点");
        assert!(c.covers(&format!("{sid}::shell@3")), "含实例行");
        assert!(!c.covers("other::shell"));
        assert_eq!(c.label(), "SSH 车间网关", "昵称优先");
    }

    #[tokio::test]
    async fn crud_projection_and_exclusivity() {
        let _g = STORE_LOCK.lock().unwrap();
        ensure_test_config_dir();
        reset_stores();
        let state = make_state();
        let n = unique_name("设备");

        let a = create(
            &input(&n, vec![serial("COM4", 9600), ssh("192.0.2.70", "root")]),
            &state,
        )
        .unwrap();
        assert_eq!(a.channels.len(), 2);
        // 串口参数落盘
        assert!(
            matches!(&a.channels[0], Channel::Serial { config, .. } if config.baud_rate == 9600)
        );
        // 投影：凭据库 + SshManager 注册表出现该 SSH 通道
        let ssh_id = match &a.channels[1] {
            Channel::Ssh(s) => s.id.clone(),
            _ => unreachable!(),
        };
        assert!(ss_server::ssh::store::load().iter().any(|h| h.id == ssh_id));
        assert!(state.ssh.registry_snapshot().iter().any(|h| h.id == ssh_id));

        // 同地址二注册拒绝；串口冲突拒绝；缺密码拒绝
        let err = create(
            &input(&unique_name("设备"), vec![ssh("192.0.2.70", "root")]),
            &state,
        )
        .unwrap_err();
        assert!(err.contains("同地址"), "{err}");
        let err = create(
            &input(&unique_name("设备"), vec![serial("COM4", 9600)]),
            &state,
        )
        .unwrap_err();
        assert!(err.contains("已是其它设备"), "{err}");
        let bad = input(
            &unique_name("设备"),
            vec![Channel::Ssh(SshChannelConfig {
                id: gen_uuid(),
                host: "192.0.2.99".into(),
                port: 22,
                username: "root".into(),
                nickname: None,
                auth: SshAuthRecord::Password {
                    password: String::new(),
                },
                allow_legacy_mac: false,
            })],
        );
        let err = create(&bad, &state).unwrap_err();
        assert!(err.contains("缺少密码"), "{err}");

        // 更新改 host → 投影同步（同 id）
        let mut updated_input = input(&n, vec![serial("COM4", 9600), ssh("192.0.2.71", "root")]);
        if let Channel::Ssh(s) = &mut updated_input.channels[1] {
            s.id = ssh_id.clone();
        }
        let _ = update(&a.id, &updated_input, &state).unwrap();
        let reg = ss_server::ssh::store::load();
        assert_eq!(
            reg.iter().find(|h| h.id == ssh_id).unwrap().host,
            "192.0.2.71"
        );

        // 端口 → 属主（覆盖判定走内联 id）
        let owner = device_of_port(&format!("{ssh_id}::shell")).unwrap();
        assert_eq!(owner.id, a.id);
        assert!(device_of_port("COM4").is_some());
        assert!(device_of_port("COM99").is_none());

        // 删除 → 凭据随之删除（显式 removed）
        delete(&a.id, &state).unwrap();
        assert!(!ss_server::ssh::store::load().iter().any(|h| h.id == ssh_id));
        assert!(delete(&a.id, &state).is_err());
    }

    #[tokio::test]
    async fn legacy_ref_channels_migrated_inline() {
        let _g = STORE_LOCK.lock().unwrap();
        ensure_test_config_dir();
        reset_stores();
        // 凭据库里有一条 ssh-x1
        let state = make_state();
        let rec = state
            .ssh
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == "ssh-x1")
            .unwrap();
        ss_server::ssh::store::save(&[rec]).unwrap();
        // 旧形态 devices.json：serial 无 config、ssh 用 ref；ref 悬空的那条被弃
        let dir = ss_server::config::config_dir().unwrap();
        let legacy = serde_json::json!([{
            "id": "dev-legacy",
            "name": unique_name("旧设备"),
            "channels": [
                { "type": "serial", "port": "COM4" },
                { "type": "ssh", "ref": "ssh-x1" },
                { "type": "ssh", "ref": "ghost" }
            ]
        }]);
        std::fs::write(dir.join("devices.json"), legacy.to_string()).unwrap();

        let list = load();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].channels.len(), 2, "悬空 ref 通道被弃");
        assert!(
            matches!(&list[0].channels[0], Channel::Serial { config, .. } if config.baud_rate == 115200)
        );
        assert!(
            matches!(&list[0].channels[1], Channel::Ssh(s) if s.id == "ssh-x1" && s.host == "192.0.2.70")
        );
        // 重读不再迁移
        assert_eq!(load().len(), 1);
        delete(&list[0].id, &state).unwrap();
    }
}

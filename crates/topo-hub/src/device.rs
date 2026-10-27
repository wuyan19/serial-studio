//! 被测设备注册表（devices.json）：设备 = 身份（一台被调试的机器），
//! 通道 = 接入方式（串口 / SSH 凭据引用）。接入源（SSH 凭据库、本机/级联端口）
//! 是底层资源；本表落盘"哪些通道属于同一台设备"的领域知识——此前只存在于
//! 人的拓扑成员备注里。
//!
//! 校验闸门：设备名唯一；串口通道的端口与 SSH 凭据跨设备不共用；
//! SSH ref 须存在于凭据库。占用粒度即设备级（见 lease.rs）。

use serde::{Deserialize, Serialize};
use ss_server::AppState;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 接入通道。serial 的 port 为本机裸名或级联端口键（设备插在另一台 ss 主机）；
/// ssh 的 ref 引用 SSH 凭据库条目（admin@ 与 support@ 是两条凭据、一台设备的
/// 两条通道）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Channel {
    Serial { port: String },
    Ssh { r#ref: String },
}

impl Channel {
    pub fn label(&self, state: &AppState) -> String {
        match self {
            Channel::Serial { port } => format!("串口 {port}"),
            Channel::Ssh { r#ref } => match state.ssh.registry_snapshot().into_iter().find(|r| r.id == *r#ref) {
                Some(rec) => format!("SSH {}", rec.label()),
                None => format!("SSH {}", r#ref),
            },
        }
    }

    /// 通道是否覆盖写入端口键 w：serial 精确比对端口键；ssh 比对复合键首段
    /// （凭据的任意端点与实例行都算该通道）。
    pub fn covers(&self, w: &str) -> bool {
        match self {
            Channel::Serial { port } => port == w,
            Channel::Ssh { r#ref } => ss_core::split_port_key(w).0 == *r#ref,
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

/// 创建/更新请求体（channels 已是定型形态；校验在此层）。
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

fn read_locked(p: &Path) -> Vec<Device> {
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_locked(p: &Path, list: &[Device]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

pub fn load() -> Vec<Device> {
    let _g = LOCK.lock().expect("device store lock poisoned");
    ss_server::config::config_dir()
        .map(|d| read_locked(&file_at(&d)))
        .unwrap_or_default()
}

fn save(list: &[Device]) -> Result<(), String> {
    let _g = LOCK.lock().expect("device store lock poisoned");
    let p = ss_server::config::config_dir()
        .map(|d| file_at(&d))
        .ok_or("无法定位配置目录")?;
    write_locked(&p, list)
}

/// 校验（create/update 共用闸门）：名称非空且同表唯一（update 排除自身）；
/// 通道资源跨设备不共用；SSH ref 须存在。收集全部错误一次报告。
fn validate(
    input: &DeviceInput,
    self_id: Option<&str>,
    existing: &[Device],
    state: &AppState,
) -> Result<(), String> {
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
    let ssh_snapshot = state.ssh.registry_snapshot();
    let ssh_ids: std::collections::HashSet<&str> = ssh_snapshot
        .iter()
        .map(|r| r.id.as_str())
        .collect();
    // 资源占用表：其它设备已用的串口端口 / SSH ref
    let mut used_serial: Vec<&str> = Vec::new();
    let mut used_ssh: Vec<&str> = Vec::new();
    for d in existing {
        if Some(d.id.as_str()) == self_id {
            continue;
        }
        for ch in &d.channels {
            match ch {
                Channel::Serial { port } => used_serial.push(port),
                Channel::Ssh { r#ref } => used_ssh.push(r#ref),
            }
        }
    }
    for ch in &input.channels {
        match ch {
            Channel::Serial { port } => {
                let p = port.trim();
                if p.is_empty() {
                    errors.push("串口通道的端口不能为空".into());
                } else if p.contains(ss_core::PORT_KEY_SEP) {
                    // 级联键允许（远端主机端口），不做更深校验
                }
                if used_serial.iter().any(|u| u.eq_ignore_ascii_case(p)) {
                    errors.push(format!("串口「{p}」已是其它设备的通道"));
                }
            }
            Channel::Ssh { r#ref } => {
                if !ssh_ids.contains(r#ref.as_str()) {
                    errors.push(format!(
                        "SSH 凭据「{}」不存在（先在设备表单或 SSH 凭据库创建）",
                        r#ref
                    ));
                }
                if used_ssh.contains(&r#ref.as_str()) {
                    errors.push(format!(
                        "SSH 凭据「{}」已是其它设备的通道",
                        r#ref
                    ));
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

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

pub fn create(input: &DeviceInput, state: &AppState) -> Result<Device, String> {
    let mut list = load();
    validate(input, None, &list, state)?;
    let dev = Device {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name.trim().into(),
        model: input.model.trim().into(),
        location: input.location.trim().into(),
        channels: input.channels.clone(),
    };
    list.push(dev.clone());
    save(&list)?;
    Ok(dev)
}

pub fn update(id: &str, input: &DeviceInput, state: &AppState) -> Result<Device, String> {
    let mut list = load();
    validate(input, Some(id), &list, state)?;
    let dev = list
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("设备不存在: {id}"))?;
    dev.name = input.name.trim().into();
    dev.model = input.model.trim().into();
    dev.location = input.location.trim().into();
    dev.channels = input.channels.clone();
    let updated = dev.clone();
    save(&list)?;
    Ok(updated)
}

/// 删除设备；被拓扑引用时拒绝并列出拓扑名。
pub fn delete(id: &str) -> Result<Device, String> {
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

#[allow(dead_code)]
fn _timestamp_helper() -> String {
    now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{ensure_test_config_dir, make_state, unique_name};

    use crate::test_support::STORE_LOCK as TEST_LOCK;

    fn serial(port: &str) -> Channel {
        Channel::Serial {
            port: port.into(),
        }
    }
    fn ssh(r: &str) -> Channel {
        Channel::Ssh { r#ref: r.into() }
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
        let state = make_state();
        let s = serial("COM4");
        assert!(s.covers("COM4"));
        assert!(!s.covers("COM5"));
        let c = ssh("ssh-x1");
        assert!(c.covers("ssh-x1::shell"), "SSH 通道覆盖凭据任意端点");
        assert!(c.covers("ssh-x1::shell@3"), "含实例行");
        assert!(!c.covers("ssh-x2::shell"));
        assert_eq!(s.label(&state), "串口 COM4");
        assert_eq!(c.label(&state), "SSH 车间网关", "凭据标签解析");
    }

    #[tokio::test]
    async fn crud_and_resource_exclusivity() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let n = unique_name("设备");

        let a = create(&input(&n, vec![serial("COM4"), ssh("ssh-x1")]), &state).unwrap();
        assert_eq!(a.channels.len(), 2);
        assert_eq!(find(&a.id).unwrap().name, n);

        // 串口跨设备不共用
        let err = create(&input(&unique_name("设备"), vec![serial("COM4")]), &state).unwrap_err();
        assert!(err.contains("已是其它设备"), "{err}");
        // SSH 凭据跨设备不共用
        let err = create(&input(&unique_name("设备"), vec![ssh("ssh-x1")]), &state).unwrap_err();
        assert!(err.contains("已是其它设备"), "{err}");
        // 不存在的凭据
        let err = create(&input(&unique_name("设备"), vec![ssh("ghost")]), &state).unwrap_err();
        assert!(err.contains("不存在"), "{err}");

        // 更新改名保留资源
        let renamed = DeviceInput {
            name: format!("{n}-改"),
            ..input(&n, vec![serial("COM4"), ssh("ssh-x1")])
        };
        let updated = update(&a.id, &renamed, &state).unwrap();
        assert_eq!(updated.name, format!("{n}-改"));

        // 端口 → 属主
        let owner = device_of_port("COM4").unwrap();
        assert_eq!(owner.id, a.id);
        assert_eq!(device_of_port("ssh-x1::shell").unwrap().id, a.id);
        assert!(device_of_port("COM99").is_none());

        // 强释放收口的端口筛选
        let open = vec![
            "COM4".to_string(),
            "ssh-x1::shell".to_string(),
            "ssh-x2::shell".to_string(),
        ];
        let covered = open_ports_of_device(&owner, &open);
        assert_eq!(covered, vec!["COM4".to_string(), "ssh-x1::shell".to_string()]);

        delete(&a.id).unwrap();
        assert!(delete(&a.id).is_err());
    }
}

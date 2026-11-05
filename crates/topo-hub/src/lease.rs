//! 租约管理器：排他占用的策略层（连接事实仍在 manager，本模块只有"谁能写"）。
//!
//! P2.5 起占用 = **设备级独占**（用户定案）：grant 即设备，覆盖其全部通道
//! （串口控制台与 SSH 并发操作会互相干扰；分通道观察由"读免闸"兜底）。
//!
//! - 原子申请：单锁内"全量冲突检查 + 插入"一次完成，all-or-nothing——
//!   不存在逐个拿锁接口，死锁在 API 形态上不可能；
//! - 覆盖判定：`device_of_port(端口键) == grant.device`（device.rs 的通道映射）；
//! - TTL：默认/上限读 lease.json；到期惰性清扫（读路径 + 每分钟定时）双保险；
//! - 释放须持 token；人工抢占（Web 占用中心）不验 token，顺带收回该会话
//!   在租约设备全部通道端口中经 MCP 开的口。

use crate::audit;
use crate::device;
use serde::{Deserialize, Serialize};
use ss_server::AppState;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// 租约配置（配置目录 lease.json；不存在用默认）。独立文件而非并入
/// settings.json——settings.json 的写方是 ss-server（字段白名单），
/// 拓扑域自持配置避免互相覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseConfig {
    #[serde(default = "default_ttl")]
    pub ttl_minutes: u64,
    #[serde(default = "default_max_ttl")]
    pub max_ttl_minutes: u64,
    #[serde(default = "default_gate")]
    pub enable_gate: bool,
}

fn default_ttl() -> u64 {
    30
}
fn default_max_ttl() -> u64 {
    240
}
fn default_gate() -> bool {
    true
}

impl Default for LeaseConfig {
    fn default() -> Self {
        Self {
            ttl_minutes: default_ttl(),
            max_ttl_minutes: default_max_ttl(),
            enable_gate: default_gate(),
        }
    }
}

pub fn load_config() -> LeaseConfig {
    ss_server::config::config_dir()
        .map(|d| d.join("lease.json"))
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 写 lease.json（设置面板用；temp+rename 原子替换，同 settings.json 模式）。
/// 运行中的 LeaseManager 配置在启动时定格——新值重启进程生效。
pub fn save_config(cfg: &LeaseConfig) -> Result<(), String> {
    let p = ss_server::config::config_dir()
        .map(|d| d.join("lease.json"))
        .ok_or("无法定位配置目录")?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入 {:?} 失败: {}", tmp, e))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("落盘 {:?} 失败: {}", p, e))?;
    Ok(())
}

/// 一条授权 = 一台设备（含其全部通道）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Grant {
    pub device: String,
}

impl Grant {
    /// 覆盖判定：端口键的属主设备即本 grant 的设备。
    pub fn covers(&self, w: &str) -> bool {
        device::device_of_port(w)
            .map(|d| d.id == self.device)
            .unwrap_or(false)
    }
}

/// 设备级粒度下冲突判定即设备 id 相等。
pub fn grants_intersect(a: &Grant, b: &Grant) -> bool {
    a.device == b.device
}

/// 申请作用域：三种来源取并集（提供多种则合并）。endpoints 为糖——
/// 端口键经属主解析为设备（未注册端口的占用须先 device_create）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Scope {
    #[serde(default)]
    pub topology: Option<String>,
    #[serde(default)]
    pub devices: Vec<String>,
    #[serde(default)]
    pub endpoints: Vec<String>,
}

impl Scope {
    pub fn is_empty(&self) -> bool {
        self.topology.is_none() && self.devices.is_empty() && self.endpoints.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Lease {
    pub id: String,
    pub token: String,
    pub label: String,
    pub grants: Vec<Grant>,
    pub acquired_at: chrono::DateTime<chrono::Local>,
    pub expires_at: chrono::DateTime<chrono::Local>,
}

/// 申请被拒时的冲突明细（AI 据此决策重试或换设备）。
#[derive(Debug, Clone, Serialize)]
pub struct Conflict {
    pub device: String,
    pub device_name: String,
    pub holder: String,
    pub lease_id: String,
    pub expires_at: chrono::DateTime<chrono::Local>,
}

#[derive(Debug)]
pub enum AcquireError {
    Conflict(Vec<Conflict>),
    Invalid(String),
}

pub struct LeaseManager {
    leases: Mutex<Vec<Lease>>,
    pub cfg: LeaseConfig,
    bus: broadcast::Sender<()>,
}

impl LeaseManager {
    pub fn new(cfg: LeaseConfig, bus: broadcast::Sender<()>) -> Arc<Self> {
        Arc::new(Self {
            leases: Mutex::new(Vec::new()),
            cfg,
            bus,
        })
    }

    pub fn gate_enabled(&self) -> bool {
        self.cfg.enable_gate
    }

    /// 申请（立即返回）：try_acquire + 审计。等待版见 [`acquire_with_wait`]。
    pub fn acquire(
        &self,
        token: &str,
        label: &str,
        scope: &Scope,
        ttl_minutes: Option<u64>,
    ) -> Result<Lease, AcquireError> {
        let outcome = self.try_acquire(token, label, scope, ttl_minutes);
        let ttl = ttl_minutes
            .unwrap_or(self.cfg.ttl_minutes)
            .clamp(1, self.cfg.max_ttl_minutes.max(1));
        match &outcome {
            Ok(lease) => {
                let keys: Vec<String> = lease.grants.iter().map(|g| g.device.clone()).collect();
                audit::log(
                    audit::EV_ACQUIRE,
                    Some(token),
                    label,
                    Some(&lease.id),
                    &keys,
                    &format!("TTL {ttl} 分钟"),
                );
            }
            Err(AcquireError::Conflict(cs)) => {
                let ckeys: Vec<String> = cs.iter().map(|c| c.device.clone()).collect();
                audit::log(
                    audit::EV_DENY,
                    Some(token),
                    label,
                    None,
                    &ckeys,
                    &format!("冲突 {} 处", cs.len()),
                );
            }
            Err(AcquireError::Invalid(_)) => {}
        }
        outcome
    }

    /// 排队申请：冲突时每 500ms 重试（惰性清扫让到期租约自然腾位），到
    /// wait_ms 仍冲突才拒绝并审计一次。Invalid（范围本身非法）立即返回不重试。
    /// wait 上限 10 分钟（AI 长等待应自行轮询 lease_status）。
    pub async fn acquire_with_wait(
        &self,
        token: &str,
        label: &str,
        scope: &Scope,
        ttl_minutes: Option<u64>,
        wait_ms: u64,
    ) -> Result<Lease, AcquireError> {
        const MAX_WAIT_MS: u64 = 600_000;
        let wait_ms = wait_ms.min(MAX_WAIT_MS);
        let started = std::time::Instant::now();
        let deadline = started + Duration::from_millis(wait_ms);
        let ttl = ttl_minutes
            .unwrap_or(self.cfg.ttl_minutes)
            .clamp(1, self.cfg.max_ttl_minutes.max(1));
        loop {
            let outcome = self.try_acquire(token, label, scope, ttl_minutes);
            match outcome {
                Ok(lease) => {
                    let keys: Vec<String> = lease.grants.iter().map(|g| g.device.clone()).collect();
                    audit::log(
                        audit::EV_ACQUIRE,
                        Some(token),
                        label,
                        Some(&lease.id),
                        &keys,
                        &format!(
                            "等待 {} 秒后获得，TTL {ttl} 分钟",
                            started.elapsed().as_secs()
                        ),
                    );
                    return Ok(lease);
                }
                Err(AcquireError::Invalid(e)) => return Err(AcquireError::Invalid(e)),
                Err(AcquireError::Conflict(cs)) => {
                    if std::time::Instant::now() >= deadline {
                        let ckeys: Vec<String> = cs.iter().map(|c| c.device.clone()).collect();
                        audit::log(
                            audit::EV_DENY,
                            Some(token),
                            label,
                            None,
                            &ckeys,
                            &format!(
                                "等待 {} 秒后仍冲突 {} 处",
                                started.elapsed().as_secs(),
                                cs.len()
                            ),
                        );
                        return Err(AcquireError::Conflict(cs));
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    /// 无审计的单次申请（acquire/acquire_with_wait 的公共内核）。
    fn try_acquire(
        &self,
        token: &str,
        label: &str,
        scope: &Scope,
        ttl_minutes: Option<u64>,
    ) -> Result<Lease, AcquireError> {
        let grants = expand_scope(scope).map_err(AcquireError::Invalid)?;
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);

        let mut conflicts: Vec<Conflict> = Vec::new();
        for lease in leases.iter() {
            for g in &grants {
                if lease.grants.iter().any(|lg| grants_intersect(lg, g)) {
                    conflicts.push(Conflict {
                        device: g.device.clone(),
                        device_name: device::find(&g.device)
                            .map(|d| d.name)
                            .unwrap_or_else(|| g.device.clone()),
                        holder: lease.label.clone(),
                        lease_id: lease.id.clone(),
                        expires_at: lease.expires_at,
                    });
                    break;
                }
            }
        }
        if !conflicts.is_empty() {
            return Err(AcquireError::Conflict(conflicts));
        }

        let ttl = ttl_minutes
            .unwrap_or(self.cfg.ttl_minutes)
            .clamp(1, self.cfg.max_ttl_minutes.max(1));
        let lease = Lease {
            id: uuid::Uuid::new_v4().to_string(),
            token: token.into(),
            label: label.into(),
            grants,
            acquired_at: chrono::Local::now(),
            expires_at: chrono::Local::now() + Duration::from_secs(ttl * 60),
        };
        leases.push(lease.clone());
        drop(leases);
        let _ = self.bus.send(());
        Ok(lease)
    }

    /// 续租：顺延 expires_at = now + ttl（同样夹取上限）。仅持有者 token 可续。
    pub fn renew(
        &self,
        lease_id: &str,
        token: &str,
        ttl_minutes: Option<u64>,
    ) -> Result<Lease, String> {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);
        let lease = leases
            .iter_mut()
            .find(|l| l.id == lease_id)
            .ok_or_else(|| format!("租约不存在: {lease_id}"))?;
        if lease.token != token {
            return Err(format!("租约 {} 不属于当前会话（token 不匹配）", lease_id));
        }
        let ttl = ttl_minutes
            .unwrap_or(self.cfg.ttl_minutes)
            .clamp(1, self.cfg.max_ttl_minutes.max(1));
        lease.expires_at = chrono::Local::now() + Duration::from_secs(ttl * 60);
        let renewed = lease.clone();
        let keys: Vec<String> = renewed.grants.iter().map(|g| g.device.clone()).collect();
        audit::log(
            audit::EV_RENEW,
            Some(token),
            &renewed.label,
            Some(lease_id),
            &keys,
            &format!("顺延 {ttl} 分钟"),
        );
        drop(leases);
        let _ = self.bus.send(());
        Ok(renewed)
    }

    /// 释放：仅持有者 token（或人工抢占路径 force_release）。
    pub fn release(&self, lease_id: &str, token: &str) -> Result<Lease, String> {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);
        let pos = leases
            .iter()
            .position(|l| l.id == lease_id)
            .ok_or_else(|| format!("租约不存在: {lease_id}"))?;
        if leases[pos].token != token {
            return Err(format!("租约 {} 不属于当前会话（token 不匹配）", lease_id));
        }
        let removed = leases.remove(pos);
        let keys: Vec<String> = removed.grants.iter().map(|g| g.device.clone()).collect();
        audit::log(
            audit::EV_RELEASE,
            Some(token),
            &removed.label,
            Some(lease_id),
            &keys,
            "",
        );
        drop(leases);
        let _ = self.bus.send(());
        Ok(removed)
    }

    /// 人工抢占（Web 占用中心）：不验 token。写闸即时对该会话生效；顺带收回
    /// 该会话在租约设备全部通道端口中经 MCP 开的口（人开的口不受影响）。
    pub async fn force_release(&self, lease_id: &str, state: &AppState) -> Result<Lease, String> {
        let removed = {
            let mut leases = self.leases.lock().expect("lease lock poisoned");
            self.drop_expired_locked(&mut leases);
            let pos = leases
                .iter()
                .position(|l| l.id == lease_id)
                .ok_or_else(|| format!("租约不存在: {lease_id}"))?;
            leases.remove(pos)
        };
        let mut closed: Vec<String> = Vec::new();
        if let Some(sid) = ss_server::mcp::mcp_session_of(&removed.token) {
            let open = state.manager.list_open_ports().await;
            for g in &removed.grants {
                if let Some(dev) = device::find(&g.device) {
                    for port in device::open_ports_of_device(&dev, &open) {
                        if let Ok(outcome) = state.manager.release(&port, sid).await {
                            if !matches!(outcome, ss_core::ReleaseOutcome::NotHeld) {
                                closed.push(port);
                            }
                        }
                    }
                }
            }
        }
        let keys: Vec<String> = removed.grants.iter().map(|g| g.device.clone()).collect();
        let mut detail = format!("原持有会话 {}", removed.token);
        if !closed.is_empty() {
            detail.push_str(&format!("；顺带收回其打开的端口: {}", closed.join("、")));
        }
        audit::log(
            audit::EV_PREEMPT,
            None,
            &removed.label,
            Some(lease_id),
            &keys,
            &detail,
        );
        let _ = self.bus.send(());
        Ok(removed)
    }

    /// 活跃租约快照（读取路径顺带惰性清扫）。
    pub fn list(&self) -> Vec<Lease> {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);
        leases.clone()
    }

    /// 指定会话的活跃租约。
    pub fn of_token(&self, token: &str) -> Vec<Lease> {
        self.list()
            .into_iter()
            .filter(|l| l.token == token)
            .collect()
    }

    /// 覆盖指定设备的活跃租约（占用徽章/详情用）。
    pub fn lease_of_device(&self, device_id: &str) -> Option<Lease> {
        self.list()
            .into_iter()
            .find(|l| l.grants.iter().any(|g| g.device == device_id))
    }

    /// 写闸：principal 须持覆盖 port_key（经属主设备）的活跃租约。
    /// 判定顺序：匿名 → 未注册端口 → 无租约（先回答"你是谁"，再回答"能不能"）。
    pub fn gate(&self, principal: Option<&str>, port_key: &str) -> Result<(), String> {
        let Some(token) = principal else {
            audit::log(
                audit::EV_WRITE_DENIED,
                None,
                "anonymous",
                None,
                &[port_key.to_string()],
                "匿名调用（无 token）",
            );
            return Err(format!(
                "写操作「{port_key}」需要租约：当前会话未标识（initialize 获取 token 或在工具参数传 token），先 lease_acquire"
            ));
        };
        let Some(owner) = device::device_of_port(port_key) else {
            audit::log(
                audit::EV_WRITE_DENIED,
                Some(token),
                "session",
                None,
                &[port_key.to_string()],
                "端口未归属任何设备",
            );
            return Err(format!(
                "写操作「{port_key}」被租约闸拒绝：该端口未归属任何设备。先 device_create 注册设备（把此端口列为通道），再 lease_acquire"
            ));
        };
        let leases = self.list();
        if leases
            .iter()
            .any(|l| l.token == token && l.grants.iter().any(|g| g.device == owner.id))
        {
            return Ok(());
        }
        let holder = self.lease_of_device(&owner.id);
        let holder_info = match &holder {
            Some(l) => format!("当前持有: {}（至 {}）", l.label, fmt_time(l.expires_at)),
            None => "当前无人持有".into(),
        };
        audit::log(
            audit::EV_WRITE_DENIED,
            Some(token),
            "session",
            holder.as_ref().map(|l| l.id.as_str()),
            &[port_key.to_string()],
            &holder_info,
        );
        Err(format!(
            "写操作「{port_key}」被租约闸拒绝：本会话未持设备「{}」的租约（{holder_info}）。先 lease_acquire",
            owner.name
        ))
    }

    /// 定时清扫（main 每分钟跑一次；读路径已惰性清扫，这里是兜底）。
    pub fn sweep(&self) {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);
    }

    /// 锁内清扫过期租约（逐条审计 expire）。
    fn drop_expired_locked(&self, leases: &mut Vec<Lease>) {
        let now = chrono::Local::now();
        let mut i = 0;
        while i < leases.len() {
            if leases[i].expires_at <= now {
                let expired = leases.remove(i);
                let keys: Vec<String> = expired.grants.iter().map(|g| g.device.clone()).collect();
                audit::log(
                    audit::EV_EXPIRE,
                    Some(&expired.token),
                    &expired.label,
                    Some(&expired.id),
                    &keys,
                    "TTL 到期",
                );
            } else {
                i += 1;
            }
        }
    }

    /// 测试钩子：把租约到期时间拨到过去（验证惰性清扫/闸拒绝）。
    #[cfg(test)]
    pub fn force_expire(&self, lease_id: &str) {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        if let Some(l) = leases.iter_mut().find(|l| l.id == lease_id) {
            l.expires_at = chrono::Local::now() - Duration::from_secs(1);
        }
    }
}

/// 展开作用域为设备 grant 集。返回 grants；成员设备已删除的跳过由调用方文案
/// 呈现（此处 Invalid 直报）。
/// - topology：成员设备并集（成员引用已删设备的跳过）；
/// - devices：逐个须为已注册设备（id 或名称）；
/// - endpoints：端口键经 device_of_port 解析（未注册报错引导 device_create）。
fn expand_scope(scope: &Scope) -> Result<Vec<Grant>, String> {
    let mut grants: Vec<Grant> = Vec::new();

    if let Some(tid) = &scope.topology {
        let topo = crate::topology::find(tid)
            .ok_or_else(|| format!("拓扑不存在: {tid}（topo_get 不传参可查）"))?;
        for m in &topo.members {
            if device::find(&m.device).is_some() {
                grants.push(Grant {
                    device: m.device.clone(),
                });
            } // 成员设备已删除：跳过（申请其余不阻塞）
        }
    }
    for id in &scope.devices {
        let d = device::find(id)
            .ok_or_else(|| format!("设备「{id}」不存在（device_get 可查，先 device_create）"))?;
        grants.push(Grant { device: d.id });
    }
    for key in &scope.endpoints {
        let d = device::device_of_port(key).ok_or_else(|| {
            format!(
                "端口「{key}」未归属任何设备，无法占用——先 device_create 注册（把此端口列为通道）"
            )
        })?;
        grants.push(Grant { device: d.id });
    }

    for (i, a) in grants.iter().enumerate() {
        if grants[i + 1..].iter().any(|b| grants_intersect(a, b)) {
            let name = device::find(&a.device)
                .map(|d| d.name)
                .unwrap_or_else(|| a.device.clone());
            return Err(format!("申请范围内设备重复: {name}"));
        }
    }
    if grants.is_empty() {
        return Err("申请范围为空（拓扑无成员设备或全部已删除）".into());
    }
    Ok(grants)
}

fn fmt_time(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%m-%d %H:%M").to_string()
}

/// 剩余分钟（向下取整；负值不会出现——过期即被清扫）。
pub fn remaining_minutes(l: &Lease) -> i64 {
    (l.expires_at - chrono::Local::now()).num_minutes().max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{Channel, DeviceInput};
    use crate::test_support::{ensure_test_config_dir, make_state, unique_name};

    use crate::test_support::STORE_LOCK as TEST_LOCK;

    fn manager(cfg: LeaseConfig) -> Arc<LeaseManager> {
        let (tx, _) = broadcast::channel(16);
        LeaseManager::new(cfg, tx)
    }

    fn seed_device(state: &AppState, name: &str, channels: Vec<Channel>) -> crate::device::Device {
        device::create(
            &DeviceInput {
                name: name.into(),
                model: String::new(),
                location: String::new(),
                channels,
            },
            state,
        )
        .unwrap()
    }

    fn scope_devices(name: &str) -> Scope {
        Scope {
            topology: None,
            devices: vec![name.to_string()],
            endpoints: vec![],
        }
    }

    #[tokio::test]
    async fn covers_via_device_channels() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let n = unique_name("设备");
        let d = seed_device(
            &state,
            &n,
            vec![
                Channel::Serial {
                    port: "COM4".into(),
                    config: ss_core::SerialConfig::default(),
                },
                Channel::Ssh(crate::device::SshChannelConfig::ssh_fixture("ssh-x1")),
            ],
        );
        let g = Grant {
            device: d.id.clone(),
        };
        assert!(g.covers("COM4"), "串口通道端口覆盖");
        assert!(g.covers("ssh-x1::shell"), "SSH 通道端点覆盖");
        assert!(g.covers("ssh-x1::shell@3"), "SSH 实例行覆盖");
        assert!(!g.covers("COM5"));
        assert!(!g.covers("ssh-x2::shell"));
        device::delete(&d.id, &state).unwrap();
    }

    #[tokio::test]
    async fn device_level_exclusivity() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let m = manager(LeaseConfig::default());
        let na = unique_name("设备A");
        let nb = unique_name("设备B");
        let a = seed_device(
            &state,
            &na,
            vec![Channel::Serial {
                port: "COM4".into(),
                config: ss_core::SerialConfig::default(),
            }],
        );
        let b = seed_device(
            &state,
            &nb,
            vec![Channel::Ssh(crate::device::SshChannelConfig::ssh_fixture(
                "ssh-x1",
            ))],
        );

        // token-a 持 A
        let la = m
            .acquire("token-a", "agent-a", &scope_devices(&na), None)
            .unwrap();
        // token-b 再申请 A（经另一条通道的 endpoints 糖）→ 冲突：设备级独占
        let ep_scope = Scope {
            topology: None,
            devices: vec![],
            endpoints: vec!["COM4".into()],
        };
        match m.acquire("token-b", "agent-b", &ep_scope, None) {
            Err(AcquireError::Conflict(cs)) => {
                assert_eq!(cs.len(), 1);
                assert_eq!(cs[0].device, a.id);
                assert_eq!(cs[0].holder, "agent-a");
            }
            other => panic!("应冲突: {other:?}"),
        }
        // B 不受影响
        assert!(m
            .acquire("token-b", "agent-b", &scope_devices(&nb), None)
            .is_ok());
        // 同一设备重复出现在 scope → Invalid
        let dup = Scope {
            devices: vec![na.clone(), na.clone()],
            ..scope_devices("")
        };
        assert!(matches!(
            m.acquire("token-c", "c", &dup, None),
            Err(AcquireError::Invalid(_))
        ));
        // 未注册端口 endpoints → Invalid 引导 device_create
        let unreg = Scope {
            endpoints: vec!["COM99".into()],
            ..scope_devices("")
        };
        assert!(
            matches!(m.acquire("token-c", "c", &unreg, None), Err(AcquireError::Invalid(e)) if e.contains("device_create"))
        );
        assert_eq!(m.list().len(), 2, "失败申请不建租约");

        m.release(&la.id, "token-a").unwrap();
        device::delete(&a.id, &state).unwrap();
        device::delete(&b.id, &state).unwrap();
    }

    #[tokio::test]
    async fn renew_release_auth_force_and_ttl() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let cfg = LeaseConfig {
            ttl_minutes: 30,
            max_ttl_minutes: 60,
            enable_gate: true,
        };
        let m = manager(cfg);
        let n = unique_name("设备");
        let d = seed_device(
            &state,
            &n,
            vec![Channel::Serial {
                port: "COM4".into(),
                config: ss_core::SerialConfig::default(),
            }],
        );

        let a = m
            .acquire("token-a", "a", &scope_devices(&n), Some(9999))
            .unwrap();
        assert_eq!(
            (a.expires_at - a.acquired_at).num_minutes(),
            60,
            "超上限夹取"
        );

        assert!(m.renew(&a.id, "token-b", None).is_err());
        assert!(m.release(&a.id, "token-b").is_err());
        let renewed = m.renew(&a.id, "token-a", Some(60)).unwrap();
        assert!(
            renewed.expires_at >= a.expires_at,
            "等上限续租不早于原到期（默认 30 会提前，续租显式给 60）"
        );

        // 到期 → 惰性清扫 + 闸拒绝 + 他人可申请
        assert!(m.gate(Some("token-a"), "COM4").is_ok());
        m.force_expire(&a.id);
        assert!(m.list().is_empty());
        assert!(matches!(m.gate(Some("token-a"), "COM4"), Err(e) if e.contains("未持")));
        assert!(m.acquire("token-b", "b", &scope_devices(&n), None).is_ok());

        // 人工强释放（无 MCP 会话时无口可收）
        let lb = m.list()[0].clone();
        m.force_release(&lb.id, &state).await.unwrap();
        assert!(m.list().is_empty());
        device::delete(&d.id, &state).unwrap();
    }

    #[tokio::test]
    async fn gate_unregistered_and_anonymous() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let m = manager(LeaseConfig::default());
        // 匿名 → 引导 token
        assert!(matches!(m.gate(None, "COM4"), Err(e) if e.contains("token")));
        // 未注册端口（有 token）→ 引导 device_create
        assert!(matches!(m.gate(Some("t"), "COM99"), Err(e) if e.contains("device_create")));
    }

    /// 排队等待：持有者租约在等待期间过期 → 等待者自动获得。
    #[tokio::test]
    async fn acquire_with_wait_gets_freed_lease() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let m = manager(LeaseConfig::default());
        let n = unique_name("设备");
        let d = seed_device(
            &state,
            &n,
            vec![Channel::Serial {
                port: "COM4".into(),
                config: ss_core::SerialConfig::default(),
            }],
        );
        let a = m.acquire("token-a", "a", &scope_devices(&n), None).unwrap();

        let m2 = Arc::clone(&m);
        let id = a.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            m2.force_expire(&id);
        });

        let started = std::time::Instant::now();
        let b = m
            .acquire_with_wait("token-b", "b", &scope_devices(&n), None, 5_000)
            .await
            .expect("等待后应获得");
        assert_eq!(b.token, "token-b");
        assert!(
            started.elapsed() >= Duration::from_millis(500),
            "确实经历了等待轮询"
        );
        let c = m
            .acquire_with_wait("token-c", "c", &scope_devices(&n), None, 300)
            .await;
        assert!(matches!(c, Err(AcquireError::Conflict(_))));
        device::delete(&d.id, &state).unwrap();
    }
}

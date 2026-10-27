//! 租约管理器：排他占用的策略层（连接事实仍在 manager，本模块只有"谁能写"）。
//!
//! - 原子申请：单锁内"全量冲突检查 + 插入"一次完成，all-or-nothing——
//!   不存在逐个拿锁接口，死锁在 API 形态上不可能；
//! - 覆盖判定：grant 两粒度（device = 该设备全部端点及其实例行，
//!   endpoint = 端点及其实例行），与写入端口键匹配；
//! - TTL：默认/上限读 lease.json；到期惰性清扫（读路径 + 每分钟定时）双保险；
//! - 释放须持 token；人工抢占（Web 占用中心）不验 token。
//!   MCP 调用是无状态 POST，AI 没有可踢的常驻连接——强释放即收回写权本身
//!   （写闸立即生效），端口由人开的仍归人管。

use crate::audit;
use crate::topology::{self, MemberKind};
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

/// 一条授权（租约的原子单位）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Grant {
    pub kind: MemberKind,
    pub key: String,
}

impl Grant {
    pub fn device(key: impl Into<String>) -> Self {
        Self {
            kind: MemberKind::Device,
            key: key.into(),
        }
    }

    /// 覆盖判定：本 grant 是否覆盖写入端口键 w。
    /// - device：w 的设备段 == key（裸名 w 视为 local）；
    /// - endpoint：同设备段，且 w 的裸名 == 端点名或以 `端点名@` 开头（实例行）。
    pub fn covers(&self, w: &str) -> bool {
        let (dev, rest) = ss_core::split_port_key(w);
        match self.kind {
            MemberKind::Device => dev == self.key,
            MemberKind::Endpoint => {
                let (gdev, grest) = ss_core::split_port_key(&self.key);
                gdev == dev && (grest == rest || rest.starts_with(&format!("{grest}@")))
            }
        }
    }
}

/// 两 grant 覆盖集合是否相交。
///
/// 不走 `covers`（它吃的是端口键——裸名按 local 域解析，而 device grant 的键
/// 是裸设备 id，covers 会把同设备误判为不相交），按结构判定：
/// device×device 比键；device×endpoint 比端点的设备段；endpoint×endpoint
/// 同设备且互为基名（实例行不会成为 grant，末条是防御）。
pub fn grants_intersect(a: &Grant, b: &Grant) -> bool {
    fn dev_seg(k: &str) -> &str {
        ss_core::split_port_key(k).0
    }
    match (a.kind, b.kind) {
        (MemberKind::Device, MemberKind::Device) => a.key == b.key,
        (MemberKind::Device, MemberKind::Endpoint) => dev_seg(&b.key) == a.key,
        (MemberKind::Endpoint, MemberKind::Device) => dev_seg(&a.key) == b.key,
        (MemberKind::Endpoint, MemberKind::Endpoint) => {
            let (ad, arest) = ss_core::split_port_key(&a.key);
            let (bd, brest) = ss_core::split_port_key(&b.key);
            ad == bd
                && (arest == brest
                    || arest.starts_with(&format!("{brest}@"))
                    || brest.starts_with(&format!("{arest}@")))
        }
    }
}

/// 申请作用域：三种来源取并集（提供多种则合并）。
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

/// 申请被拒时的冲突明细（AI 据此决策重试或换拓扑）。
#[derive(Debug, Clone, Serialize)]
pub struct Conflict {
    pub key: String,
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

    /// 申请：scope 展开为 grant 集（拓扑成员失效的跳过并注明），与全部活跃
    /// 租约两两判交，任一冲突整体拒绝（不建部分租约）。TTL 缺省用配置值，
    /// 传入则夹取 [1, max_ttl]。
    pub fn acquire(
        &self,
        token: &str,
        label: &str,
        scope: &Scope,
        ttl_minutes: Option<u64>,
        state: &AppState,
    ) -> Result<Lease, AcquireError> {
        let (grants, skipped) = expand_scope(scope, state).map_err(AcquireError::Invalid)?;
        let keys: Vec<String> = grants.iter().map(|g| g.key.clone()).collect();
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);

        let mut conflicts: Vec<Conflict> = Vec::new();
        for lease in leases.iter() {
            for g in &grants {
                if lease.grants.iter().any(|lg| grants_intersect(lg, g)) {
                    conflicts.push(Conflict {
                        key: g.key.clone(),
                        holder: lease.label.clone(),
                        lease_id: lease.id.clone(),
                        expires_at: lease.expires_at,
                    });
                    break; // 每个新 grant 只记一次最浅冲突来源
                }
            }
        }
        if !conflicts.is_empty() {
            let ckeys: Vec<String> = conflicts.iter().map(|c| c.key.clone()).collect();
            audit::log(
                audit::EV_DENY,
                Some(token),
                label,
                None,
                &ckeys,
                &format!("冲突 {} 处", conflicts.len()),
            );
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
        let mut detail = format!("TTL {ttl} 分钟");
        if !skipped.is_empty() {
            detail.push_str(&format!("；跳过失效成员: {}", skipped.join("、")));
        }
        audit::log(
            audit::EV_ACQUIRE,
            Some(token),
            label,
            Some(&lease.id),
            &keys,
            &detail,
        );
        leases.push(lease.clone());
        drop(leases);
        let _ = self.bus.send(());
        Ok(lease)
    }

    /// 续租：顺延 expires_at = now + ttl（同样夹取上限）。仅持有者 token 可续。
    pub fn renew(&self, lease_id: &str, token: &str, ttl_minutes: Option<u64>) -> Result<Lease, String> {
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
        let keys: Vec<String> = renewed.grants.iter().map(|g| g.key.clone()).collect();
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
        let keys: Vec<String> = removed.grants.iter().map(|g| g.key.clone()).collect();
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

    /// 人工抢占（Web 占用中心）：不验 token。MCP 无常驻连接可踢——写闸即时
    /// 生效即是收回控制权；端口本身由人开的归人管。
    pub fn force_release(&self, lease_id: &str) -> Result<Lease, String> {
        let mut leases = self.leases.lock().expect("lease lock poisoned");
        self.drop_expired_locked(&mut leases);
        let pos = leases
            .iter()
            .position(|l| l.id == lease_id)
            .ok_or_else(|| format!("租约不存在: {lease_id}"))?;
        let removed = leases.remove(pos);
        let keys: Vec<String> = removed.grants.iter().map(|g| g.key.clone()).collect();
        audit::log(
            audit::EV_PREEMPT,
            None,
            &removed.label,
            Some(lease_id),
            &keys,
            &format!("原持有会话 {}", removed.token),
        );
        drop(leases);
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

    /// 写闸：principal 须持覆盖 port_key 的活跃租约。
    /// Err(文案) 附当前持有者与到期时间，引导先 lease_acquire。
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
        let leases = self.list();
        if leases
            .iter()
            .any(|l| l.token == token && l.grants.iter().any(|g| g.covers(port_key)))
        {
            return Ok(());
        }
        let holders: Vec<String> = leases
            .iter()
            .filter(|l| l.grants.iter().any(|g| g.covers(port_key)))
            .map(|l| format!("{}（至 {}）", l.label, lease_fmt(l.expires_at)))
            .collect();
        let holder_info = if holders.is_empty() {
            "当前无人持有".into()
        } else {
            format!("当前持有: {}", holders.join("、"))
        };
        audit::log(
            audit::EV_WRITE_DENIED,
            Some(token),
            "session",
            None,
            &[port_key.to_string()],
            &holder_info,
        );
        Err(format!(
            "写操作「{port_key}」被租约闸拒绝：本会话未持覆盖它的租约（{holder_info}）。先 lease_acquire"
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
                let keys: Vec<String> = expired.grants.iter().map(|g| g.key.clone()).collect();
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

/// 展开作用域为 grant 集。返回 (grants, 跳过的失效成员描述)。
/// - topology：成员即 grant（失效的跳过——设备删除/端口拔掉不阻塞申请其余）；
/// - devices：逐个须为已注册设备（local/SSH/远端）；
/// - endpoints：逐个走成员定型（resolve_member，支持别名/昵称）。
fn expand_scope(scope: &Scope, state: &AppState) -> Result<(Vec<Grant>, Vec<String>), String> {
    let mut grants: Vec<Grant> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    if let Some(tid) = &scope.topology {
        let topo = topology::find(tid)
            .ok_or_else(|| format!("拓扑不存在: {tid}（topo_list 可查）"))?;
        for m in &topo.members {
            if member_still_valid(m.kind, &m.key, state) {
                grants.push(Grant {
                    kind: m.kind,
                    key: m.key.clone(),
                });
            } else {
                skipped.push(m.key.clone());
            }
        }
    }
    for id in &scope.devices {
        if !device_valid(id, state) {
            return Err(format!(
                "「{id}」不是已注册设备（local/SSH 设备 id/远端设备 id）"
            ));
        }
        grants.push(Grant::device(id.clone()));
    }
    for key in &scope.endpoints {
        let m = topology::resolve_member(key, state)
            .map_err(|e| format!("endpoints 项「{key}」无法定型: {e}"))?;
        grants.push(Grant {
            kind: m.kind,
            key: m.key,
        });
    }

    // 自身重复 = 覆盖集合自交（如 devices 传了设备又 endpoints 传它的端口），拒绝。
    for (i, a) in grants.iter().enumerate() {
        if grants[i + 1..].iter().any(|b| grants_intersect(a, b)) {
            return Err(format!(
                "申请项覆盖重叠（如同一设备与其端点同时出现）: {}",
                a.key
            ));
        }
    }
    if grants.is_empty() {
        return Err("申请范围为空（拓扑无成员或全部失效）".into());
    }
    Ok((grants, skipped))
}

/// 设备键是否仍有效（local / SSH / 远端注册表）。
fn device_valid(id: &str, state: &AppState) -> bool {
    if id == ss_core::LOCAL_DEVICE_ID {
        return true;
    }
    state.ssh.has_host(id) || state.devices.device_views().iter().any(|(d, _)| d.id == id)
}

/// 拓扑成员在申请时点是否仍有效：设备查注册表；端点——本机端口须在位，
/// SSH 端点须在注册表，远端端点验设备注册（端口桶可能离线为空，透传）。
fn member_still_valid(kind: MemberKind, key: &str, state: &AppState) -> bool {
    match kind {
        MemberKind::Device => device_valid(key, state),
        MemberKind::Endpoint => {
            let (first, rest) = ss_core::split_port_key(key);
            if first == ss_core::LOCAL_DEVICE_ID {
                ss_core::serial::list_port_names()
                    .iter()
                    .any(|p| p.eq_ignore_ascii_case(rest))
            } else if let Some(rec) = state
                .ssh
                .registry_snapshot()
                .into_iter()
                .find(|r| r.id == first)
            {
                rec.endpoints.iter().any(|e| e.name == rest)
            } else {
                state
                    .devices
                    .device_views()
                    .iter()
                    .any(|(d, _)| d.id == first)
            }
        }
    }
}

/// 展示用时间（去掉时区尾巴，UI/文本场景短些）。
fn lease_fmt(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%m-%d %H:%M").to_string()
}

/// 剩余分钟（向下取整；负值不会出现——过期即被清扫）。
pub fn remaining_minutes(l: &Lease) -> i64 {
    (l.expires_at - chrono::Local::now()).num_minutes().max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::make_state;

    fn manager(cfg: LeaseConfig) -> Arc<LeaseManager> {
        let (tx, _) = broadcast::channel(16);
        LeaseManager::new(cfg, tx)
    }

    fn scope(devices: &[&str]) -> Scope {
        Scope {
            topology: None,
            devices: devices.iter().map(|s| s.to_string()).collect(),
            endpoints: vec![],
        }
    }

    #[test]
    fn covers_matrix() {
        let dev_local = Grant::device("local");
        assert!(dev_local.covers("COM3"), "device local 覆盖裸名");
        assert!(!dev_local.covers("ssh-x1::shell"), "local 不覆盖其它设备");
        let dev_ssh = Grant::device("ssh-x1");
        assert!(dev_ssh.covers("ssh-x1::shell"));
        assert!(dev_ssh.covers("ssh-x1::shell@2"), "设备覆盖其实例行");
        assert!(!dev_ssh.covers("ssh-x2::shell"));
        let ep = Grant {
            kind: MemberKind::Endpoint,
            key: "ssh-x1::shell".into(),
        };
        assert!(ep.covers("ssh-x1::shell"));
        assert!(ep.covers("ssh-x1::shell@3"), "端点覆盖实例行");
        assert!(!ep.covers("ssh-x1::ttyS0"), "同设备其它端点不覆盖");
        assert!(!ep.covers("ssh-x2::shell"));
        let ep_local = Grant {
            kind: MemberKind::Endpoint,
            key: "COM3".into(),
        };
        assert!(ep_local.covers("COM3"), "本机端点覆盖自身");
        assert!(!ep_local.covers("COM4"));
    }

    #[test]
    fn intersect_device_vs_endpoint() {
        let dev = Grant::device("ssh-x1");
        let ep = Grant {
            kind: MemberKind::Endpoint,
            key: "ssh-x1::shell".into(),
        };
        assert!(grants_intersect(&dev, &ep), "设备与同设备端点相交");
        let other = Grant::device("ssh-x2");
        assert!(!grants_intersect(&dev, &other));
        assert!(!grants_intersect(&ep, &other));
    }

    #[tokio::test]
    async fn acquire_conflict_and_exclusivity() {
        let state = make_state();
        let m = manager(LeaseConfig::default());
        let a = m
            .acquire("token-a", "agent-a", &scope(&["ssh-x1"]), None, &state)
            .unwrap();
        assert_eq!(a.grants.len(), 1);

        // 同设备再申请（另一会话）→ 冲突，附持有者明细
        match m.acquire("token-b", "agent-b", &scope(&["ssh-x1"]), None, &state) {
            Err(AcquireError::Conflict(cs)) => {
                assert_eq!(cs.len(), 1);
                assert_eq!(cs[0].holder, "agent-a");
                assert_eq!(cs[0].lease_id, a.id);
            }
            other => panic!("应冲突: {other:?}"),
        }

        // 设备被占，其端点也不可得（覆盖集合相交）
        let ep_scope = Scope {
            endpoints: vec!["ssh-x1::shell".into()],
            ..scope(&[])
        };
        assert!(matches!(
            m.acquire("token-b", "agent-b", &ep_scope, None, &state),
            Err(AcquireError::Conflict(_))
        ));

        // 其它设备不受影响
        assert!(
            m.acquire("token-b", "agent-b", &scope(&["ssh-x2"]), None, &state)
                .is_ok()
        );

        // 自身重叠（设备 + 其端点）→ Invalid
        let overlap = Scope {
            endpoints: vec!["ssh-x1::shell".into()],
            ..scope(&["ssh-x1"])
        };
        assert!(matches!(
            m.acquire("token-c", "agent-c", &overlap, None, &state),
            Err(AcquireError::Invalid(_))
        ));

        // 拿到前的租约数不受失败申请影响（all-or-nothing）
        assert_eq!(m.list().len(), 2);
    }

    #[tokio::test]
    async fn renew_release_auth_and_force() {
        let state = make_state();
        let m = manager(LeaseConfig::default());
        let a = m
            .acquire("token-a", "agent-a", &scope(&["ssh-x1"]), None, &state)
            .unwrap();

        // 非 holder 续/放 → 拒
        assert!(m.renew(&a.id, "token-b", None).is_err());
        assert!(m.release(&a.id, "token-b").is_err());

        // holder 续租顺延
        let renewed = m.renew(&a.id, "token-a", None).unwrap();
        assert!(renewed.expires_at > a.expires_at);

        // 人工强释放不验 token
        m.force_release(&a.id).unwrap();
        assert!(m.list().is_empty());
        assert!(m.release(&a.id, "token-a").is_err(), "释放后租约不存在");
    }

    #[tokio::test]
    async fn ttl_clamp_and_expiry() {
        let state = make_state();
        let cfg = LeaseConfig {
            ttl_minutes: 30,
            max_ttl_minutes: 60,
            enable_gate: true,
        };
        let m = manager(cfg);
        // 超上限夹到 60
        let a = m
            .acquire("token-a", "a", &scope(&["ssh-x1"]), Some(9999), &state)
            .unwrap();
        assert_eq!((a.expires_at - a.acquired_at).num_minutes(), 60);

        // 到期 → 惰性清扫 + 闸拒绝
        assert!(m.gate(Some("token-a"), "ssh-x1::shell").is_ok(), "租约期内的端点写放行");
        m.force_expire(&a.id);
        assert!(m.list().is_empty(), "读取路径清扫过期租约");
        assert!(m.gate(Some("token-a"), "ssh-x1::shell").is_err());
        // 过期后设备可被他人申请
        assert!(
            m.acquire("token-b", "b", &scope(&["ssh-x1"]), None, &state)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn gate_requires_matching_token_lease() {
        let state = make_state();
        let m = manager(LeaseConfig::default());
        // 匿名 → 拒（文案引导）
        assert!(m.gate(None, "COM3").is_err());
        // 有 token 无租约 → 拒
        assert!(m.gate(Some("token-a"), "COM3").is_err());
        // token-a 拿下 local → 覆盖本机任意端口写；token-b 仍拒
        m.acquire("token-a", "a", &scope(&["local"]), None, &state)
            .unwrap();
        assert!(m.gate(Some("token-a"), "COM99").is_ok());
        assert!(m.gate(Some("token-b"), "COM99").is_err());
    }
}

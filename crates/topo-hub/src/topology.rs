//! 拓扑类型、成员定型与 topologies.json 存储。
//!
//! 成员引用两种粒度（设备 / 端点），创建与修改时经 [`resolve_member`] 定型——
//! 类型字段落盘，消费侧（租约覆盖判定、UI 分组）不解析字符串猜语义。
//! 存储照 remotes_store 模式：进程内锁串行化 fs、损坏文件回退空、全量读写。

use serde::{Deserialize, Serialize};
use ss_server::AppState;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 成员引用粒度。设备 = 该设备全部端点及其实例行；端点 = 单端点及其实例行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberKind {
    Device,
    Endpoint,
}

impl MemberKind {
    pub fn label(&self) -> &'static str {
        match self {
            MemberKind::Device => "设备",
            MemberKind::Endpoint => "端点",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopologyMember {
    pub kind: MemberKind,
    /// 设备 id 或端口复合键（定型后的规范形式，别名/昵称已解析）。
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Topology {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub members: Vec<TopologyMember>,
    /// 设备间连线（拓扑图渲染用）。from/to 引用成员键（创建/修改时校验）。
    #[serde(default)]
    pub links: Vec<TopologyLink>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopologyLink {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// 创建/修改请求里的原始成员输入（key 未定型，可以是别名/昵称作用域）。
#[derive(Debug, Clone, Deserialize)]
pub struct MemberInput {
    pub key: String,
    #[serde(default)]
    pub note: Option<String>,
}

/// 创建/修改请求里的原始连线输入（from/to 未定型，可写别名）。
#[derive(Debug, Clone, Deserialize)]
pub struct LinkInput {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub label: Option<String>,
}

// ===== 存储 =====

/// 进程内串行化所有 topologies.json 的 fs 访问。
static LOCK: Mutex<()> = Mutex::new(());

fn file_at(dir: &Path) -> PathBuf {
    dir.join("topologies.json")
}

fn read_locked(p: &Path) -> Vec<Topology> {
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_locked(p: &Path, list: &[Topology]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

/// 名称合法性（save 的闸门）：非空；同表唯一（id 与 name 都是查找键）。
fn validate_names(list: &[Topology]) -> Result<(), String> {
    for t in list {
        if t.name.trim().is_empty() {
            return Err(format!("拓扑 {} 的名称不能为空白", t.id));
        }
    }
    for (i, a) in list.iter().enumerate() {
        if list[i + 1..].iter().any(|b| b.name == a.name) {
            return Err(format!("拓扑名称「{}」重复，请换一个", a.name));
        }
    }
    Ok(())
}

pub fn load() -> Vec<Topology> {
    let _g = LOCK.lock().expect("topology store lock poisoned");
    ss_server::config::config_dir()
        .map(|d| read_locked(&file_at(&d)))
        .unwrap_or_default()
}

pub fn save(list: &[Topology]) -> Result<(), String> {
    validate_names(list)?;
    let _g = LOCK.lock().expect("topology store lock poisoned");
    let p = ss_server::config::config_dir()
        .map(|d| file_at(&d))
        .ok_or("无法定位配置目录")?;
    write_locked(&p, list)
}

/// 按 id 或名称查找。
pub fn find(id_or_name: &str) -> Option<Topology> {
    let key = id_or_name.trim();
    load().into_iter().find(|t| t.id == key || t.name == key)
}

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// 创建拓扑：成员逐个定型（全部合法才落盘），返回错误列出全部非法键。
/// 连线端点定型后须与成员键精确匹配（成员的子端点不算，写成员键本身）。
pub fn create(
    name: &str,
    description: &str,
    members: &[MemberInput],
    links: &[LinkInput],
    state: &AppState,
) -> Result<Topology, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("拓扑名称不能为空白".into());
    }
    let mut list = load();
    if list.iter().any(|t| t.name == name) {
        return Err(format!("拓扑名称「{name}」已存在，请换一个"));
    }
    let resolved = resolve_all(members, state)?;
    let keys: Vec<&String> = resolved.iter().map(|m| &m.key).collect();
    let resolved_links = resolve_links(links, &keys, state)?;
    let topo = Topology {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        description: description.trim().into(),
        members: resolved,
        links: resolved_links,
        created_at: now(),
        updated_at: now(),
    };
    list.push(topo.clone());
    save(&list)?;
    Ok(topo)
}

/// 更新拓扑：名称/描述/成员/连线均可选更新；成员/连线提供时整体替换。
pub fn update(
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    members: Option<&[MemberInput]>,
    links: Option<&[LinkInput]>,
    state: &AppState,
) -> Result<Topology, String> {
    let mut list = load();
    let topo = list
        .iter_mut()
        .find(|t| t.id == id || t.name == id.trim())
        .ok_or_else(|| format!("拓扑不存在: {id}"))?;
    if let Some(n) = name {
        let n = n.trim();
        if n.is_empty() {
            return Err("拓扑名称不能为空白".into());
        }
        topo.name = n.into();
    }
    if let Some(d) = description {
        topo.description = d.trim().into();
    }
    if let Some(m) = members {
        topo.members = resolve_all(m, state)?;
    }
    if let Some(l) = links {
        let keys: Vec<&String> = topo.members.iter().map(|m| &m.key).collect();
        topo.links = resolve_links(l, &keys, state)?;
    }
    topo.updated_at = now();
    let updated = topo.clone();
    save(&list)?;
    Ok(updated)
}

pub fn delete(id: &str) -> Result<Topology, String> {
    let mut list = load();
    let pos = list
        .iter()
        .position(|t| t.id == id || t.name == id.trim())
        .ok_or_else(|| format!("拓扑不存在: {id}"))?;
    let removed = list.remove(pos);
    save(&list)?;
    Ok(removed)
}

/// 批量定型：收集全部错误一次性报告（AI 一次改对，不来回试错）。
fn resolve_all(inputs: &[MemberInput], state: &AppState) -> Result<Vec<TopologyMember>, String> {
    let mut members = Vec::with_capacity(inputs.len());
    let mut errors = Vec::new();
    for input in inputs {
        match resolve_member(&input.key, state) {
            Ok(mut m) => {
                m.note = input.note.clone().filter(|n| !n.trim().is_empty());
                members.push(m);
            }
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() {
        Ok(members)
    } else {
        Err(errors.join("\n"))
    }
}

/// 连线定型：from/to 各经成员定型（别名可用），端点须与成员键精确匹配且不自环。
fn resolve_links(
    inputs: &[LinkInput],
    member_keys: &[&String],
    state: &AppState,
) -> Result<Vec<TopologyLink>, String> {
    let mut links = Vec::with_capacity(inputs.len());
    let mut errors = Vec::new();
    for input in inputs {
        let resolve_end = |raw: &str| -> Result<TopologyMember, String> {
            let m = resolve_member(raw, state)?;
            if !member_keys.contains(&&m.key) {
                return Err(format!(
                    "连线端点「{raw}」（定型为 {key}）不是本拓扑成员，请先加入成员或改用成员键",
                    key = m.key
                ));
            }
            Ok(m)
        };
        match (resolve_end(&input.from), resolve_end(&input.to)) {
            (Ok(f), Ok(t)) => {
                if f.key == t.key {
                    errors.push(format!("连线「{} ↔ {}」两端是同一成员", input.from, input.to));
                } else {
                    links.push(TopologyLink {
                        from: f.key,
                        to: t.key,
                        label: input.label.clone().filter(|l| !l.trim().is_empty()),
                    });
                }
            }
            (Err(e), _) | (_, Err(e)) => errors.push(e),
        }
    }
    if errors.is_empty() {
        Ok(links)
    } else {
        Err(errors.join("\n"))
    }
}

/// 单个成员定型：原始键（真名/别名/昵称作用域均可）→ (kind, 规范键)。
///
/// 规则：
/// - `local` → 设备（本机全部串口）；
/// - 裸名：本机串口（或其别名）→ 端点；已注册设备 id（SSH/远端）→ 设备；
/// - 复合键：首段须为已注册 SSH/远端设备；SSH 端点须存在于注册表且非实例行
///   （`shell@2` 拒绝，成员引用端点定义）；远端端点只验设备注册
///   （设备离线时端口桶为空，端点名不校验，透传）。
pub fn resolve_member(raw: &str, state: &AppState) -> Result<TopologyMember, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("成员键为空".into());
    }
    if key == ss_core::LOCAL_DEVICE_ID {
        return Ok(TopologyMember {
            kind: MemberKind::Device,
            key: key.into(),
            note: None,
        });
    }
    // 别名/昵称作用域 → 规范键（manager 边界的单点解析，MCP/WS 同源）。
    let canon = state.manager.canon_key(key);
    let (first, rest) = ss_core::split_port_key(&canon);
    let ssh_known = |id: &str| state.ssh.has_host(id);
    let remote_known =
        |id: &str| state.devices.device_views().iter().any(|(d, _)| d.id == id);

    // 裸名（canon 后仍在 local 作用域）：真名/别名解析结果命中本机端口表 → 端点；
    // 命中设备注册表 → 设备键。
    if first == ss_core::LOCAL_DEVICE_ID {
        if ss_core::serial::list_port_names()
            .iter()
            .any(|p| p.eq_ignore_ascii_case(rest))
        {
            return Ok(TopologyMember {
                kind: MemberKind::Endpoint,
                key: rest.into(),
                note: None,
            });
        }
        if ssh_known(rest) || remote_known(rest) {
            return Ok(TopologyMember {
                kind: MemberKind::Device,
                key: rest.into(),
                note: None,
            });
        }
        return Err(format!(
            "「{raw}」既不是本机端口（或其别名），也不是已注册设备"
        ));
    }

    // 复合键：首段须为已注册 SSH/远端设备。
    if rest.is_empty() {
        return Err(format!("「{raw}」缺少端点名（格式应为 设备::端点）"));
    }
    if ssh_known(first) {
        let rec = state
            .ssh
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == first)
            .expect("has_host 与 registry_snapshot 同源");
        if rest.contains('@') {
            return Err(format!(
                "「{canon}」是运行实例行；成员引用端点定义，请去掉 @N 后缀"
            ));
        }
        if !rec.endpoints.iter().any(|e| e.name == rest) {
            let names: Vec<&str> = rec.endpoints.iter().map(|e| e.name.as_str()).collect();
            return Err(format!(
                "SSH 设备「{}」没有端点「{rest}」；已有端点: {}",
                rec.label(),
                names.join("、")
            ));
        }
    } else if !remote_known(first) {
        return Err(format!(
            "「{canon}」的首段不是已注册设备（SSH 或远程设备）"
        ));
    }
    Ok(TopologyMember {
        kind: MemberKind::Endpoint,
        key: canon,
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::make_state;
    use std::sync::Mutex as TestMutex;

    /// store 测试串行（共享 SERIAL_STUDIO_CONFIG_DIR 与 topologies.json，防互踩）。
    static TEST_LOCK: TestMutex<()> = TestMutex::new(());

    fn member(key: &str) -> MemberInput {
        MemberInput {
            key: key.into(),
            note: None,
        }
    }

    #[tokio::test]
    async fn resolve_local_device_and_ssh() {
        let state = make_state();
        assert_eq!(
            resolve_member("local", &state).unwrap().kind,
            MemberKind::Device
        );
        let m = resolve_member("ssh-x1", &state).unwrap();
        assert_eq!(m.kind, MemberKind::Device);
        let m = resolve_member("ssh-x1::shell", &state).unwrap();
        assert_eq!(m.kind, MemberKind::Endpoint);
        assert_eq!(m.key, "ssh-x1::shell");
    }

    #[tokio::test]
    async fn resolve_rejects_unknown_and_instance() {
        let state = make_state();
        assert!(resolve_member("no-such-dev", &state).is_err());
        assert!(resolve_member("no-such-dev::com", &state).is_err());
        assert!(resolve_member("ssh-x1::shell@2", &state).is_err());
        assert!(resolve_member("ssh-x1::ttyS9", &state)
            .unwrap_err()
            .contains("已有端点"));
    }

    #[tokio::test]
    async fn store_roundtrip_and_name_rules() {
        let _g = TEST_LOCK.lock().unwrap();
        crate::test_support::ensure_test_config_dir();
        let state = make_state();

        let t = create("冒烟拓扑", "测试", &[member("ssh-x1")], &[], &state)
            .expect("创建");
        assert_eq!(t.members.len(), 1);
        assert_eq!(find(&t.id).unwrap().name, "冒烟拓扑");
        assert!(create("冒烟拓扑", "", &[], &[], &state).is_err(), "重名拒绝");

        let t2 = update(&t.id, None, Some("改述"), None, None, &state).unwrap();
        assert_eq!(t2.description, "改述");
        assert_eq!(t2.created_at, t.created_at, "未动成员不改 created_at");

        let removed = delete(&t.id).unwrap();
        assert_eq!(removed.name, "冒烟拓扑");
        assert!(delete(&t.id).is_err());
    }

    #[tokio::test]
    async fn links_resolve_and_validate() {
        let _g = TEST_LOCK.lock().unwrap();
        crate::test_support::ensure_test_config_dir();
        let state = make_state();
        // 名称唯一化：topologies.json 在共享 tempdir 跨测试运行持久
        let n = crate::test_support::unique_name("连线");

        let members = vec![member("ssh-x1"), member("ssh-x2")];
        let links = vec![LinkInput {
            from: "ssh-x1".into(),
            to: "ssh-x2::shell".into(), // 端点定型后 ≠ 成员键（成员是设备 ssh-x2）
            label: Some("console".into()),
        }];
        let err = create(&format!("坏-{n}"), "", &members, &links, &state).unwrap_err();
        assert!(err.contains("不是本拓扑成员"), "{err}");

        // 两端均为成员键 → 通过并定型
        let links_ok = vec![LinkInput {
            from: "ssh-x1".into(),
            to: "ssh-x2".into(),
            label: None,
        }];
        let t = create(&n, "", &members, &links_ok, &state).unwrap();
        assert_eq!(t.links.len(), 1);
        assert_eq!(t.links[0].from, "ssh-x1");

        // 自环拒绝
        let self_loop = vec![LinkInput {
            from: "ssh-x1".into(),
            to: "ssh-x1".into(),
            label: None,
        }];
        assert!(create(&format!("环-{n}"), "", &members, &self_loop, &state).is_err());

        // update 整体替换 links；成员未变时按现行成员校验
        let updated = update(&t.id, None, None, None, Some(&[]), &state).unwrap();
        assert!(updated.links.is_empty(), "空 links 清空连线");

        delete(&t.id).unwrap();
    }

    #[tokio::test]
    async fn create_reports_all_invalid_members() {
        let _g = TEST_LOCK.lock().unwrap();
        crate::test_support::ensure_test_config_dir();
        let state = make_state();
        let err = create(
            "全错拓扑",
            "",
            &[member("nope-a"), member("nope-b")],
            &[],
            &state,
        )
        .unwrap_err();
        assert!(err.contains("nope-a") && err.contains("nope-b"), "一次报全: {err}");
    }
}

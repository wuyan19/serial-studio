//! 拓扑类型与 topologies.json 存储（P2.5：成员纯设备引用——设备是被测对象
//! 的一等实体，见 device.rs；成员不再直接引用端口/SSH 键，连线维度同为设备）。
//! 存储照 remotes_store 模式：进程内锁串行化 fs、损坏文件回退空、全量读写。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopologyMember {
    /// 被测设备 id（device.rs 注册表）。同一设备可加入多个拓扑（引用不独占）。
    pub device: String,
    /// 画布横坐标（编辑器拖拽位置持久化；旧数据/未摆过的为 0，前端圆形布局兜底）。
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
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
    /// 设备间连线（拓扑图渲染用）。from/to 引用成员设备 id。
    #[serde(default)]
    pub links: Vec<TopologyLink>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopologyLink {
    pub from: String,
    pub to: String,
    /// from 端设备上的端口标签（如 "GE1/1/1"，自由文本——物理口不一定是接入通道）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_port: Option<String>,
    /// to 端设备上的端口标签（如 "eth0"）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_port: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// 创建/修改请求里的原始成员输入（device 可传 id 或名称）。
#[derive(Debug, Clone, Deserialize)]
pub struct MemberInput {
    pub device: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub note: Option<String>,
}

/// 创建/修改请求里的原始连线输入（from/to 可传设备 id 或名称）。
#[derive(Debug, Clone, Deserialize)]
pub struct LinkInput {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub from_port: Option<String>,
    #[serde(default)]
    pub to_port: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

// ===== 存储 =====

static LOCK: Mutex<()> = Mutex::new(());

fn file_at(dir: &Path) -> PathBuf {
    dir.join("topologies.json")
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

/// 读 topologies.json。检测到旧形态成员（`{kind,key}`，P2.5 前）时执行一次性
/// 迁移：每个旧键包装成一台设备（串口端点键→串口通道、SSH 键→SSH 通道，
/// `local`/无法识别的跳过），迁完重写 topologies.json 与 devices.json。
pub fn load() -> Vec<Topology> {
    let _g = LOCK.lock().expect("topology store lock poisoned");
    let Some(dir) = ss_server::config::config_dir() else {
        return Vec::new();
    };
    let path = file_at(&dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    // 新形态解析失败且原文含旧成员标记 → 走迁移
    match serde_json::from_str::<Vec<Topology>>(&raw) {
        Ok(list) => list,
        Err(_) => {
            let (migrated, devices, changed) = migrate_legacy(&raw);
            if changed {
                let _ = write_locked(&path, &migrated);
                // 设备表与拓扑表共用 device store 的锁——此处已持 topology 锁，
                // device::save 内部锁不同 Mutex，无死锁（两锁无嵌套反向获取）。
                let mut all = crate::device::load();
                for d in devices {
                    if !all.iter().any(|x| x.name == d.name) {
                        all.push(d);
                    }
                }
                let dev_path = dir.join("devices.json");
                let _ = std::fs::write(
                    &dev_path,
                    serde_json::to_string_pretty(&all).unwrap_or_default(),
                );
                tracing::info!("旧拓扑成员已迁移为设备引用（{} 台设备包装）", all.len());
            }
            migrated
        }
    }
}

/// 旧文件 → (新拓扑表, 新建设备表, 是否有变化)。命名尽力而为：
/// SSH 键查凭据库取标签；串口键用端口名；`local` 与未知键跳过该成员。
fn migrate_legacy(raw: &str) -> (Vec<Topology>, Vec<crate::device::Device>, bool) {
    #[derive(Deserialize)]
    struct LegacyMember {
        kind: String,
        key: String,
        #[serde(default)]
        note: Option<String>,
    }
    #[derive(Deserialize)]
    struct LegacyTopology {
        id: String,
        name: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        members: Vec<LegacyMember>,
        created_at: String,
        updated_at: String,
    }
    let Ok(legacy) = serde_json::from_str::<Vec<LegacyTopology>>(raw) else {
        return (Vec::new(), Vec::new(), false);
    };
    let ssh_hosts = ss_server::ssh::store::load();
    let mut devices: Vec<crate::device::Device> = Vec::new();
    let mut wrap = |kind: &str, key: &str| -> Option<String> {
        use crate::device::{Channel, Device, SshChannelConfig};
        let _ = kind;
        // split_port_key 对裸名返回 (local, 键本身)——设备段按"复合键取首段、
        // 裸名取键本身"归一，再判 local / SSH / 串口。
        let first_seg = key
            .split_once(ss_core::PORT_KEY_SEP)
            .map(|(f, _)| f)
            .unwrap_or(key);
        let channels: Vec<Channel> = if key == ss_core::LOCAL_DEVICE_ID {
            // local 整机成员（本机全部串口）在新模型无对应——跳过
            return None;
        } else if let Some(h) = ssh_hosts.iter().find(|h| h.id == first_seg) {
            // SSH 键（裸设备键或 hostId::shell 端点键）→ 内联凭据通道
            vec![Channel::Ssh(SshChannelConfig {
                id: h.id.clone(),
                host: h.host.clone(),
                port: h.port,
                username: h.username.clone(),
                nickname: h.nickname.clone(),
                auth: h.auth.clone(),
            })]
        } else {
            // 本机串口裸名或级联端口键 → 串口通道（port 存原键，默认参数）
            vec![Channel::Serial {
                port: key.to_string(),
                config: ss_core::SerialConfig::default(),
            }]
        };
        let name = channels[0].label();
        let id = uuid::Uuid::new_v4().to_string();
        devices.push(Device {
            id: id.clone(),
            name: name.clone(),
            model: String::new(),
            location: String::new(),
            channels,
        });
        Some(id)
    };
    let migrated = legacy
        .into_iter()
        .map(|t| Topology {
            id: t.id,
            name: t.name,
            description: t.description,
            members: t
                .members
                .iter()
                .filter_map(|m| {
                    wrap(&m.kind, &m.key).map(|device| TopologyMember {
                        device,
                        x: 0.0,
                        y: 0.0,
                        note: m.note.clone(),
                    })
                })
                .collect(),
            links: Vec::new(), // 旧连线引用端口键，设备维度无对应——丢弃（冒烟期数据）
            created_at: t.created_at,
            updated_at: t.updated_at,
        })
        .collect();
    let changed = !devices.is_empty();
    (migrated, devices, changed)
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

/// 创建拓扑：成员设备逐个解析（须存在于注册表），全部合法才落盘。
/// 连线 from/to 经设备解析后须与成员设备精确匹配（写成员设备 id 本身）。
pub fn create(
    name: &str,
    description: &str,
    members: &[MemberInput],
    links: &[LinkInput],
) -> Result<Topology, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("拓扑名称不能为空白".into());
    }
    let mut list = load();
    if list.iter().any(|t| t.name == name) {
        return Err(format!("拓扑名称「{name}」已存在，请换一个"));
    }
    let resolved = resolve_members(members)?;
    let resolved_links = resolve_links(links, &resolved)?;
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
        topo.members = resolve_members(m)?;
        // members 整体替换而 links 未提供时，剪除指向已移除成员的悬空连线
        // （与画布编辑器删除节点级联删线的语义一致；links 提供时会整体重建，无需处理）。
        if links.is_none() {
            let ids: std::collections::HashSet<&str> =
                topo.members.iter().map(|m| m.device.as_str()).collect();
            topo.links
                .retain(|l| ids.contains(l.from.as_str()) && ids.contains(l.to.as_str()));
        }
    }
    if let Some(l) = links {
        topo.links = resolve_links(l, &topo.members)?;
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

/// 成员解析：device 可传 id 或名称，须存在于注册表；同一设备重复出现时保留
/// 首个（节点 id 即设备 id，重复成员会让画布渲染未定义）；收集全部错误一次报告。
fn resolve_members(inputs: &[MemberInput]) -> Result<Vec<TopologyMember>, String> {
    let mut members = Vec::with_capacity(inputs.len());
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for input in inputs {
        match crate::device::find(&input.device) {
            Some(d) if seen.insert(d.id.clone()) => members.push(TopologyMember {
                device: d.id,
                x: input.x,
                y: input.y,
                note: input.note.clone().filter(|n| !n.trim().is_empty()),
            }),
            Some(_) => {} // 重复成员：保留首个
            None => errors.push(format!(
                "设备「{}」不存在（device_get 可查，先 device_create 注册）",
                input.device
            )),
        }
    }
    if errors.is_empty() {
        Ok(members)
    } else {
        Err(errors.join("\n"))
    }
}

/// 连线解析：from/to 经设备解析（id 或名称），须是本拓扑成员且不自环；
/// 同一对设备（含反向）重复时保留首个（边 id 由设备对构成，重复会撞 id）。
fn resolve_links(
    inputs: &[LinkInput],
    members: &[TopologyMember],
) -> Result<Vec<TopologyLink>, String> {
    let resolve_end = |raw: &str| -> Result<String, String> {
        let d =
            crate::device::find(raw).ok_or_else(|| format!("连线端点「{raw}」不是已注册设备"))?;
        if !members.iter().any(|m| m.device == d.id) {
            return Err(format!(
                "连线端点「{raw}」（{}）不是本拓扑成员，请先加入成员",
                d.name
            ));
        }
        Ok(d.id)
    };
    let mut links = Vec::with_capacity(inputs.len());
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for input in inputs {
        match (resolve_end(&input.from), resolve_end(&input.to)) {
            (Ok(f), Ok(t)) => {
                if f == t {
                    errors.push(format!(
                        "连线「{} ↔ {}」两端是同一设备",
                        input.from, input.to
                    ));
                    continue;
                }
                // 无序对归一后去重（同向/反向重复都只保留首个）
                let key = if f < t {
                    (f.clone(), t.clone())
                } else {
                    (t.clone(), f.clone())
                };
                if !seen.insert(key) {
                    continue;
                }
                links.push(TopologyLink {
                    from: f,
                    to: t,
                    from_port: input.from_port.clone().filter(|p| !p.trim().is_empty()),
                    to_port: input.to_port.clone().filter(|p| !p.trim().is_empty()),
                    label: input.label.clone().filter(|l| !l.trim().is_empty()),
                });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{self, Channel, DeviceInput};
    use crate::test_support::{ensure_test_config_dir, make_state, unique_name};

    // 全局 store 锁见 test_support::STORE_LOCK 注释（三模块共享两份 JSON）。
    use crate::test_support::STORE_LOCK as TEST_LOCK;

    fn member(device: &str) -> MemberInput {
        MemberInput {
            device: device.into(),
            x: 0.0,
            y: 0.0,
            note: None,
        }
    }

    fn link(from: &str, to: &str) -> LinkInput {
        LinkInput {
            from: from.into(),
            to: to.into(),
            from_port: None,
            to_port: None,
            label: None,
        }
    }

    /// 建两台设备返回 (nameA, nameB)。
    async fn seed_devices(state: &ss_server::AppState) -> (String, String) {
        let a = unique_name("设备A");
        let b = unique_name("设备B");
        device::create(
            &DeviceInput {
                name: a.clone(),
                model: String::new(),
                location: String::new(),
                channels: vec![Channel::Serial {
                    port: "COM4".into(),
                    config: ss_core::SerialConfig::default(),
                }],
            },
            state,
        )
        .unwrap();
        device::create(
            &DeviceInput {
                name: b.clone(),
                model: String::new(),
                location: String::new(),
                channels: vec![Channel::Ssh(crate::device::SshChannelConfig {
                    id: "ssh-x1".into(),
                    host: "192.0.2.70".into(),
                    port: 22,
                    username: "root".into(),
                    nickname: None,
                    auth: ss_server::ssh::SshAuthRecord::Agent,
                })],
            },
            state,
        )
        .unwrap();
        (a, b)
    }

    #[tokio::test]
    async fn member_and_link_device_resolution() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let (a, b) = seed_devices(&state).await;
        let n = unique_name("拓扑");

        // 未知设备 → 一次报全
        let err = create(&n, "", &[member("ghost"), member("ghost2")], &[]).unwrap_err();
        assert!(err.contains("ghost") && err.contains("ghost2"), "{err}");

        // 正常创建：成员可传名称；连线端点也可传名称（定型为设备 id）
        let t = create(&n, "测试", &[member(&a), member(&b)], &[link(&a, &b)]).unwrap();
        assert_eq!(t.members.len(), 2);
        assert_eq!(t.links.len(), 1);
        let dev_b = device::find(&b).unwrap();
        assert_eq!(t.links[0].to, dev_b.id, "连线定型为设备 id");

        // 自环拒绝
        let err = create(&unique_name("拓扑"), "", &[member(&a)], &[link(&a, &a)]).unwrap_err();
        assert!(err.contains("同一设备"), "{err}");

        // 连线端点不是成员
        let err = create(&unique_name("拓扑"), "", &[member(&a)], &[link(&a, &b)]).unwrap_err();
        assert!(err.contains("不是本拓扑成员"), "{err}");

        // 设备删除被拓扑引用拦截
        let err = device::delete(&t.members[0].device, &state).unwrap_err();
        assert!(err.contains(&n), "错误应列出引用拓扑: {err}");

        delete(&t.id).unwrap();
        device::delete(&dev_b.id, &state).unwrap();
    }

    #[tokio::test]
    async fn device_can_join_multiple_topologies() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let (a, b) = seed_devices(&state).await;
        let dev_a = device::find(&a).unwrap();

        let t1 = create(&unique_name("拓扑一"), "", &[member(&a), member(&b)], &[]).unwrap();
        let t2 = create(&unique_name("拓扑二"), "", &[member(&a)], &[]).unwrap();
        // 同一设备出现在两个拓扑（引用不独占），各自成员视图独立
        assert!(t1.members.iter().any(|m| m.device == dev_a.id));
        assert!(t2.members.iter().any(|m| m.device == dev_a.id));
        // 两拓扑均可加载
        assert_eq!(load().len(), 2);
        // 设备删除仍被两拓扑引用拦截
        let err = device::delete(&dev_a.id, &state).unwrap_err();
        assert!(err.contains(&t1.name) && err.contains(&t2.name), "{err}");

        delete(&t1.id).unwrap();
        delete(&t2.id).unwrap();
        device::delete(&dev_a.id, &state).unwrap();
    }

    #[tokio::test]
    async fn link_ports_and_positions_roundtrip() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let (a, b) = seed_devices(&state).await;

        let m = |d: &str, x: f64, y: f64| MemberInput {
            device: d.into(),
            x,
            y,
            note: None,
        };
        let l = LinkInput {
            from: a.clone(),
            to: b.clone(),
            from_port: Some("GE1/1/1".into()),
            to_port: Some("  ".into()), // 空白端口 → None
            label: Some("上联".into()),
        };
        let t = create(
            &unique_name("端口拓扑"),
            "",
            &[m(&a, 120.5, -40.0), m(&b, 0.0, 0.0)],
            &[l],
        )
        .unwrap();

        let [ma, mb] = [&t.members[0], &t.members[1]];
        assert_eq!((ma.x, ma.y), (120.5, -40.0));
        assert_eq!((mb.x, mb.y), (0.0, 0.0), "未摆位坐标原样保存");
        let link = &t.links[0];
        assert_eq!(link.from_port.as_deref(), Some("GE1/1/1"));
        assert_eq!(link.to_port, None, "空白端口标签过滤为 None");
        assert_eq!(link.label.as_deref(), Some("上联"));

        // 落盘重读 round-trip
        let re = find(&t.id).unwrap();
        assert_eq!(re.members[0].x, 120.5);
        assert_eq!(re.links[0].from_port.as_deref(), Some("GE1/1/1"));

        delete(&t.id).unwrap();
        for d in crate::device::load() {
            let _ = device::delete(&d.id, &state);
        }
    }

    #[tokio::test]
    async fn update_members_prunes_dangling_links_and_dedupes() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let (a, b) = seed_devices(&state).await;
        let dev_b = device::find(&b).unwrap().id;

        // 重复成员/重复连线（含反向）在创建时去重
        let t = create(
            &unique_name("去重拓扑"),
            "",
            &[member(&a), member(&a), member(&b)],
            &[link(&a, &b), link(&a, &b), link(&b, &a)],
        )
        .unwrap();
        assert_eq!(t.members.len(), 2, "重复成员只保留一个");
        assert_eq!(t.links.len(), 1, "同对设备连线（含反向重复）只保留一条");

        // members 整体替换而 links 未提供：悬空连线被剪除
        let updated = update(&t.id, None, None, Some(&[member(&a)]), None).unwrap();
        assert_eq!(updated.members.len(), 1);
        assert!(
            updated.links.is_empty(),
            "指向被移除成员的连线应剪除，实际: {:?}",
            updated.links
        );

        delete(&t.id).unwrap();
        device::delete(&dev_b, &state).unwrap();
    }

    #[tokio::test]
    async fn legacy_migration_wraps_devices() {
        let _g = TEST_LOCK.lock().unwrap();
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        // 迁移按真实 ssh.json 识别 SSH 键——先落凭据 fixture
        let state = make_state();
        let rec = state
            .ssh
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == "ssh-x1")
            .unwrap();
        ss_server::ssh::store::save(&[rec]).unwrap();
        // 直接写旧形态文件（绕过 save 的新类型）
        let dir = ss_server::config::config_dir().unwrap();
        let legacy = serde_json::json!([{
            "id": "topo-legacy",
            "name": unique_name("旧拓扑"),
            "description": "",
            "members": [
                { "kind": "endpoint", "key": "COM4", "note": "串口成员" },
                { "kind": "device", "key": "ssh-x1" },
                { "kind": "device", "key": "local" }
            ],
            "links": [],
            "created_at": "2026-01-01T00:00:00+08:00",
            "updated_at": "2026-01-01T00:00:00+08:00"
        }]);
        std::fs::write(dir.join("topologies.json"), legacy.to_string()).unwrap();

        let list = load();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].members.len(), 2, "local 整机成员被跳过");
        // 成员已是设备 id；包装出的设备通道正确
        let d1 = device::find(&list[0].members[0].device).unwrap();
        assert!(matches!(&d1.channels[0], Channel::Serial { port, .. } if port == "COM4"));
        let d2 = device::find(&list[0].members[1].device).unwrap();
        assert!(matches!(&d2.channels[0], Channel::Ssh(s) if s.id == "ssh-x1"));
        assert!(
            d2.name.contains("车间网关"),
            "SSH 设备用凭据标签命名: {}",
            d2.name
        );
        // 重读不再迁移（文件已是新形态）
        assert_eq!(load().len(), 1);

        // 清理迁移产物
        delete(&list[0].id).unwrap();
        for d in crate::device::load() {
            let _ = device::delete(&d.id, &state);
        }
    }
}

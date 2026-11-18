//! Shared connection grouping, independent from each client's display preferences.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::sync::broadcast;

type Memberships = BTreeMap<String, Vec<String>>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupData {
    pub names: Vec<String>,
    pub assignments: Memberships,
    pub ssh_assignments: Memberships,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub server_id: String,
    pub revision: u64,
    #[serde(flatten)]
    pub data: GroupData,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
    Create {
        name: String,
    },
    Rename {
        name: String,
        #[serde(rename = "newName")]
        new_name: String,
    },
    Dissolve {
        name: String,
    },
    Membership {
        kind: MemberKind,
        id: String,
        name: String,
        included: bool,
    },
    Migrate {
        #[serde(rename = "sourceId")]
        source_id: String,
        data: GroupData,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberKind {
    Port,
    Ssh,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    revision: u64,
    #[serde(flatten)]
    data: GroupData,
    imported_sources: Vec<String>,
}

pub struct PortGroupsStore {
    path: Option<PathBuf>,
    server_id: String,
    state: Mutex<Result<Stored, String>>,
    changes: broadcast::Sender<()>,
}

impl PortGroupsStore {
    pub fn from_config(server_id: &str) -> Self {
        match crate::config::config_dir() {
            Some(dir) => Self::at(Some(dir.join("port-groups.json")), server_id),
            None => Self::with_state(None, server_id, Err("无法定位分组配置目录".into())),
        }
    }

    fn at(path: Option<PathBuf>, server_id: &str) -> Self {
        let state = match path.as_ref().map(std::fs::read_to_string) {
            None => Ok(Stored::default()),
            Some(Ok(raw)) => serde_json::from_str::<Stored>(&raw)
                .map_err(|e| format!("分组配置损坏，请保留文件并修复：{e}"))
                .and_then(|stored| {
                    validate_data(&stored.data)?;
                    Ok(stored)
                }),
            Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
            Some(Err(e)) => Err(format!("读取分组配置失败：{e}")),
        };
        Self::with_state(path, server_id, state)
    }

    fn with_state(path: Option<PathBuf>, server_id: &str, state: Result<Stored, String>) -> Self {
        let (changes, _) = broadcast::channel(16);
        Self {
            path,
            server_id: server_id.into(),
            state: Mutex::new(state),
            changes,
        }
    }

    pub fn memory(server_id: &str) -> Self {
        Self::at(None, server_id)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }

    fn snapshot(&self, stored: &Stored) -> Snapshot {
        Snapshot {
            server_id: self.server_id.clone(),
            revision: stored.revision,
            data: stored.data.clone(),
        }
    }

    pub fn get(&self) -> Result<Snapshot, String> {
        let state = self.state.lock().map_err(|_| "分组存储锁不可用")?;
        state
            .as_ref()
            .map(|s| self.snapshot(s))
            .map_err(Clone::clone)
    }

    pub fn update(&self, operation: Operation) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "分组存储锁不可用")?;
        let old = state.as_ref().map_err(Clone::clone)?;
        let mut next = old.clone();
        apply(&mut next, operation)?;
        validate_data(&next.data)?;
        if &next == old {
            return Ok(self.snapshot(old));
        }
        next.revision = old.revision.checked_add(1).ok_or("分组版本号超出范围")?;
        if let Some(path) = &self.path {
            let raw = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, raw).map_err(|e| format!("保存分组失败：{e}"))?;
            std::fs::rename(&tmp, path).map_err(|e| format!("保存分组失败：{e}"))?;
        }
        let snapshot = self.snapshot(&next);
        *state = Ok(next);
        let _ = self.changes.send(());
        Ok(snapshot)
    }
}

fn name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 || trimmed.chars().any(char::is_control) {
        return Err("分组名称需为 1–64 个字符且不含控制字符".into());
    }
    Ok(trimmed.into())
}

fn identity(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err("分组设备标识无效".into());
    }
    Ok(())
}

fn validate_data(data: &GroupData) -> Result<(), String> {
    if data.names.len() > 256 || data.assignments.len() + data.ssh_assignments.len() > 20000 {
        return Err("分组或设备数量超出限制".into());
    }
    let mut seen = std::collections::HashSet::new();
    for group in &data.names {
        if name(group)? != *group || !seen.insert(group) {
            return Err("分组名称重复或无效".into());
        }
    }
    for (id, groups) in data.assignments.iter().chain(data.ssh_assignments.iter()) {
        identity(id)?;
        let mut seen = std::collections::HashSet::new();
        for group in groups {
            if !data.names.contains(group) || !seen.insert(group) {
                return Err("分组关联无效".into());
            }
        }
    }
    Ok(())
}

fn apply(state: &mut Stored, operation: Operation) -> Result<(), String> {
    let data = &mut state.data;
    match operation {
        Operation::Create { name: value } => {
            let value = name(&value)?;
            if data.names.contains(&value) {
                return Err("分组名称已存在".into());
            }
            data.names.push(value);
        }
        Operation::Rename {
            name: old,
            new_name,
        } => {
            let new = name(&new_name)?;
            if old == new {
                return Ok(());
            }
            if data.names.contains(&new) {
                return Err("分组名称已存在".into());
            }
            let group = data
                .names
                .iter_mut()
                .find(|n| **n == old)
                .ok_or("分组不存在")?;
            *group = new.clone();
            for groups in data
                .assignments
                .values_mut()
                .chain(data.ssh_assignments.values_mut())
            {
                for group in groups {
                    if *group == old {
                        *group = new.clone();
                    }
                }
            }
        }
        Operation::Dissolve { name } => {
            data.names.retain(|n| *n != name);
            for memberships in [&mut data.assignments, &mut data.ssh_assignments] {
                memberships.retain(|_, groups| {
                    groups.retain(|g| *g != name);
                    !groups.is_empty()
                });
            }
        }
        Operation::Membership {
            kind,
            id,
            name,
            included,
        } => {
            identity(&id)?;
            if !data.names.contains(&name) {
                return Err("分组不存在，请刷新后重试".into());
            }
            let memberships = match kind {
                MemberKind::Port => &mut data.assignments,
                MemberKind::Ssh => &mut data.ssh_assignments,
            };
            let groups = memberships.entry(id.clone()).or_default();
            if included {
                if !groups.contains(&name) {
                    groups.push(name);
                }
            } else {
                groups.retain(|g| *g != name);
            }
            if groups.is_empty() {
                memberships.remove(&id);
            }
        }
        Operation::Migrate {
            source_id,
            data: imported,
        } => {
            identity(&source_id)?;
            if state.imported_sources.contains(&source_id) {
                return Ok(());
            }
            if state.imported_sources.len() >= 4096 {
                return Err("分组迁移来源数量超出限制".into());
            }
            validate_data(&imported)?;
            for name in imported.names {
                if !data.names.contains(&name) {
                    data.names.push(name);
                }
            }
            for (target, source) in [
                (&mut data.assignments, imported.assignments),
                (&mut data.ssh_assignments, imported.ssh_assignments),
            ] {
                for (id, groups) in source {
                    let existing = target.entry(id).or_default();
                    for group in groups {
                        if !existing.contains(&group) {
                            existing.push(group);
                        }
                    }
                }
            }
            state.imported_sources.push(source_id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn create(store: &PortGroupsStore, value: &str) -> Snapshot {
        store
            .update(Operation::Create { name: value.into() })
            .unwrap()
    }
    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ss-groups-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn memberships_rename_and_dissolve() {
        let store = PortGroupsStore::memory("server");
        create(&store, "Lab");
        create(&store, "Other");
        for group in ["Lab", "Other"] {
            store
                .update(Operation::Membership {
                    kind: MemberKind::Port,
                    id: "remote::child::COM1".into(),
                    name: group.into(),
                    included: true,
                })
                .unwrap();
        }
        store
            .update(Operation::Membership {
                kind: MemberKind::Ssh,
                id: "ssh-id".into(),
                name: "Lab".into(),
                included: true,
            })
            .unwrap();
        store
            .update(Operation::Rename {
                name: "Lab".into(),
                new_name: "New".into(),
            })
            .unwrap();
        assert_eq!(store.get().unwrap().data.ssh_assignments["ssh-id"], ["New"]);
        let snapshot = store
            .update(Operation::Dissolve { name: "New".into() })
            .unwrap();
        assert_eq!(snapshot.data.assignments["remote::child::COM1"], ["Other"]);
        assert!(snapshot.data.ssh_assignments.is_empty());
    }

    #[test]
    fn concurrent_updates_do_not_lose_groups() {
        let store = Arc::new(PortGroupsStore::memory("server"));
        let threads: Vec<_> = (0..20)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || create(&store, &format!("Group{i}")))
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(store.get().unwrap().data.names.len(), 20);
        assert_eq!(store.get().unwrap().revision, 20);
    }

    #[test]
    fn migration_is_durable_and_does_not_resurrect_deleted_groups() {
        let dir = dir();
        let path = dir.join("port-groups.json");
        let store = PortGroupsStore::at(Some(path.clone()), "server");
        let op = Operation::Migrate {
            source_id: "desktop-v1".into(),
            data: GroupData {
                names: vec!["Lab".into()],
                ..GroupData::default()
            },
        };
        store.update(op.clone()).unwrap();
        let revision = store.update(op.clone()).unwrap().revision;
        assert_eq!(revision, 1);
        store
            .update(Operation::Dissolve { name: "Lab".into() })
            .unwrap();
        drop(store);
        let store = PortGroupsStore::at(Some(path), "server");
        let result = store.update(op).unwrap();
        assert_eq!(result.revision, 2);
        assert!(result.data.names.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_write_leaves_state_and_notifications_unchanged() {
        let dir = dir();
        let store =
            PortGroupsStore::at(Some(dir.join("missing").join("port-groups.json")), "server");
        let mut rx = store.subscribe();
        assert!(store
            .update(Operation::Create { name: "Lab".into() })
            .is_err());
        assert_eq!(store.get().unwrap().revision, 0);
        assert!(rx.try_recv().is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_is_not_overwritten_and_invalid_updates_are_rejected() {
        let dir = dir();
        let path = dir.join("port-groups.json");
        std::fs::write(&path, "broken").unwrap();
        let store = PortGroupsStore::at(Some(path.clone()), "server");
        assert!(store.get().is_err());
        assert!(store
            .update(Operation::Create { name: "Lab".into() })
            .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
        let store = PortGroupsStore::memory("server");
        assert!(store
            .update(Operation::Create { name: " ".into() })
            .is_err());
        assert!(store
            .update(Operation::Membership {
                kind: MemberKind::Ssh,
                id: "host".into(),
                name: "unknown".into(),
                included: true
            })
            .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

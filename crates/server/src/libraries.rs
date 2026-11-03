//! Shared macro and script libraries backed by the existing configuration files.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Macros,
    Scripts,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Change {
    pub before: Option<Value>,
    pub after: Option<Value>,
}

pub type Changes = BTreeMap<String, Change>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub items: Value,
    pub server_id: String,
}

pub fn get(kind: Kind, server_id: &str) -> Result<Snapshot, String> {
    let items = match kind {
        Kind::Macros => serde_json::to_value(crate::macros_store::load_checked()?),
        Kind::Scripts => serde_json::to_value(crate::scripts_store::load_checked()?),
    }
    .map_err(|e| e.to_string())?;
    Ok(Snapshot {
        items,
        server_id: server_id.into(),
    })
}

pub fn patch(kind: Kind, changes: &Changes, server_id: &str) -> Result<Snapshot, String> {
    let items = match kind {
        Kind::Macros => serde_json::to_value(crate::macros_store::patch(changes)?),
        Kind::Scripts => serde_json::to_value(crate::scripts_store::patch(changes)?),
    }
    .map_err(|e| e.to_string())?;
    Ok(Snapshot {
        items,
        server_id: server_id.into(),
    })
}

pub(crate) fn read_checked<T: DeserializeOwned>(
    path: &Path,
) -> Result<BTreeMap<String, T>, String> {
    match std::fs::read(path) {
        Ok(raw) => {
            serde_json::from_slice(&raw).map_err(|e| format!("库文件损坏，请保留文件并修复：{e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("读取库文件失败：{e}")),
    }
}

pub(crate) fn write_atomic<T: Serialize>(
    path: &Path,
    items: &BTreeMap<String, T>,
) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("保存库文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存库文件失败：{e}"))
}

pub(crate) fn patch_locked<T: DeserializeOwned + Serialize>(
    path: &Path,
    changes: &Changes,
) -> Result<BTreeMap<String, T>, String> {
    if changes.len() > 10000 {
        return Err("本次修改条目过多".into());
    }
    let mut items: BTreeMap<String, T> = read_checked(path)?;
    for (name, change) in changes {
        if name.trim().is_empty()
            || name != name.trim()
            || name.chars().count() > 256
            || name.chars().any(char::is_control)
        {
            return Err("库条目名称无效".into());
        }
        let current = items
            .get(name)
            .map(serde_json::to_value)
            .transpose()
            .map_err(|e| e.to_string())?;
        let before = change
            .before
            .as_ref()
            .map(|value| serde_json::from_value::<T>(value.clone()).and_then(serde_json::to_value))
            .transpose()
            .map_err(|e| format!("条目原值无效：{e}"))?;
        if current != before {
            return Err(format!("「{name}」已被其他客户端修改，请刷新后重试"));
        }
    }
    for (name, change) in changes {
        match &change.after {
            Some(value) => {
                items.insert(
                    name.clone(),
                    serde_json::from_value(value.clone())
                        .map_err(|e| format!("库条目格式无效：{e}"))?,
                );
            }
            None => {
                items.remove(name);
            }
        }
    }
    if !changes.is_empty() {
        write_atomic(path, &items)?;
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ss-libraries-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn change(before: Option<Value>, after: Option<Value>) -> Changes {
        BTreeMap::from([("test".into(), Change { before, after })])
    }
    #[test]
    fn legacy_files_and_conflicting_edits_are_preserved() {
        let dir = directory();
        let path = dir.join("macros.json");
        std::fs::write(&path, r#"{"legacy":{"steps":[]}}"#).unwrap();
        let first: BTreeMap<String, ss_core::Macro> = read_checked(&path).unwrap();
        assert!(first.contains_key("legacy"));
        let next = serde_json::json!({"steps":[],"group":"Lab"});
        patch_locked::<ss_core::Macro>(&path, &change(None, Some(next.clone()))).unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert!(patch_locked::<ss_core::Macro>(&path, &change(None, Some(next.clone()))).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), raw);
        let loaded: BTreeMap<String, ss_core::Macro> = read_checked(&path).unwrap();
        assert_eq!(loaded.len(), 2);
        patch_locked::<ss_core::Macro>(&path, &change(Some(next), None)).unwrap();
        assert!(read_checked::<ss_core::Macro>(&path)
            .unwrap()
            .contains_key("legacy"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_and_invalid_patches_do_not_overwrite_files() {
        let dir = directory();
        let path = dir.join("scripts.json");
        std::fs::write(&path, "broken").unwrap();
        assert!(patch_locked::<ss_core::Script>(
            &path,
            &change(None, Some(serde_json::json!({"code":"1"})))
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::write(&path, "{}").unwrap();
        assert!(patch_locked::<ss_core::Script>(
            &path,
            &change(None, Some(serde_json::json!({"steps":[]})))
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(patch_locked::<ss_core::Script>(
            &path,
            &change(None, Some(serde_json::json!({"code":"1"})))
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

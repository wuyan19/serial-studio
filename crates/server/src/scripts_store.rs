//! 脚本持久化:配置目录 scripts.json(系统 app data 目录,见 config::config_dir)。
//!
//! 与 macros_store 同构:脚本是用户配置,跟着用户走。服务端不持有脚本状态——
//! run_script 时前端把整个 Script 对象发来执行。首次运行无文件 → 空。
//!
//! 两条写入路径并存:
//! - **前端全量**(Tauri `save_scripts`):内存权威整张覆盖,用 [`load`]/[`save`]。
//! - **MCP 单条**(无状态调用方):不能假定持有整张 map,用 [`upsert`]/[`remove`]
//!   做按 key 的原子操作(load-modify-save 在锁内一次完成)。
//!
//! 所有 fs 操作经进程内 [`LOCK`] 串行化——Tauri 全量 save 与 MCP 单条 upsert 是两个写者,
//! 无锁会在 fs 层交错损坏文件。锁只保证**操作不交错、文件不损坏**;**不保证 UI 与 MCP
//! 并发编辑的最终一致性**:前端"内存权威 + 全量覆盖"仍可能覆盖 MCP 的增量改动,后写为准
//! (与 macros 现状一致,彻底解决需推翻"服务端不持有脚本状态"设计,不值当)。

use ss_core::Script;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 进程内串行化所有 scripts.json 的 fs 访问(load/save/upsert/remove)。
/// 读写之间的交错在此排队,避免半写状态或文件损坏。
static LOCK: Mutex<()> = Mutex::new(());

/// 定位 scripts.json 所在目录:公开 API 内直接调用 [`crate::config::config_dir`]。

fn file_at(dir: &Path) -> PathBuf {
    dir.join("scripts.json")
}

/// 在指定目录读 scripts.json(不存在或解析失败 → 空)。
fn load_from(dir: &Path) -> BTreeMap<String, Script> {
    let _g = LOCK.lock().expect("scripts store lock poisoned");
    read_locked(&file_at(dir))
}

/// 在指定目录全量写 scripts.json(前端整张覆盖)。
fn save_to(dir: &Path, map: &BTreeMap<String, Script>) -> Result<(), String> {
    let _g = LOCK.lock().expect("scripts store lock poisoned");
    write_locked(&file_at(dir), map)?;
    Ok(())
}

/// 在指定目录插入/覆盖单个脚本,返回被覆盖的旧值(新建时为 None)。
/// load-modify-save 在锁内原子完成(无状态调用方的单条入口)。
fn upsert_in(dir: &Path, name: &str, script: Script) -> Result<Option<Script>, String> {
    let _g = LOCK.lock().expect("scripts store lock poisoned");
    let p = file_at(dir);
    let mut map = read_locked(&p);
    let old = map.insert(name.to_string(), script);
    write_locked(&p, &map)?;
    Ok(old)
}

/// 在指定目录删除单个脚本,返回被删值(无此名 None,幂等不报错)。
fn remove_in(dir: &Path, name: &str) -> Result<Option<Script>, String> {
    let _g = LOCK.lock().expect("scripts store lock poisoned");
    let p = file_at(dir);
    let mut map = read_locked(&p);
    let old = map.remove(name);
    if old.is_some() {
        write_locked(&p, &map)?;
    }
    Ok(old)
}

// ===== 锁内纯 fs 原语(调用方已持锁) =====

fn read_locked(p: &Path) -> BTreeMap<String, Script> {
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn write_locked(p: &Path, map: &BTreeMap<String, Script>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

// ===== 公开 API:无目录参数,定位配置目录(Tauri / MCP 调用) =====

/// 读 scripts.json(不存在或解析失败 → 空)。
pub fn load() -> BTreeMap<String, Script> {
    crate::config::config_dir().map(|d| load_from(&d)).unwrap_or_default()
}

/// 全量写 scripts.json(前端 Tauri 用:内存权威整张覆盖)。
pub fn save(map: &BTreeMap<String, Script>) -> Result<(), String> {
    let dir = crate::config::config_dir().ok_or("无法定位配置目录")?;
    save_to(&dir, map)
}

/// 插入/覆盖单个脚本,返回旧值(覆盖时 Some,新建时 None)。供 MCP 等无状态调用方。
pub fn upsert(name: &str, script: Script) -> Result<Option<Script>, String> {
    let dir = crate::config::config_dir().ok_or("无法定位配置目录")?;
    upsert_in(&dir, name, script)
}

/// 删除单个脚本,返回被删值(无此名 None,幂等不报错)。
pub fn remove(name: &str) -> Result<Option<Script>, String> {
    let dir = crate::config::config_dir().ok_or("无法定位配置目录")?;
    remove_in(&dir, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个独立临时目录(进程 id + 计数),互不污染、可并发,不碰 exe 目录。
    fn fresh_dir() -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "ss-scripts-test-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(code: &str) -> Script {
        Script {
            description: None,
            group: None,
            params: Vec::new(),
            code: code.into(),
        }
    }

    #[test]
    fn upsert_new_returns_none_then_loads() {
        let dir = fresh_dir();
        let old = upsert_in(&dir, "blink", script("await send(\"AT\")")).unwrap();
        assert!(old.is_none(), "首次插入应返回 None");
        let map = load_from(&dir);
        assert_eq!(map.len(), 1);
        assert_eq!(map["blink"].code, "await send(\"AT\")");
    }

    #[test]
    fn upsert_overwrite_returns_old() {
        let dir = fresh_dir();
        upsert_in(&dir, "ping", script("v1")).unwrap();
        let old = upsert_in(&dir, "ping", script("v2")).unwrap();
        assert_eq!(old.as_ref().unwrap().code, "v1", "覆盖应返回旧 code");
        assert_eq!(load_from(&dir)["ping"].code, "v2");
    }

    #[test]
    fn remove_returns_old_then_idempotent() {
        let dir = fresh_dir();
        upsert_in(&dir, "x", script("c")).unwrap();
        let removed = remove_in(&dir, "x").unwrap();
        assert_eq!(removed.as_ref().unwrap().code, "c");
        assert!(!load_from(&dir).contains_key("x"));

        // 幂等:删不存在的 name 不报错、返 None
        let again = remove_in(&dir, "x").unwrap();
        assert!(again.is_none());
    }

    #[test]
    fn load_missing_dir_is_empty() {
        let dir = fresh_dir();
        assert!(load_from(&dir).is_empty(), "无文件应返空而非报错");
    }

    #[test]
    fn corrupted_file_falls_back_to_empty() {
        let dir = fresh_dir();
        std::fs::write(file_at(&dir), "not json {{{").unwrap();
        // 损坏文件不应 panic,应返空(load 路径)且 upsert 能恢复(读空→写入)
        assert!(load_from(&dir).is_empty());
        upsert_in(&dir, "recovered", script("ok")).unwrap();
        assert!(load_from(&dir).contains_key("recovered"));
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = fresh_dir();
        let mut map = BTreeMap::new();
        map.insert("a".into(), script("1"));
        map.insert("b".into(), script("2"));
        save_to(&dir, &map).unwrap();
        let loaded = load_from(&dir);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded["a"].code, "1");
    }

    /// 并发 upsert 不同 key 不丢数据(锁串行化):每线程写自己的 key,最终全在。
    #[test]
    fn concurrent_upsert_different_keys_no_loss() {
        let dir = fresh_dir();
        let dir = std::sync::Arc::new(dir);
        let mut handles = vec![];
        for i in 0..8 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                upsert_in(&dir, &format!("k{}", i), script(&format!("c{}", i))).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let map = load_from(&dir);
        assert_eq!(map.len(), 8, "并发写不同 key 应全部保留: {:?}", map.keys().collect::<Vec<_>>());
    }
}

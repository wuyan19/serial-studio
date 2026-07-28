//! 脚本持久化:exe 同目录 scripts.json。
//!
//! 与 macros_store 同构:脚本是用户配置,由前端(Tauri 控制面 invoke)读写,跟着用户走。
//! 服务端不持有脚本状态——run_script 时前端把整个 Script 对象发来执行。
//! 首次运行无文件 → 空。

use ss_core::Script;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("scripts.json"))
}

/// 读 scripts.json(不存在或解析失败 → 空)。
pub fn load() -> BTreeMap<String, Script> {
    match path() {
        Some(p) if p.exists() => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        },
        _ => BTreeMap::new(),
    }
}

/// 写 scripts.json。
pub fn save(map: &BTreeMap<String, Script>) -> Result<(), String> {
    let p = path().ok_or("无法定位 exe 目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

//! 宏持久化：exe 同目录 macros.json。
//!
//! 宏是**用户配置**，由前端（Tauri 控制面 invoke）读写，跟着用户走。
//! 服务端不持有宏状态——run_macro 时前端把整个 Macro 对象发来执行。
//! 首次运行无文件 → 空（无内置示例，由用户自己创建）。

use ss_core::Macro;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("macros.json"))
}

/// 读 macros.json（不存在或解析失败 → 空）。
pub fn load() -> BTreeMap<String, Macro> {
    match path() {
        Some(p) if p.exists() => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        },
        _ => BTreeMap::new(),
    }
}

/// 写 macros.json。
pub fn save(map: &BTreeMap<String, Macro>) -> Result<(), String> {
    let p = path().ok_or("无法定位 exe 目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

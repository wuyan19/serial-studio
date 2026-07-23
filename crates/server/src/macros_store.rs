//! 宏持久化：exe 同目录 macros.json。
//!
//! 格式：{ "宏名": { "description": "...", "steps": [...] }, ... }
//! 首次运行无文件时用内置示例宏（仅内存，用户首次改动后才落盘）。

use ss_core::{Macro, MacroStep};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("macros.json"))
}

/// 读 macros.json。文件不存在 → 内置示例宏（演示用）。
pub fn load() -> BTreeMap<String, Macro> {
    match path() {
        Some(p) if p.exists() => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        },
        _ => default_macros(),
    }
}

/// 写 macros.json。
pub fn save(map: &BTreeMap<String, Macro>) -> Result<(), String> {
    let p = path().ok_or("无法定位 exe 目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

/// 内置示例宏（首次运行演示）。
fn default_macros() -> BTreeMap<String, Macro> {
    let mut m = BTreeMap::new();
    m.insert(
        "at_test".into(),
        Macro {
            description: Some("AT 测试：发送 AT，等待 OK".into()),
            steps: vec![
                MacroStep::Send {
                    data: "AT".into(),
                    format: "text".into(),
                    auto_newline: true,
                },
                MacroStep::Expect {
                    pattern: "OK".into(),
                    timeout_ms: 3000,
                },
            ],
        },
    );
    m.insert(
        "clear_buf".into(),
        Macro {
            description: Some("清空接收缓冲区".into()),
            steps: vec![MacroStep::Clear],
        },
    );
    m
}

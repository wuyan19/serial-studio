//! 服务器设置：监听地址/端口，持久化到 exe 同目录 settings.json。
//!
//! Tauri 启动时 load() 读，WS save_settings 写。运行中的监听不可热改，
//! 修改后需重启进程才生效（前端会提示）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_ws_host")]
    pub ws_host: String,
    #[serde(default = "default_ws_port")]
    pub ws_port: u16,
    #[serde(default = "default_telnet_port")]
    pub telnet_port: u16,
}

fn default_ws_host() -> String {
    "0.0.0.0".into()
}
fn default_ws_port() -> u16 {
    18700
}
fn default_telnet_port() -> u16 {
    18701
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ws_host: default_ws_host(),
            ws_port: default_ws_port(),
            telnet_port: default_telnet_port(),
        }
    }
}

/// exe 同目录的 settings.json 路径。
fn settings_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("settings.json"))
}

/// 读 settings.json（不存在或解析失败 → 默认）。
pub fn load() -> Settings {
    match settings_path() {
        Some(p) if p.exists() => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Settings::default(),
        },
        _ => Settings::default(),
    }
}

/// 写 settings.json。
pub fn save(s: &Settings) -> Result<(), String> {
    let p = settings_path().ok_or("无法定位 exe 目录")?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

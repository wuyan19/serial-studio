//! 远程设备列表持久化：配置目录 remotes.json（系统 app data 目录，见 config::config_dir）。
//!
//! 桌面端（Tauri）经 load_remotes/save_remotes 读写：用户配置的已知远程设备，跟着机器走。
//! Web/远程窗口不持久化（由 connConfig 派生单设备）。与 macros_store 同构：进程内锁串行化
//! fs，损坏文件回退空。无单条 API——前端始终全量覆盖（不像 scripts_store 要给 MCP upsert）。

use ss_core::RemoteDevice;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 进程内串行化所有 remotes.json 的 fs 访问（load/save）。
static LOCK: Mutex<()> = Mutex::new(());

fn file_at(dir: &Path) -> PathBuf {
    dir.join("remotes.json")
}

// ===== 锁内纯 fs 原语（调用方已持锁） =====

fn read_locked(p: &Path) -> Vec<RemoteDevice> {
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_locked(p: &Path, list: &[RemoteDevice]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

// ===== 公开 API：无目录参数，定位配置目录（Tauri 调用） =====

/// 读 remotes.json（不存在或解析失败 → 空）。
pub fn load() -> Vec<RemoteDevice> {
    let _g = LOCK.lock().expect("remotes store lock poisoned");
    crate::config::config_dir()
        .map(|d| read_locked(&file_at(&d)))
        .unwrap_or_default()
}

/// 全量写 remotes.json（前端 Tauri 用：内存权威整张覆盖）。
pub fn save(list: &[RemoteDevice]) -> Result<(), String> {
    let _g = LOCK.lock().expect("remotes store lock poisoned");
    let p = crate::config::config_dir()
        .map(|d| file_at(&d))
        .ok_or("无法定位配置目录")?;
    write_locked(&p, list)
}

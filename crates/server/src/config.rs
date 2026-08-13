//! 配置目录定位：统一所有持久化 JSON 的存放位置。
//!
//! 默认落在系统配置目录下的 `serial-studio/` 子目录——
//! macOS=`~/Library/Application Support/serial-studio`、Windows=`%APPDATA%\serial-studio`、
//! Linux=`~/.config/serial-studio`。避免写在 exe 同目录：macOS 升级 .app bundle 覆盖会丢配置。
//!
//! `SERIAL_STUDIO_CONFIG_DIR` 环境变量可覆盖（测试钩子 + headless 固定配置位置）。

use std::path::PathBuf;

/// 配置目录覆盖环境变量（测试钩子；生产可让 headless 固定配置位置）。
pub const CONFIG_DIR_ENV: &str = "SERIAL_STUDIO_CONFIG_DIR";

/// 定位配置目录并确保其存在。
///
/// 优先级：`SERIAL_STUDIO_CONFIG_DIR` 环境变量 > 系统配置目录下的 `serial-studio/`。
/// 返回 None 的情形：环境变量未设且系统无配置目录（无 HOME 的极端环境）——
/// store 的 save 据此报错、load 回退默认（与原 exe 目录定位失败的处理一致）。
pub fn config_dir() -> Option<PathBuf> {
    let dir = match std::env::var(CONFIG_DIR_ENV) {
        Ok(custom) if !custom.is_empty() => PathBuf::from(custom),
        _ => dirs::config_dir()?.join("serial-studio"),
    };
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

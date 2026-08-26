//! 服务器设置：监听地址/端口，持久化到配置目录 settings.json（系统 app data 目录，
//! 见 config::config_dir；SERIAL_STUDIO_CONFIG_DIR 可覆盖）。
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
    /// 是否允许远程(WS/MCP)执行 JS 脚本。默认 false:服务器默认 0.0.0.0 无认证,
    /// 远程能跑脚本 = 潜在 RCE 面,须显式开启。本地 Tauri 不受此开关限制。
    #[serde(default = "default_enable_scripting")]
    pub enable_scripting: bool,
    /// 本实例全局身份(段名=实例 id 的根基)。**生成一次、落盘、永不变**——身份的
    /// 全部价值在于把不同时刻/不同视角的记录(对端缓存里的路径链、授权、路径优选)
    /// 对上号,记忆比会话长,身份就必须比会话长。经 [`instance_id`] 取用(缺失时
    /// 生成并回写),不要直接读此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
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
fn default_enable_scripting() -> bool {
    false
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ws_host: default_ws_host(),
            ws_port: default_ws_port(),
            telnet_port: default_telnet_port(),
            enable_scripting: default_enable_scripting(),
            instance_id: None,
        }
    }
}

/// 取本实例全局身份:settings 已有则用之;首次(或旧版配置文件)生成 uuid v4
/// 并立即回写——保证下次进程读到同一 id(身份跨重启稳定是硬约束)。
/// 生成只在进程生命周期发生一次(create_state 调用),无并发竞争。
pub fn instance_id() -> String {
    let mut s = load();
    if let Some(id) = s.instance_id.as_deref() {
        if !id.is_empty() {
            return id.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    s.instance_id = Some(id.clone());
    if let Err(e) = save(&s) {
        // 落盘失败仍返回本次生成的 id:身份在本次进程内一致,仅跨重启会变。
        // warn 而非 err——只读文件系统/测试环境下可继续运行。
        tracing::warn!("实例 id 落盘失败(跨重启身份将不稳定): {}", e);
    }
    id
}

/// 配置目录下的 settings.json 路径。
fn settings_path() -> Option<PathBuf> {
    Some(crate::config::config_dir()?.join("settings.json"))
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
    let p = settings_path().ok_or("无法定位配置目录")?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

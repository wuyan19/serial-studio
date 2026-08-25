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
/// 昵称不合规(手编文件)不阻断载入——下游解析有 warn+透传兜底——但留痕提醒。
pub fn load() -> Vec<RemoteDevice> {
    let _g = LOCK.lock().expect("remotes store lock poisoned");
    let list = crate::config::config_dir()
        .map(|d| read_locked(&file_at(&d)))
        .unwrap_or_default();
    if let Err(e) = validate_nicknames(&list) {
        tracing::warn!("remotes.json 设备昵称不合规(保存时将被拦截): {e}");
    }
    list
}

/// 全量写 remotes.json（前端 Tauri 用：内存权威整张覆盖）。
/// 写前校验设备昵称(寻址语义的硬约束,见 validate_nicknames)。
pub fn save(list: &[RemoteDevice]) -> Result<(), String> {
    validate_nicknames(list)?;
    let _g = LOCK.lock().expect("remotes store lock poisoned");
    let p = crate::config::config_dir()
        .map(|d| file_at(&d))
        .ok_or("无法定位配置目录")?;
    write_locked(&p, list)
}

/// 设备昵称校验(唯一写入口 save 的闸门)。昵称是寻址词汇(`test::COM5` 的首段),
/// 规则破坏即键空间污染:
/// - 非空白、不含复合键分隔符 `::`(会破坏首段切分);
/// - 不占用遗留标记字 `local`(裸名剥除规则保留字,占用了就永远无法按昵称寻址);
/// - 跨设备唯一(重复则裸昵称输入欠定——与端口别名同机的 last-write-wins 去重对齐)。
fn validate_nicknames(list: &[RemoteDevice]) -> Result<(), String> {
    let mut seen: Vec<(&str, &str)> = Vec::new(); // (昵称, 设备id) 查重
    for d in list {
        let Some(nick) = d.nickname.as_deref() else {
            continue; // 未设昵称合法
        };
        if nick.trim().is_empty() {
            return Err(format!("设备 {}({})的昵称不能为空白", d.id, d.host));
        }
        if nick.contains(ss_core::PORT_KEY_SEP) {
            return Err(format!(
                "设备昵称不能包含「{}」(复合键分隔符): {nick}",
                ss_core::PORT_KEY_SEP
            ));
        }
        if nick == "local" {
            return Err("设备昵称不能为「local」(系统保留字)".to_string());
        }
        if let Some((_, other)) = seen.iter().find(|(n, _)| *n == nick) {
            return Err(format!(
                "设备昵称「{nick}」重复(已用于设备 {other}),请换一个"
            ));
        }
        seen.push((nick, d.id.as_str()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, nick: Option<&str>) -> RemoteDevice {
        RemoteDevice {
            id: id.into(),
            host: "127.0.0.1".into(),
            port: 18700,
            nickname: nick.map(str::to_string),
        }
    }

    #[test]
    fn valid_nicknames_pass() {
        let list = vec![dev("a", Some("test")), dev("b", None), dev("c", Some("lab-1"))];
        assert!(validate_nicknames(&list).is_ok());
    }

    #[test]
    fn duplicate_nickname_rejected() {
        let list = vec![dev("a", Some("test")), dev("b", Some("test"))];
        let err = validate_nicknames(&list).unwrap_err();
        assert!(err.contains("重复"), "{}", err);
        assert!(err.contains("a"), "错误应指出已占用设备: {}", err);
    }

    #[test]
    fn separator_and_reserved_and_blank_rejected() {
        assert!(validate_nicknames(&[dev("a", Some("te::st"))]).is_err());
        assert!(validate_nicknames(&[dev("a", Some("local"))]).is_err());
        assert!(validate_nicknames(&[dev("a", Some("  "))]).is_err());
    }
}

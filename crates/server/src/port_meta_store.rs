//! 端口元数据持久化：exe 同目录 ports.json。
//!
//! 端口元数据（别名等）是**端口所在机器的本地配置**，由前端（Tauri 控制面 invoke
//! 或 WS action）读写。服务端不持有状态——list 时按需 load，由 lib.rs 的 PortView 组合。
//! 首次运行无文件 → 空。未来加 description/color 等只在 PortMeta 加字段，不新建文件。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 单个端口的用户元数据。按端口名 key 存于 ports.json。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PortMeta {
    /// 用户自定义别名（描述端口下连接的设备）。None = 未设置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    // 未来：description / color / notes 在此加字段。
}

fn path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("ports.json"))
}

/// 读 ports.json（不存在或解析失败 → 空）。
pub fn load() -> BTreeMap<String, PortMeta> {
    match path() {
        Some(p) if p.exists() => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        },
        _ => BTreeMap::new(),
    }
}

/// 写 ports.json。
pub fn save(map: &BTreeMap<String, PortMeta>) -> Result<(), String> {
    let p = path().ok_or("无法定位 exe 目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    Ok(())
}

/// 在内存 map 上设置端口别名（None 或空串 = 清除）。
/// 保证别名唯一：把同名字符串从其它端口摘掉，使 MCP 别名解析无歧义。
/// 纯函数，无 I/O——set_alias 的可测试内核。
pub fn apply_alias(map: &mut BTreeMap<String, PortMeta>, port: &str, alias: Option<String>) {
    let cleaned = alias.and_then(|s| {
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    });
    // 去重：从其它端口摘掉同名别名
    if let Some(ref a) = cleaned {
        for (p, m) in map.iter_mut() {
            if p != port && m.alias.as_deref() == Some(a.as_str()) {
                m.alias = None;
            }
        }
    }
    match map.get_mut(port) {
        Some(m) => m.alias = cleaned,
        None => {
            if cleaned.is_some() {
                map.insert(port.to_string(), PortMeta { alias: cleaned });
            }
            // 清除一个不存在的端口别名：无操作
        }
    }
}

/// 设置端口别名：load → apply_alias → save。
/// Tauri `set_port_alias` / WS `set_alias` 两入口共用此唯一写入路径。
pub fn set_alias(port: &str, alias: Option<String>) -> Result<(), String> {
    let mut map = load();
    apply_alias(&mut map, port, alias);
    save(&map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(alias: Option<&str>) -> PortMeta {
        PortMeta { alias: alias.map(str::to_string) }
    }

    #[test]
    fn apply_alias_sets_and_inserts() {
        let mut map = BTreeMap::new();
        apply_alias(&mut map, "COM7", Some("GPS".into()));
        assert_eq!(map.get("COM7").and_then(|m| m.alias.as_deref()), Some("GPS"));
        // 已存在的端口：覆盖
        apply_alias(&mut map, "COM7", Some("Alt".into()));
        assert_eq!(map.get("COM7").and_then(|m| m.alias.as_deref()), Some("Alt"));
    }

    #[test]
    fn apply_alias_dedup_strips_same_alias_from_other_ports() {
        let mut map = BTreeMap::new();
        map.insert("COM7".into(), meta(Some("GPS")));
        map.insert("COM3".into(), meta(Some("Sensor")));
        // 把 GPS 赋给 COM3 → COM7 的 GPS 应被摘掉
        apply_alias(&mut map, "COM3", Some("GPS".into()));
        assert_eq!(map.get("COM3").and_then(|m| m.alias.as_deref()), Some("GPS"));
        assert_ne!(
            map.get("COM7").and_then(|m| m.alias.as_deref()),
            Some("GPS"),
            "同名别名赋给新端口后，原端口的同名别名应被清除"
        );
    }

    #[test]
    fn apply_alias_empty_clears() {
        let mut map = BTreeMap::new();
        map.insert("COM7".into(), meta(Some("GPS")));
        apply_alias(&mut map, "COM7", None);
        assert_eq!(map.get("COM7").and_then(|m| m.alias.as_deref()), None);
        // 空串等同 None
        map.get_mut("COM7").unwrap().alias = Some("GPS".into());
        apply_alias(&mut map, "COM7", Some("   ".into()));
        assert_eq!(map.get("COM7").and_then(|m| m.alias.as_deref()), None);
    }

    #[test]
    fn apply_alias_clear_missing_port_is_noop() {
        let mut map = BTreeMap::new();
        map.insert("COM7".into(), meta(Some("GPS")));
        apply_alias(&mut map, "COM3", None); // COM3 不存在
        assert_eq!(map.len(), 1, "清除不存在的端口别名不应插入空条目");
    }
}

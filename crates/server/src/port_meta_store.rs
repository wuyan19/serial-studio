//! 端口元数据持久化：配置目录 ports.json（系统 app data 目录，见 config::config_dir）。
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
    Some(crate::config::config_dir()?.join("ports.json"))
}

/// 内存缓存(mtime 失效):list 是高频路径(每客户端 × 每 meta 变更都拉),每次
/// 读盘在 async 线程上是 IO 尖峰;写路径单入口(save 后主动更新缓存),外部改动
/// (手工编辑)最迟下次 mtime 变化后可见——零一致性风险。
static CACHE: std::sync::Mutex<Option<(std::time::SystemTime, BTreeMap<String, PortMeta>)>> =
    std::sync::Mutex::new(None);

/// 读 ports.json(带 mtime 缓存;不存在或解析失败 → 空)。
pub fn load() -> BTreeMap<String, PortMeta> {
    let p = match path() {
        Some(p) => p,
        None => return BTreeMap::new(),
    };
    let mtime = p
        .metadata()
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let mut cache = CACHE.lock().unwrap();
    if let Some((cached_mtime, map)) = cache.as_ref() {
        if *cached_mtime == mtime {
            return map.clone();
        }
    }
    let map = match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    };
    *cache = Some((mtime, map.clone()));
    map
}

/// 写 ports.json(同步更新缓存)。
pub fn save(map: &BTreeMap<String, PortMeta>) -> Result<(), String> {
    let p = path().ok_or("无法定位配置目录")?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入 {:?} 失败: {}", p, e))?;
    let mtime = p
        .metadata()
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    *CACHE.lock().unwrap() = Some((mtime, map.clone()));
    Ok(())
}

/// 在内存 map 上设置端口别名（None 或空串 = 清除）。
/// 保证别名唯一：把同名字符串从其它端口摘掉，使 MCP 别名解析无歧义。
/// 纯函数，无 I/O——set_alias 的可测试内核。
pub fn apply_alias(map: &mut BTreeMap<String, PortMeta>, port: &str, alias: Option<String>) {
    let cleaned = alias.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
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
        PortMeta {
            alias: alias.map(str::to_string),
        }
    }

    /// 空串 = 清除别名(打开对话框清空后确认的路径):apply_alias 把 Some("") 归一为
    /// None——前端 setAlias("") 经此清除,不留残留。
    #[test]
    fn apply_alias_empty_string_clears() {
        let mut map = std::collections::BTreeMap::new();
        map.insert("COM3".to_string(), meta(Some("GPS")));
        apply_alias(&mut map, "COM3", Some("".to_string()));
        assert_eq!(map.get("COM3").unwrap().alias, None, "空串应清除别名");
    }

    #[test]
    fn apply_alias_sets_and_inserts() {
        let mut map = BTreeMap::new();
        apply_alias(&mut map, "COM7", Some("GPS".into()));
        assert_eq!(
            map.get("COM7").and_then(|m| m.alias.as_deref()),
            Some("GPS")
        );
        // 已存在的端口：覆盖
        apply_alias(&mut map, "COM7", Some("Alt".into()));
        assert_eq!(
            map.get("COM7").and_then(|m| m.alias.as_deref()),
            Some("Alt")
        );
    }

    #[test]
    fn apply_alias_dedup_strips_same_alias_from_other_ports() {
        let mut map = BTreeMap::new();
        map.insert("COM7".into(), meta(Some("GPS")));
        map.insert("COM3".into(), meta(Some("Sensor")));
        // 把 GPS 赋给 COM3 → COM7 的 GPS 应被摘掉
        apply_alias(&mut map, "COM3", Some("GPS".into()));
        assert_eq!(
            map.get("COM3").and_then(|m| m.alias.as_deref()),
            Some("GPS")
        );
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

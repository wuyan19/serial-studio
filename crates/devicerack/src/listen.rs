//! 监听参数解析：显式 CLI 参数 > settings.json > 形态默认。
//!
//! 照抄 serial-studio 的权威模型（settings.json 的 ws_host/ws_port 是持久
//! 真相源，GUI 双击启动直接读它；CLI 参数是 headless/自动化场景的显式覆盖），
//! 修掉它 headless 侧「default_value 恒覆盖、settings 永不生效」的小缺陷——
//! 这里参数用 Option，显式传了才覆盖。
//!
//! devicerack 特有的一道工序：**定型**。共享 Settings 的默认值是 serial-studio
//! 的 0.0.0.0:18700（serde default），而 devicerack 默认 18800（错开常同机并行
//! 的 serial-studio）；create_state 的 instance_id 首启就会用底座默认创建
//! settings.json。两种情况须落盘 devicerack 默认定型：
//! ① settings.json 不存在（首启）；
//! ② 文件值恰为底座默认对 0.0.0.0:18700——devicerack 历史上监听只由 CLI 决定，
//!    settings.json 里这对值只能是底座默认残留（用户此前没有任何写入路径）。
//!    用户日后经设置页显式选 0.0.0.0:18700 会被再次定型——这是可接受的已知
//!    边角（该组合=「与 serial-studio 同机抢同端口」，本身即误配）。
//!
//! **调用时序**：须在 create_state() 之前（instance_id 会以底座默认建文件）。

use ss_server::settings::Settings;

/// 形态默认 host：headless 沿袭 0.0.0.0（服务器惯例），桌面壳传 127.0.0.1
/// （GUI 保守默认——服务无认证，不静默暴露局域网）。port 默认两形态同为 18800。
pub fn resolve_listen(
    host_arg: Option<String>,
    port_arg: Option<u16>,
    fallback_host: &str,
) -> (String, u16) {
    let file_exists = ss_server::config::config_dir()
        .map(|d| d.join("settings.json").exists())
        .unwrap_or(false);
    let s = ss_server::settings::load();
    let ((host, port), stamp) = resolve_inner(host_arg, port_arg, fallback_host, s, file_exists);
    if let Some(s) = stamp {
        if let Err(e) = ss_server::settings::save(&s) {
            tracing::warn!("监听参数定型落盘失败（将沿用内存值）: {e}");
        }
    }
    (host, port)
}

/// 纯决策核：返回 (解析结果, 需落盘定型的 Settings)。不碰文件系统，
/// 单测直打这里（含定型路径也不会写真配置目录）。
fn resolve_inner(
    host_arg: Option<String>,
    port_arg: Option<u16>,
    fallback_host: &str,
    mut s: Settings,
    file_exists: bool,
) -> ((String, u16), Option<Settings>) {
    let residue = s.ws_host == "0.0.0.0" && s.ws_port == 18700;
    let stamp = if !file_exists || residue {
        // 原地定型：s 本身就是「无 CLI 参数时的解析结果」
        s.ws_host = fallback_host.to_string();
        s.ws_port = 18800;
        Some(s.clone())
    } else {
        None
    };
    let host = host_arg.unwrap_or_else(|| s.ws_host.clone());
    let port = port_arg.unwrap_or(s.ws_port);
    ((host, port), stamp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Settings {
        Settings {
            ws_host: "0.0.0.0".into(),
            ws_port: 18700,
            ..Default::default()
        }
    }

    #[test]
    fn 首启定型_写入形态默认() {
        let ((h, p), stamp) = resolve_inner(None, None, "127.0.0.1", base(), false);
        assert_eq!((h.as_str(), p), ("127.0.0.1", 18800));
        let s = stamp.expect("首启应产出定型值");
        assert_eq!((s.ws_host.as_str(), s.ws_port), ("127.0.0.1", 18800));
    }

    #[test]
    fn 底座默认残留_迁移到_devicerack_默认() {
        let ((h, p), stamp) = resolve_inner(None, None, "0.0.0.0", base(), true);
        assert_eq!((h.as_str(), p), ("0.0.0.0", 18800));
        assert!(stamp.is_some(), "残留对应产出定型值");
    }

    #[test]
    fn 用户显式值_原样生效() {
        let mut s = base();
        s.ws_host = "192.168.1.10".into();
        s.ws_port = 19000;
        let ((h, p), stamp) = resolve_inner(None, None, "127.0.0.1", s, true);
        assert_eq!((h.as_str(), p), ("192.168.1.10", 19000));
        assert!(stamp.is_none(), "用户值不再定型");
    }

    #[test]
    fn cli_显式参数_优先于一切() {
        let mut s = base();
        s.ws_host = "192.168.1.10".into();
        s.ws_port = 19000;
        let ((h, p), stamp) =
            resolve_inner(Some("0.0.0.0".into()), Some(18801), "127.0.0.1", s, true);
        assert_eq!((h.as_str(), p), ("0.0.0.0", 18801));
        assert!(stamp.is_none());
    }

    #[test]
    fn cli_只传端口_地址取设置值() {
        let mut s = base();
        s.ws_host = "192.168.1.10".into();
        s.ws_port = 19000;
        let ((h, p), _) = resolve_inner(None, Some(18801), "127.0.0.1", s, true);
        assert_eq!((h.as_str(), p), ("192.168.1.10", 18801));
    }
}

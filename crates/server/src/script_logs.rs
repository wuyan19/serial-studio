//! 脚本日志落盘:是否落盘(settings 开关)与落到哪(时间戳文件名)的策略唯一归属。
//!
//! core 只收 `Option<PathBuf>`(引擎层不感知配置目录/设置);ws/mcp/tauri 三个执行
//! 入口统一经 [`log_file_for`] 取路径,开关语义单一真相。文件不自动清理(用户自管,
//! 见 settings::script_log_to_disk 注释);目录经 UI「打开目录」或 [`dir`] 定位。

use crate::settings;
use std::path::PathBuf;

/// 脚本日志目录(配置目录下 script-logs/)。config_dir 已确保配置目录存在;
/// 本目录延迟到首次写入/用户打开时才创建,避免未开启开关也留空目录。
pub fn dir() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join("script-logs"))
}

/// 本次运行的日志文件路径:`<yyyyMMdd-HHmmss.毫秒>-<port>[-<脚本名>].log`。
/// 毫秒防同秒撞名(真撞了也无害:core 侧 append 模式接续写);port key 形如
/// `uuid::COM5`、脚本名用户自取,均经 [`sanitize`] 才能进文件名。
pub fn run_log_path(port: &str, script_name: Option<&str>) -> Option<PathBuf> {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let mut name = format!("{ts}-{}", sanitize(port));
    if let Some(n) = script_name {
        let n = sanitize(&n.chars().take(40).collect::<String>());
        if !n.is_empty() {
            name.push('-');
            name.push_str(&n);
        }
    }
    name.push_str(".log");
    dir().map(|d| d.join(name))
}

/// 开关开 → 生成本次运行的日志路径;关 → None。三个执行入口共用的唯一策略点,
/// 每次运行时读 settings(改动立即生效,无需重启,与 ws_host/port 语义不同)。
pub fn log_file_for(port: &str, script_name: Option<&str>) -> Option<PathBuf> {
    if settings::load().script_log_to_disk {
        run_log_path(port, script_name)
    } else {
        None
    }
}

/// 文件名净化:保留字母/数字(`is_alphanumeric` 含中文——日志名可读性优先)/`-`/`_`,
/// 其余(路径分隔符、`:`、空白等)一律替换为 `_`,杜绝路径穿越与非法文件名。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 净化:字母/数字(`is_alphanumeric` 含中文)与 `-`/`_` 保留,其余(`.`、路径分隔符、
    /// `:`、空白等)一律变下划线;中文保留可读性。
    #[test]
    fn sanitize_keeps_readable_replaces_dangerous() {
        assert_eq!(sanitize("AT 自检"), "AT_自检");
        assert_eq!(sanitize("uuid::COM5"), "uuid__COM5");
        assert_eq!(sanitize(r"..\..\evil"), "______evil");
        assert_eq!(sanitize("ok-name_1"), "ok-name_1");
    }

    /// 命名:时间戳-端口开头,带脚本名时追加净化后的名字;超长脚本名截断(40 字符)。
    #[test]
    fn run_log_path_layout() {
        let p = run_log_path("test::COM5", Some("AT 自检")).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        // 时间戳段:yyyyMMdd-HHmmss.毫秒 共 19 字符(8 数字 - 6 数字 . 3 数字)
        let idx = name.find("test__COM5").expect("应含净化后的端口段");
        let ts = &name[..idx - 1]; // 去掉与端口之间的连接符
        assert_eq!(ts.len(), 19, "时间戳应为 yyyyMMdd-HHmmss.毫秒: {ts}");
        assert!(
            ts.chars().enumerate().all(|(i, c)| match i {
                8 => c == '-',
                15 => c == '.',
                _ => c.is_ascii_digit(),
            }),
            "时间戳布局应为 日期-时间.毫秒: {ts}"
        );
        assert!(
            name.ends_with("test__COM5-AT_自检.log"),
            "应为 时间戳-port-name.log: {name}"
        );

        // 无脚本名:端口段即结尾
        let p2 = run_log_path("COM5", None).unwrap();
        assert!(p2
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("COM5.log"));

        // 超长脚本名截 40 字符,文件名总长有界
        let long = "x".repeat(100);
        let name3 = run_log_path("COM5", Some(&long))
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            name3.contains(&"x".repeat(40)) && !name3.contains(&"x".repeat(41)),
            "脚本名应截 40: {name3}"
        );
    }

    /// 开关关 → None(默认);开关开 → Some。与 mcp.rs 脚本库测试共用同一
    /// SERIAL_STUDIO_CONFIG_DIR 目录(全程 set 同一路径,幂等,不在测试间来回切换环境变量;
    /// settings.json 与 scripts.json 文件名不同,互不踩)。生产环境不设此变量。
    /// ⚠ 勿让共用此目录的测试走 create_state():它会经 instance_id() 在 settings.json
    /// 缺 instance_id 时回写整个文件,与本测试的写/断言并发互踩。现有测试均用手搓
    /// make_state(不经 instance_id),保持这一约定。
    #[test]
    fn log_file_for_follows_toggle() {
        let dir = std::env::temp_dir().join("ss-mcp-test-scripts");
        std::env::set_var(crate::config::CONFIG_DIR_ENV, &dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 关(默认/文件缺失)
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        assert!(log_file_for("COM5", None).is_none(), "开关关应返 None");
        // 开
        std::fs::write(dir.join("settings.json"), r#"{"script_log_to_disk":true}"#).unwrap();
        assert!(log_file_for("COM5", None).is_some(), "开关开应返路径");
    }
}

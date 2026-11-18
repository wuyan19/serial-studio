//! 审计日志：配置目录 audit.jsonl 追加写——谁在什么时候申请/释放/动了哪个设备。
//!
//! 多 AI 同场调试出问题时，事件流是第一取证材料。V1 不滚动、不索引（量级小），
//! 行式 JSON 直接 jq/文本检索。

use serde_json::json;
use std::io::Write;
use std::sync::Mutex;

/// 进程内串行化追加写（append 原子性按行级足够）。
static LOCK: Mutex<()> = Mutex::new(());

/// 事件词典。新增事件只加不改旧名（消费方按名过滤）。
pub const EV_ACQUIRE: &str = "acquire";
pub const EV_DENY: &str = "deny";
pub const EV_RENEW: &str = "renew";
pub const EV_RELEASE: &str = "release";
pub const EV_EXPIRE: &str = "expire";
pub const EV_PREEMPT: &str = "preempt";
pub const EV_WRITE_DENIED: &str = "write_denied";

/// 追加一条审计记录。落盘失败仅 warn（审计不阻断业务路径）。
pub fn log(
    event: &str,
    token: Option<&str>,
    label: &str,
    lease_id: Option<&str>,
    keys: &[String],
    detail: &str,
) {
    let Some(dir) = ss_server::config::config_dir() else {
        return;
    };
    let line = json!({
        "ts": chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
        "event": event,
        "token": token,
        "label": label,
        "lease_id": lease_id,
        "keys": keys,
        "detail": detail,
    });
    let _g = LOCK.lock().expect("audit lock poisoned");
    let path = dir.join("audit.jsonl");
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"))
    {
        Ok(()) => {}
        Err(e) => tracing::warn!("审计写入失败({path:?}): {e}"),
    }
}

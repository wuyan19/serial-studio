//! 宏执行引擎：send / delay / expect / clear 四种步骤。
//!
//! 移植自 terminal-serial 的 macro_runner，适配异步 SerialManager：
//! - send → manager.write（text 自动追加 \r\n，hex 原始字节）
//! - delay → tokio::time::sleep
//! - expect → manager.grep_buffer（等设备返回匹配，超时报错）
//! - clear → manager.clear_buffer
//!
//! 中断:`abort: AtomicBool` 三档保证停止信号秒级生效(镜像 script.rs 的 abort 模式)——
//! 步骤间循环顶检查 + Delay 分段轮询(≤50ms)+ Expect `select!` 对 await_abort。
//!
//! expect 依赖 RxBuffer 的非破坏性 grep，与 MCP 的 serial_grep 共享同一机制。

use crate::error::SerialError;
use crate::manager::SerialManager;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 一个宏定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Macro {
    #[serde(default)]
    pub description: Option<String>,
    /// 分组名(侧栏按组折叠);空 = 未分组。
    #[serde(default)]
    pub group: Option<String>,
    pub steps: Vec<MacroStep>,
}

/// 宏步骤（内部标签枚举，JSON 的 `{"type":"send",...}`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MacroStep {
    Send {
        data: String,
        #[serde(default = "default_format")]
        format: String,
        #[serde(default = "default_auto_newline")]
        auto_newline: bool,
    },
    Delay {
        ms: u64,
    },
    Expect {
        pattern: String,
        #[serde(default = "default_expect_timeout")]
        timeout_ms: u64,
    },
    Clear,
}

fn default_format() -> String {
    "text".into()
}
fn default_auto_newline() -> bool {
    true
}
fn default_expect_timeout() -> u64 {
    3000
}

#[derive(Debug, thiserror::Error)]
pub enum MacroError {
    #[error("串口错误: {0}")]
    Serial(#[from] SerialError),

    #[error("expect 超时：{timeout_ms}ms 内未匹配到 {pattern:?}")]
    ExpectTimeout { pattern: String, timeout_ms: u64 },

    /// 外部请求停止(停止按钮 / abort flag)。
    #[error("已停止")]
    Aborted,
}

impl MacroError {
    /// 面向用户的消息(对齐 ScriptError::display_message):Aborted→"已停止",其余用 Display。
    /// ws/main 的结果回显用此而非 Display(语义一致,后续若需脱敏也只改这里)。
    pub fn display_message(&self) -> String {
        match self {
            MacroError::Aborted => "已停止".into(),
            other => other.to_string(),
        }
    }
}

/// 在指定端口上顺序执行宏的所有步骤。`abort` 置位后秒级中断(步骤间检查 + Delay 分段 + Expect select!)。
pub async fn run_macro(
    port: &str,
    mac: &Macro,
    manager: &SerialManager,
    abort: Arc<AtomicBool>,
) -> Result<(), MacroError> {
    for step in &mac.steps {
        // 步骤间检查 abort:覆盖 Send/Clear 之间的空隙(Delay/Expect 内部另有分段/select 兜底)。
        if abort.load(Ordering::Relaxed) {
            return Err(MacroError::Aborted);
        }
        match step {
            MacroStep::Send {
                data,
                format,
                auto_newline,
            } => {
                manager.send(port, data, format, *auto_newline).await?;
            }
            MacroStep::Delay { ms } => {
                // 分段(≤50ms)轮询 abort,否则单个长 Delay 会让中断延迟到 delay 结束。
                let mut remaining = Duration::from_millis(*ms);
                let chunk = Duration::from_millis(50);
                loop {
                    if abort.load(Ordering::Relaxed) {
                        return Err(MacroError::Aborted);
                    }
                    if remaining == Duration::ZERO {
                        break;
                    }
                    let wait = remaining.min(chunk);
                    tokio::time::sleep(wait).await;
                    remaining = remaining.saturating_sub(wait);
                }
            }
            MacroStep::Expect {
                pattern,
                timeout_ms,
            } => {
                // select! 让 abort 能打断长 expect(否则要等满 timeout_ms)。
                let lines = tokio::select! {
                    r = manager.grep_buffer(port, pattern, *timeout_ms) => r?,
                    _ = await_abort(abort.clone()) => return Err(MacroError::Aborted),
                };
                if lines.is_empty() {
                    return Err(MacroError::ExpectTimeout {
                        pattern: pattern.clone(),
                        timeout_ms: *timeout_ms,
                    });
                }
            }
            MacroStep::Clear => {
                manager.clear_buffer(port).await?;
            }
        }
    }
    Ok(())
}

/// 轮询 abort flag(≤50ms 响应)——供 Expect 的 select! 用:grep_buffer 是一次性长 await,
/// 此 future 让 expect 也能被停止信号打断(完成时触发 select! 走 abort 分支)。镜像 script.rs::await_abort。
async fn await_abort(abort: Arc<AtomicBool>) {
    while !abort.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 编码发送数据：text（按 line_ending 可选追加换行）/ hex（原始字节）。
/// 宏与 MCP 共用此函数——换行逻辑只此一处。
pub fn encode_send(
    data: &str,
    format: &str,
    auto_newline: bool,
    line_ending: crate::types::LineEnding,
) -> Result<Vec<u8>, String> {
    let mut bytes = match format {
        "hex" => {
            let cleaned: String = data.replace(" ", "").replace("0x", "").replace(",", "");
            if !cleaned.len().is_multiple_of(2) {
                return Err("odd length".into());
            }
            (0..cleaned.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?
        }
        _ => data.as_bytes().to_vec(),
    };
    if format != "hex" && auto_newline {
        match line_ending {
            crate::types::LineEnding::LF => bytes.push(b'\n'),
            crate::types::LineEnding::CR => bytes.push(b'\r'),
            crate::types::LineEnding::CRLF => {
                bytes.push(b'\r');
                bytes.push(b'\n');
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::EventBus;
    use crate::manager::SerialManager;
    use crate::opener::RealPortOpener;
    use crate::types::LineEnding;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    /// 不 open 真实端口:Delay 中断测试只依赖分段轮询,不碰串口。
    fn mgr() -> Arc<SerialManager> {
        Arc::new(SerialManager::new(
            Arc::new(EventBus::new(16)),
            Arc::new(RealPortOpener),
        ))
    }
    fn abort_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn serde_macro_roundtrip() {
        let json = r#"{"description":"测试","steps":[{"type":"send","data":"AT"},{"type":"expect","pattern":"OK","timeout_ms":2000},{"type":"clear"}]}"#;
        let m: Macro = serde_json::from_str(json).unwrap();
        assert_eq!(m.steps.len(), 3);
        assert!(matches!(m.steps[0], MacroStep::Send { .. }));
        assert!(matches!(m.steps[2], MacroStep::Clear));
    }

    #[test]
    fn encode_text_crlf() {
        let b = encode_send("AT", "text", true, LineEnding::CRLF).unwrap();
        assert_eq!(b, b"AT\r\n");
    }

    #[test]
    fn encode_text_lf() {
        let b = encode_send("AT", "text", true, LineEnding::LF).unwrap();
        assert_eq!(b, b"AT\n");
    }

    #[test]
    fn encode_text_cr() {
        let b = encode_send("AT", "text", true, LineEnding::CR).unwrap();
        assert_eq!(b, b"AT\r");
    }

    #[test]
    fn encode_text_no_newline() {
        let b = encode_send("AT", "text", false, LineEnding::CRLF).unwrap();
        assert_eq!(b, b"AT");
    }

    #[test]
    fn encode_hex_raw() {
        let b = encode_send("0D0A", "hex", true, LineEnding::CRLF).unwrap();
        assert_eq!(b, b"\r\n"); // hex 不追加换行
    }

    #[test]
    fn encode_hex_odd_fails() {
        assert!(encode_send("ABC", "hex", false, LineEnding::CRLF).is_err());
    }

    #[test]
    fn default_values_applied() {
        let json = r#"{"steps":[{"type":"send","data":"X"}]}"#;
        let m: Macro = serde_json::from_str(json).unwrap();
        if let MacroStep::Send {
            format,
            auto_newline,
            ..
        } = &m.steps[0]
        {
            assert_eq!(format, "text");
            assert!(*auto_newline);
        }
    }

    /// Delay 中途 abort:长 Delay 被 50ms 分段打断,100ms 触发后秒级返回 Aborted(不等满 5s)。
    #[tokio::test]
    async fn macro_aborts_on_delay() {
        let mac = Macro {
            description: None,
            group: None,
            steps: vec![MacroStep::Delay { ms: 5000 }],
        };
        let abort = abort_flag();
        let abort_clone = abort.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            abort_clone.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        let result = run_macro("COM0", &mac, &mgr(), abort).await;
        stopper.await.unwrap();
        assert!(
            matches!(result, Err(MacroError::Aborted)),
            "应被中断: {:?}",
            result
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "应秒级返回: {:?}",
            start.elapsed()
        );
    }
}

//! 宏执行引擎：send / delay / expect / clear 四种步骤。
//!
//! 移植自 terminal-serial 的 macro_runner，适配异步 SerialManager：
//! - send → manager.write（text 自动追加 \r\n，hex 原始字节）
//! - delay → tokio::time::sleep
//! - expect → manager.grep_buffer（等设备返回匹配，超时报错）
//! - clear → manager.clear_buffer
//!
//! expect 依赖 RxBuffer 的非破坏性 grep，与 MCP 的 serial_grep 共享同一机制。

use crate::error::SerialError;
use crate::manager::SerialManager;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 一个宏定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Macro {
    #[serde(default)]
    pub description: Option<String>,
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
    Delay { ms: u64 },
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
}

/// 在指定端口上顺序执行宏的所有步骤。
pub async fn run_macro(port: &str, mac: &Macro, manager: &SerialManager) -> Result<(), MacroError> {
    for step in &mac.steps {
        match step {
            MacroStep::Send {
                data,
                format,
                auto_newline,
            } => {
                manager.send(port, data, format, *auto_newline).await?;
            }
            MacroStep::Delay { ms } => {
                tokio::time::sleep(Duration::from_millis(*ms)).await;
            }
            MacroStep::Expect {
                pattern,
                timeout_ms,
            } => {
                let lines = manager.grep_buffer(port, pattern, *timeout_ms).await?;
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
            if cleaned.len() % 2 != 0 {
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
    use crate::types::LineEnding;

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
        if let MacroStep::Send { format, auto_newline, .. } = &m.steps[0] {
            assert_eq!(format, "text");
            assert!(*auto_newline);
        }
    }
}

//! 串口配置与端口信息类型。
//!
//! 这些类型可从 JSON 反序列化，供 WS / REST / MCP 各接入层共用。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// 串口配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: DataBits,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: StopBits,
    #[serde(default = "default_parity")]
    pub parity: Parity,
    #[serde(default = "default_flow_control")]
    pub flow_control: FlowControl,
    /// 行结束符：text 模式 auto_newline 追加的换行。连 Linux shell 选 LF，
    /// Windows/AT 设备选 CRLF。仅作用于程序发送（宏/MCP），交互输入透传不受影响。
    #[serde(default = "default_line_ending")]
    pub line_ending: LineEnding,
    /// 读取超时（毫秒）。影响命令响应延迟——越小越快但 CPU 占用越高。
    /// 默认 100ms：port_task 的读循环靠它定期返回，让 select 能处理命令。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_data_bits() -> DataBits {
    DataBits::Eight
}
fn default_stop_bits() -> StopBits {
    StopBits::One
}

fn default_parity() -> Parity {
    Parity::None
}

fn default_flow_control() -> FlowControl {
    FlowControl::None
}
fn default_line_ending() -> LineEnding {
    LineEnding::LF
}
fn default_timeout_ms() -> u64 {
    100
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            baud_rate: 115200,
            data_bits: DataBits::Eight,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            line_ending: LineEnding::LF,
            timeout_ms: 100,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

/// 行结束符。LF（Unix）/ CR / CRLF（Windows、多数串口设备）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    LF,
    CR,
    CRLF,
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// 会话标识：一条 WS 连接或一个 Tauri 窗口的唯一身份，进程内全局单调递增。
/// 仅需进程内唯一，故用自增计数器而非 uuid。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct SessionId(u64);

impl SessionId {
    /// 分配一个新的会话标识。
    pub fn next() -> Self {
        Self(NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed))
    }
}

/// acquire 的结果：区分"真正打开"与"附加到已开端口"。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcquireResult {
    /// 本次真正打开了端口（首个持有者）。
    Opened { config: SerialConfig },
    /// 端口已开，本次为附加（持有者 +1）。config 为端口当前实际配置
    /// （请求的配置被忽略），调用方应据此告知用户。
    Attached { config: SerialConfig, holders: usize },
}

/// release 的结果：本会话退出持有的实际效果。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReleaseOutcome {
    /// 本会话是末位持有者，端口已拆毁。
    Closed,
    /// 仍有其它持有者，端口保持打开。
    Released { remaining: usize },
    /// 本会话未持有此端口（幂等，非错误）。
    NotHeld,
}

/// 端口信息（含是否已由本管理器打开及当前持有者数）。
#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub name: String,
    pub opened: bool,
    /// 当前持有该端口的会话数（多端共享时 >1）。
    pub holders: usize,
    /// 用户自定义别名（描述端口下连接的设备）。
    /// core 不知情，构造时填 None；由 server 层从 ports.json 注入（远程模式取远程别名）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_default_values() {
        let c = SerialConfig::default();
        assert_eq!(c.baud_rate, 115200);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.line_ending, LineEnding::LF);
        assert_eq!(c.timeout_ms, 100);
    }

    #[test]
    fn config_serde_uses_defaults() {
        // 只给 baud_rate，其余走 serde default
        let c: SerialConfig = serde_json::from_str(r#"{"baud_rate":9600}"#).unwrap();
        assert_eq!(c.baud_rate, 9600);
        assert_eq!(c.parity, Parity::None);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.line_ending, LineEnding::LF);
    }

    #[test]
    fn config_full_roundtrip() {
        let json = r#"{"baud_rate":4800,"data_bits":"seven","stop_bits":"two","parity":"even","flow_control":"hardware","timeout_ms":50}"#;
        let c: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.data_bits, DataBits::Seven);
        assert_eq!(c.stop_bits, StopBits::Two);
        assert_eq!(c.parity, Parity::Even);
        assert_eq!(c.flow_control, FlowControl::Hardware);
    }
}

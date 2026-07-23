//! 串口配置与端口信息类型。
//!
//! 这些类型可从 JSON 反序列化，供 WS / REST / MCP 各接入层共用。

use serde::{Deserialize, Serialize};

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

/// 端口信息（含是否已由本管理器打开）。
#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub name: String,
    pub opened: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_default_values() {
        let c = SerialConfig::default();
        assert_eq!(c.baud_rate, 115200);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.timeout_ms, 100);
    }

    #[test]
    fn config_serde_uses_defaults() {
        // 只给 baud_rate，其余走 serde default
        let c: SerialConfig = serde_json::from_str(r#"{"baud_rate":9600}"#).unwrap();
        assert_eq!(c.baud_rate, 9600);
        assert_eq!(c.parity, Parity::None);
        assert_eq!(c.data_bits, DataBits::Eight);
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

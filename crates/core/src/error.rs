//! 错误类型（thiserror）。

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, Serialize, Deserialize)]
pub enum SerialError {
    /// `detail` = 机器可读失败明细（JSON 文本，按传输介质自定义；core 与日志层只当
    /// 不透明字符串）。消费方：server 层回执解析后随错误带给客户端做结构化交互
    /// （如 SSH 认证失败重输闭环、host key 确认）。serde default 保线向后兼容。
    #[error("串口 {port} 打开失败: {message}")]
    OpenFailed {
        port: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },

    #[error("串口 {0} 不存在")]
    NotFound(String),

    #[error("串口 {0} 已被占用")]
    Busy(String),

    #[error("串口 {0} 未打开")]
    NotOpen(String),

    #[error("串口写入失败: {0}")]
    WriteFailed(String),

    #[error("无效配置: {0}")]
    InvalidConfig(String),

    #[error("串口 {0} 设备已断开(占有权保留,可重连)")]
    Disconnected(String),
}

//! 错误类型（thiserror）。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SerialError {
    #[error("串口 {port} 打开失败: {message}")]
    OpenFailed { port: String, message: String },

    #[error("串口 {0} 不存在")]
    NotFound(String),

    #[error("串口 {0} 已被占用")]
    Busy(String),

    #[error("串口 {0} 未打开")]
    NotOpen(String),

    #[error("串口 {0} 已打开")]
    AlreadyOpen(String),

    #[error("串口写入失败: {0}")]
    WriteFailed(String),

    #[error("无效配置: {0}")]
    InvalidConfig(String),
}

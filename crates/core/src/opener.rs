//! 串口打开器抽象：core 与 serialport 后端的接触点（依赖倒置）。
//!
//! SerialManager 通过此 trait 打开串口：生产用 [`RealPortOpener`]（封装 [`crate::serial::open`]），
//! 测试注入桩实现，使 acquire/release 的占有权逻辑无需真实硬件即可单测。

use crate::error::SerialError;
use crate::types::SerialConfig;

/// 串口打开器：把"如何打开一个串口"抽象出来，供 SerialManager 依赖倒置。
pub trait PortOpener: Send + Sync {
    /// 打开串口（同步阻塞，调用方应在 spawn_blocking 中调用）。
    fn open(&self, port: &str, config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, SerialError>;
}

/// 生产实现：委托 [`crate::serial::open`]。
pub struct RealPortOpener;

impl PortOpener for RealPortOpener {
    fn open(&self, port: &str, config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, SerialError> {
        crate::serial::open(port, config)
    }
}

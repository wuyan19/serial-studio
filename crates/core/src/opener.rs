//! 端口打开器抽象：core 与 IO 后端的接触点（依赖倒置）。
//!
//! SerialManager 通过此 trait 打开端口：生产用 [`RealPortOpener`]（封装 [`crate::serial::open`]），
//! 测试注入桩实现，使 acquire/release 的占有权逻辑无需真实硬件即可单测。
//! server 层的组合 opener 也实现此 trait，按端口复合键路由本地串口 / 远端设备。

use crate::error::SerialError;
use crate::port_io::PortIo;
use crate::types::{split_port_key, SerialConfig, LOCAL_DEVICE_ID};

/// 端口打开器：把"如何打开一个端口"抽象出来，供 SerialManager 依赖倒置。
pub trait PortOpener: Send + Sync {
    /// 打开端口（同步阻塞，调用方应在 spawn_blocking 中调用）。
    /// port 为复合键;实现负责按首段路由(本机串口 / 远端设备)。
    fn open(&self, port: &str, config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError>;
}

/// 生产实现：本机串口 opener。裸名(本机端口键)直接打开本机串口;
/// 指向远端设备的复合键报错——远端通道由 server 层的组合 opener
/// (CompositeOpener)提供,core 不识网络。
pub struct RealPortOpener;

impl PortOpener for RealPortOpener {
    fn open(&self, port: &str, config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
        match split_port_key(port) {
            (LOCAL_DEVICE_ID, name) => crate::serial::open(name, config),
            (dev, _) => Err(SerialError::OpenFailed {
                port: port.to_string(),
                message: format!(
                    "远程设备 {} 的端口需要 server 层设备后端(本 opener 仅支持本机)",
                    dev
                ),
            }),
        }
    }
}

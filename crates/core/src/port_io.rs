//! 端口字节流抽象:core 与具体 IO 后端的接触点。
//!
//! PortIo 刻意是窄 trait——只表达"一个全双工字节通道 + 可克隆的读写分离句柄"。
//! manager/port_task 只依赖它,不感知传输介质:本地串口(serialport,本文件的
//! [`SerialPortIo`])与未来的 TCP raw / RFC 2217 / 远端设备转发(server 层的
//! RemotePortIo)实现同一接口,占有权/断开重连/宏/脚本等全部上层逻辑零改动。
//!
//! 语义约定(与 serialport 的阻塞行为对齐,port_task 的读循环依赖):
//! - read:无数据时返回 `io::ErrorKind::TimedOut`(读循环据此继续轮询);
//!   非 TimedOut 错误 = 通道断开(触发 drainer 的断开流程,保留占有权等 reopen)。
//! - write:write_all 语义,失败视为断开信号。
//! - try_clone:产生共享同一底层流的第二句柄(port_task 读/写分离全双工依赖)。

use std::io;

/// 端口 IO:全双工字节通道。
pub trait PortIo: io::Read + io::Write + Send {
    /// 克隆一个共享同一底层流的句柄。
    fn try_clone(&self) -> io::Result<Box<dyn PortIo>>;
}

/// 本地串口实现:包装 serialport 的同步串口。
///
/// serialport 库的接触点收敛在 [`crate::serial`];本类型只是把它适配成 [`PortIo`]。
pub struct SerialPortIo(Box<dyn serialport::SerialPort>);

impl SerialPortIo {
    /// 包装一个 serialport 句柄(由 [`crate::serial::open`] 构造)。
    pub fn new(port: Box<dyn serialport::SerialPort>) -> Self {
        Self(port)
    }
}

impl io::Read for SerialPortIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl io::Write for SerialPortIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl PortIo for SerialPortIo {
    fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
        self.0
            .try_clone()
            .map(|p| Box::new(SerialPortIo(p)) as Box<dyn PortIo>)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))
    }
}

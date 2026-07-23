//! 串口端口任务：每个串口一个独立异步任务。
//!
//! 核心深模块：读写、错误恢复、优雅关闭全藏在 `tokio::select!` 后面，
//! 对外接口只有 command_tx（Write/Close）。读到数据时既 publish 到 EventBus（前端），
//! 又 push 到 RxBuffer（MCP/宏 drain/grep）——同一份数据，两类消费者各取所需。

use crate::error::SerialError;
use crate::event_bus::{EventBus, SerialEvent};
use crate::rx_buffer::RxBuffer;
use crate::types::SerialConfig;
use bytes::Bytes;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{AbortHandle, JoinHandle};

/// 发给端口任务的命令。
pub enum PortCommand {
    Write(Bytes, oneshot::Sender<Result<usize, SerialError>>),
    Close(oneshot::Sender<()>),
}

/// 端口任务句柄（由 SerialManager 持有）。
pub struct PortHandle {
    pub join_handle: JoinHandle<()>,
    pub abort_handle: AbortHandle,
    pub command_tx: mpsc::Sender<PortCommand>,
    /// 接收缓冲区（MCP/宏 drain/grep 用）
    pub rx_buffer: Arc<RxBuffer>,
    /// 打开时的串口配置（status 用）
    pub config: SerialConfig,
}

pub async fn run(
    port_name: String,
    port: Box<dyn serialport::SerialPort>,
    mut command_rx: mpsc::Receiver<PortCommand>,
    event_bus: Arc<EventBus>,
    rx_buffer: Arc<RxBuffer>,
) {
    event_bus.publish(SerialEvent::PortOpened {
        port: port_name.clone(),
    });
    tracing::info!("端口任务启动: {}", port_name);

    let port = Arc::new(std::sync::Mutex::new(port));

    loop {
        tokio::select! {
            result = tokio::task::spawn_blocking({
                let port = Arc::clone(&port);
                move || {
                    let mut guard = port.lock().unwrap();
                    let mut buf = [0u8; 1024];
                    guard.read(&mut buf).map(|n| (n, buf[..n].to_vec()))
                }
            }) => {
                match result {
                    Ok(Ok((n, data))) if n > 0 => {
                        rx_buffer.push(&data);
                        event_bus.publish(SerialEvent::DataReceived {
                            port: port_name.clone(),
                            data,
                        });
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(ref e)) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Ok(Err(e)) => {
                        event_bus.publish(SerialEvent::Error {
                            port: port_name.clone(),
                            message: format!("读取错误: {}", e),
                        });
                        break;
                    }
                    Err(e) => {
                        tracing::error!("端口 {} 读任务 join 失败: {}", port_name, e);
                        break;
                    }
                }
            }
            cmd = command_rx.recv() => {
                match cmd {
                    Some(PortCommand::Write(data, response_tx)) => {
                        let port = Arc::clone(&port);
                        let result = tokio::task::spawn_blocking(move || {
                            let mut guard = port.lock().unwrap();
                            guard.write_all(&data).map(|_| data.len())
                        }).await;
                        let response = match result {
                            Ok(Ok(n)) => Ok(n),
                            Ok(Err(e)) => Err(SerialError::WriteFailed(e.to_string())),
                            Err(_) => Err(SerialError::WriteFailed("写任务取消".into())),
                        };
                        let _ = response_tx.send(response);
                    }
                    Some(PortCommand::Close(response_tx)) => {
                        tracing::info!("关闭端口: {}", port_name);
                        let _ = response_tx.send(());
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    event_bus.publish(SerialEvent::PortClosed {
        port: port_name.clone(),
    });
    tracing::info!("端口任务结束: {}", port_name);
}

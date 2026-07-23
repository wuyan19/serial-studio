//! 串口端口任务：每个串口一个独立异步任务。
//!
//! 核心深模块：读写、错误恢复、优雅关闭全藏在内部，对外接口只有 command_tx。
//! 读到数据时既 publish 到 EventBus（前端），又 push 到 RxBuffer（MCP/宏）。
//!
//! 读/写分离 handle（try_clone）：串口全双工，read/write 各用独立 Mutex 不互斥。
//! 读用持续 blocking 线程（spawn_blocking 内 loop read），避免每次 read 的调度开销
//! 和间隙——对比 terminal-serial 的单线程持续读，延迟更低。

use crate::error::SerialError;
use crate::event_bus::{EventBus, SerialEvent};
use crate::rx_buffer::RxBuffer;
use crate::types::SerialConfig;
use bytes::Bytes;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
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
    pub rx_buffer: Arc<RxBuffer>,
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

    // 读/写分离：try_clone 复制一份给 write，两个独立 Mutex 不互斥。
    let write_port_raw = port.try_clone();
    let read_port = Arc::new(std::sync::Mutex::new(port));
    let write_port = match write_port_raw {
        Ok(c) => {
            tracing::debug!("端口 {} 读写 handle 分离成功", port_name);
            Arc::new(std::sync::Mutex::new(c))
        }
        Err(e) => {
            tracing::warn!(
                "端口 {} try_clone 失败，读写共享 handle（输入可能有延迟）: {}",
                port_name,
                e
            );
            Arc::clone(&read_port)
        }
    };

    // 读：持续 blocking 线程（spawn_blocking 内 loop read），无每次 spawn 的调度间隙。
    // 直接 push + publish（都是同步调用，blocking 线程可直接做）。
    // quit flag 控制 close 时退出。
    let quit = Arc::new(AtomicBool::new(false));
    let quit_read = Arc::clone(&quit);
    let port_for_read = Arc::clone(&read_port);
    let event_bus_read = Arc::clone(&event_bus);
    let rx_buffer_read = Arc::clone(&rx_buffer);
    let name_for_read = port_name.clone();
    let read_handle = tokio::task::spawn_blocking(move || {
        loop {
            if quit_read.load(Ordering::Relaxed) {
                return;
            }
            let mut buf = [0u8; 1024];
            let n = {
                let mut guard = match port_for_read.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match guard.read(&mut buf) {
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        continue;
                    }
                    Err(e) => {
                        event_bus_read.publish(SerialEvent::Error {
                            port: name_for_read.clone(),
                            message: format!("读取错误: {}", e),
                        });
                        return;
                    }
                }
            };
            if n > 0 {
                let data = buf[..n].to_vec();
                rx_buffer_read.push(&data);
                event_bus_read.publish(SerialEvent::DataReceived {
                    port: name_for_read.clone(),
                    data,
                });
            }
        }
    });

    // command 循环（主 task）：串口写入串行化，天然单写者
    while let Some(cmd) = command_rx.recv().await {
        match cmd {
            PortCommand::Write(data, response_tx) => {
                let port = Arc::clone(&write_port);
                let result = tokio::task::spawn_blocking(move || {
                    let mut guard = port.lock().unwrap();
                    guard.write_all(&data).map(|_| data.len())
                })
                .await;
                let response = match result {
                    Ok(Ok(n)) => Ok(n),
                    Ok(Err(e)) => Err(SerialError::WriteFailed(e.to_string())),
                    Err(_) => Err(SerialError::WriteFailed("写任务取消".into())),
                };
                let _ = response_tx.send(response);
            }
            PortCommand::Close(response_tx) => {
                tracing::info!("关闭端口: {}", port_name);
                let _ = response_tx.send(());
                break;
            }
        }
    }

    // 通知读线程退出并等待（read timeout 100ms 后它会检查 quit 返回）
    quit.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_millis(500), read_handle).await;

    event_bus.publish(SerialEvent::PortClosed {
        port: port_name.clone(),
    });
    tracing::info!("端口任务结束: {}", port_name);
}

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
use crate::types::{SerialConfig, SessionId};
use bytes::Bytes;
use std::collections::HashSet;
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

/// 读线程检测到设备断开(read 非 timeout 错误)时,发给 manager drainer 的通知。
/// `instance` 标识端口实例——drainer 仅当 map 中该端口的 instance 与此相等时才判定为
/// "当前实例真断开"(remove + 发 PortDisconnected),借此区分主动关闭(已先 remove)与
/// 断开后重开的同名新实例(不误杀)。
#[derive(Clone)]
pub struct Disconnect {
    pub port: String,
    pub instance: u64,
}

/// 物理层:读线程 + 命令通道(OS 句柄随 port_task 闭包生命周期,run 返回即 drop)。
/// 设备断开时丢弃、reopen 时重建。与逻辑层解耦——拔了只丢物理,保留占有权。
pub struct PhysicalLayer {
    pub join_handle: JoinHandle<()>,
    pub abort_handle: AbortHandle,
    pub command_tx: mpsc::Sender<PortCommand>,
}

/// 端口任务句柄(SerialManager 持有)。逻辑层 + 物理层解耦。
pub struct PortHandle {
    // 逻辑层:设备断开时保留(占有权不丢),reopen 复用
    /// 当前持有本端口的会话集合。空集时端口才真正拆除。
    pub holders: HashSet<SessionId>,
    pub config: SerialConfig,
    pub rx_buffer: Arc<RxBuffer>,
    /// 端口实例标识(每次 open/reopen 单调递增)。drainer 据此判断断开通知是否仍属当前实例,
    /// 区分主动关闭(已先 remove)与断开后重开的同名新实例(不误杀)。
    pub instance: u64,
    /// 设备已断开(读线程退出、OS 句柄 drop),但占有权保留,等 reopen 重建物理层。
    pub disconnected: bool,
    // 物理层:None = 断开(等 reopen);Some = 连接中
    pub physical: Option<PhysicalLayer>,
}

pub async fn run(
    port_name: String,
    port: Box<dyn serialport::SerialPort>,
    mut command_rx: mpsc::Receiver<PortCommand>,
    event_bus: Arc<EventBus>,
    rx_buffer: Arc<RxBuffer>,
    disconnect_tx: mpsc::Sender<Disconnect>,
    instance: u64,
) {
    // PortOpened 由 manager.acquire 在 open/reopen 成功后统一发(事件单所有权归 manager,
    // 与 PortClosed 一致);此处不再发,避免与 manager 双发。
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
    let disconnect_tx_read = disconnect_tx.clone();
    let instance_read = instance;
    let mut read_handle = tokio::task::spawn_blocking(move || {
        loop {
            if quit_read.load(Ordering::Relaxed) {
                return;
            }
            // 匀化节奏（借鉴 terminal-serial）：固定周期读，把细碎 read 攒成匀速小批，
            // 降低 IPC 次数与抖动幅度，缓解 webview 架构下输入/输出双 IPC 抖动导致的
            // “忽快忽慢”。代价：数据最多等一个周期(~5ms)才被读。
            // 5ms ≈ 每帧(rAF 16ms)约 3 批；要更匀调大、要更低延迟调小。
            std::thread::sleep(Duration::from_millis(5));
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
                        // 设备断开:通知 manager drainer(标 disconnected + 发 PortDisconnected)。
                        // spawn_blocking 内不能 .await,用 try_send 同步发;通道满(极端)丢则 warn 留痕
                        if disconnect_tx_read
                            .try_send(Disconnect { port: name_for_read.clone(), instance: instance_read })
                            .is_err()
                        {
                            tracing::warn!("端口 {} 断开通知被丢弃(drainer 通道满,可能留僵尸)", name_for_read);
                        }
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

    // command 循环（主 task）：串口写入串行化，天然单写者。
    // select! 同时等命令与读线程退出——读线程遇设备断开会先 try_send 通知再 return,
    // 其 JoinHandle 完成经 select! 唤醒本循环,使 run() 能结束(否则只在 Close 命令退出,
    // 设备断开时端口变僵尸)。
    let mut close_response: Option<oneshot::Sender<()>> = None;
    loop {
        tokio::select! {
            cmd = command_rx.recv() => match cmd {
                Some(PortCommand::Write(data, response_tx)) => {
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
                Some(PortCommand::Close(response_tx)) => {
                    tracing::info!("关闭端口: {}", port_name);
                    // 不立即回 response：先让读线程退出、port 释放，否则 close 后立刻重开
                    // 会因读线程仍持有 handle 而端口占用打不开
                    close_response = Some(response_tx);
                    break;
                }
                None => break,
            },
            // 读线程退出(设备断开已 try_send 通知 drainer;或 quit 主动关闭)→ 结束 run()
            _ = &mut read_handle => { break; }
        }
    }

    // 等读线程退出、port 释放(Close 路径:读线程仍在 loop,quit 后 100ms 内退)。
    // 但若读线程已自行退出(设备断开 → select! 命中 read_handle;或 command_rx None 路径下
    // 读线程已退),read_handle 已完成——再 await 会 panic(JoinHandle polled after completion)。
    // 故先 is_finished 判断:仅未完成时才 quit + 等。
    if !read_handle.is_finished() {
        quit.store(true, Ordering::Relaxed);
        let _ = tokio::time::timeout(Duration::from_millis(500), read_handle).await;
    }

    // 不在此发端口事件:事件单所有权交给 manager——主动关闭由 release/force_close 发
    // PortClosed,设备断开由 drainer 发 PortDisconnected(读线程已 try_send 通知)。
    // 原先这里发 PortClosed 与 manager 重复,现消除双发。
    tracing::info!("端口任务结束: {}", port_name);

    // 读线程已退出、port 已释放，现在才回 close response
    if let Some(tx) = close_response {
        let _ = tx.send(());
    }
}

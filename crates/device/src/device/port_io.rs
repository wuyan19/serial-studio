//! 远端设备端口的 PortIo 实现:把"远端 ss 的 WS 通道"适配成 core 的字节流。
//!
//! 推→拉缓冲:DeviceClient 的 reader 把远端 Binary 帧 push 进 inbound(Condvar 唤醒),
//! port_task 的读循环(5ms 匀化)从 read 弹出——对 core 而言与本地串口的阻塞读无差别。
//!
//! 断开语义(R2):设备连接断开时 DeviceClient 把全部 RemoteSharedIo 置 closed,
//! read 返回非 TimedOut 错误 → port_task 读循环走 Disconnect 路径 → drainer 标
//! disconnected(占有权保留)→ reopen 重新 acquire 重建。USB 拔插模型映射网络断连。

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use ss_core::{PortIo, SerialConfig};

use super::DeviceCommand;

/// 单个远端端口的共享状态:入站缓冲 + 关闭标记。DeviceClient(reader)与
/// RemotePortIo(读写句柄)各持一份 Arc。
pub(crate) struct RemoteSharedIo {
    inbound: Mutex<Inbound>,
    cv: Condvar,
    /// 读超时(取 SerialConfig.timeout_ms):无数据时 read 按此返回 TimedOut,
    /// 与本地串口的阻塞读语义一致(port_task 读循环依赖)。
    read_timeout: Duration,
    /// ClosePort 已发送标记:读写双句柄(try_clone 共享本 Arc)各 drop 一次,
    /// 本标志保证关闭通知只发一次(compare_exchange 裁决)。
    close_sent: AtomicBool,
}

struct Inbound {
    buf: VecDeque<u8>,
    closed: Option<io::Error>,
    /// 溢出丢弃的累计字节数(留痕用)。
    dropped: u64,
}

impl RemoteSharedIo {
    pub(crate) fn new(read_timeout: Duration) -> Self {
        Self {
            inbound: Mutex::new(Inbound {
                buf: VecDeque::new(),
                closed: None,
                dropped: 0,
            }),
            cv: Condvar::new(),
            read_timeout,
            close_sent: AtomicBool::new(false),
        }
    }

    /// DeviceClient reader 收到该端口的数据帧时调用(异步侧 → 阻塞读侧)。
    pub(crate) fn push(&self, data: &[u8]) {
        let mut inbound = self.inbound.lock().unwrap();
        // 上限对齐 core RxBuffer:远端推快于本地消费时丢最旧,防无界增长。
        // 丢弃计数留痕——静默丢字节最危险(用户只见终端缺字),至少日志可查。
        const MAX: usize = 65536;
        if inbound.buf.len() + data.len() > MAX {
            let overflow = (inbound.buf.len() + data.len()).saturating_sub(MAX);
            let drop_n = overflow.min(inbound.buf.len());
            if drop_n > 0 {
                inbound.dropped += drop_n as u64;
                tracing::warn!(
                    "远端端口缓冲溢出,丢最旧 {} 字节(累计 {} 字节)——本地消费过慢",
                    drop_n,
                    inbound.dropped
                );
            }
            inbound.buf.drain(..drop_n);
        }
        inbound.buf.extend(data.iter().copied());
        drop(inbound);
        self.cv.notify_one();
    }

    /// 设备连接断开:置 closed 并唤醒所有等待的 read(返回 Err → 断开路径)。
    pub(crate) fn close_with_error(&self, err: io::Error) {
        let mut inbound = self.inbound.lock().unwrap();
        if inbound.closed.is_none() {
            inbound.closed = Some(err);
        }
        drop(inbound);
        self.cv.notify_all();
    }

    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut inbound = self.inbound.lock().unwrap();
        loop {
            if let Some(err) = &inbound.closed {
                return Err(io::Error::new(err.kind(), err.to_string()));
            }
            if !inbound.buf.is_empty() {
                let n = buf.len().min(inbound.buf.len());
                for slot in buf.iter_mut().take(n) {
                    *slot = inbound.buf.pop_front().unwrap();
                }
                return Ok(n);
            }
            // 空且未关:限时等待(远端推数据或断开会唤醒),超时返 TimedOut(读循环续轮)
            let (guard, timeout) = self.cv.wait_timeout(inbound, self.read_timeout).unwrap();
            inbound = guard;
            if timeout.timed_out() && inbound.buf.is_empty() && inbound.closed.is_none() {
                return Err(io::Error::from(io::ErrorKind::TimedOut));
            }
        }
    }
}

/// 远端端口的 PortIo 句柄。write 经命令通道发往设备连接(单通道保序),
/// 回执由 DeviceClient 的 reader 收到 Ok/Error 后路由回来。
pub(crate) struct RemotePortIo {
    shared: Arc<RemoteSharedIo>,
    /// 设备命令通道(与 open 同一通道——写与开关天然保序,close 不走旁路)。
    cmd_tx: tokio::sync::mpsc::UnboundedSender<DeviceCommand>,
    /// 设备共享态(Drop 时查同端口活条目用)。
    inner: std::sync::Arc<super::client::DeviceInner>,
    port: String,
}

impl RemotePortIo {
    pub(crate) fn new(
        shared: Arc<RemoteSharedIo>,
        cmd_tx: tokio::sync::mpsc::UnboundedSender<DeviceCommand>,
        inner: std::sync::Arc<super::client::DeviceInner>,
        port: String,
    ) -> Self {
        Self {
            shared,
            cmd_tx,
            inner,
            port,
        }
    }
}

/// 句柄释放(port_task teardown:manager 末位 release → Close 命令 → run() 返回 →
/// 读写句柄 drop)即通知远端关闭端口。两道防误拆闸门:
/// - **同端口还有其它活句柄**(并发 acquire 的 TOCTOU 输家——远端占有权以 ws 连接为
///   粒度坍缩成一份,输家按"我独占"发 Close 会把赢家的端口拆掉):不发,让渡给最后
///   存活的句柄;
/// - **close_sent 标志**(compare_exchange 裁决,读写双句柄共享同一 Arc):保证同一条
///   逻辑关闭只发一次 ClosePort——此前第二个句柄 drop 会再发一次(幂等无害但与注释
///   相悖),现在从机制上消除。
impl Drop for RemotePortIo {
    fn drop(&mut self) {
        // 还有别的活句柄(非同一 Arc 实例)挂着同端口 → 关闭责任让给它(不动标志)
        let others_alive = {
            let ports = self.inner.ports.lock().unwrap();
            ports.iter().any(|(p, weak)| {
                p == &self.port
                    && match weak.upgrade() {
                        Some(arc) => !std::sync::Arc::ptr_eq(&arc, &self.shared),
                        None => false,
                    }
            })
        };
        if others_alive {
            return;
        }
        // 双句柄只发一次:第一个 drop 的胜出发送,第二个见到标志直接跳过
        if !self.shared.close_sent.swap(true, Ordering::AcqRel) {
            let _ = self.cmd_tx.send(DeviceCommand::ClosePort {
                port: self.port.clone(),
            });
        }
    }
}

impl io::Read for RemotePortIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.shared.read(buf)
    }
}

/// 写回执等待上限。**须短于** manager.write 的外层 5s 超时——同值时外层先报
/// "写超时"而写实际成功(回执随后到达被丢),产生假错误;内层收紧让真实结果先达。
const WRITE_RPC_TIMEOUT: Duration = Duration::from_secs(4);

impl io::Write for RemotePortIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // hex 编码走 JSON write action(线上 JSON 文本不能携带任意字节)
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<io::Result<()>>();
        let cmd = DeviceCommand::Write {
            port: self.port.clone(),
            data: buf.to_vec(),
            reply: reply_tx,
        };
        self.cmd_tx
            .send(cmd)
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionAborted, "设备连接已断开"))?;
        // 限时等回执:超时视为断连(远端写慢/半开)。std mpsc 才能限时,
        // 保证 spawn_blocking 线程必返回(不依赖 manager.write 的外层超时)。
        match reply_rx.recv_timeout(WRITE_RPC_TIMEOUT) {
            Ok(Ok(())) => Ok(buf.len()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "远端写回执超时")),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl PortIo for RemotePortIo {
    fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
        // 克隆共享同一 Arc 与命令通道:读句柄只读、写句柄只写,两句柄见同一底层流
        Ok(Box::new(RemotePortIo {
            shared: Arc::clone(&self.shared),
            cmd_tx: self.cmd_tx.clone(),
            inner: std::sync::Arc::clone(&self.inner),
            port: self.port.clone(),
        }))
    }
}

/// 从配置取读超时(阻塞读的 TimedOut 周期)。
pub(crate) fn read_timeout_of(config: &SerialConfig) -> Duration {
    let ms = config.timeout_ms.clamp(10, 1000);
    Duration::from_millis(ms)
}

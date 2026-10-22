//! SSH 通道的 PortIo 实现：把"russh 的异步 channel"适配成 core 的同步阻塞字节流。
//!
//! 结构镜像 server/src/device/port_io.rs 的 RemotePortIo——推→拉缓冲(session 的
//! reader 任务把 channel 数据 push 进 inbound,Condvar 唤醒) + 命令通道写(与 open
//! 同通道保序)。对 core 而言与本地串口的阻塞读无差别。
//!
//! 断开语义:SSH channel Eof/Close 或连接断 → session 把全部 SshSharedIo 置 closed,
//! read 返回非 TimedOut 错误 → port_task 走 Disconnect 路径 → drainer 标
//! disconnected(占有权保留)→ reopen 重连(新连接)。USB 拔插模型映射网络断连。

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use ss_core::{PortIo, SerialConfig};

use super::SshCommand;

/// 单个实例(一条 PTY channel)的共享状态。session(reader)与 SshPortIo(读写句柄)
/// 各持一份 Arc——try_clone 的双句柄共享同一底层流。
pub(crate) struct SshSharedIo {
    inbound: Mutex<Inbound>,
    cv: Condvar,
    /// 读超时(取 SerialConfig.timeout_ms):无数据时 read 返回 TimedOut 续轮,
    /// 与本地串口语义一致(port_task 读循环依赖)。
    read_timeout: Duration,
    /// 实例关闭通知已发标记:读写双句柄各 drop 一次,compare_exchange 裁决只发一次。
    close_sent: AtomicBool,
}

struct Inbound {
    buf: VecDeque<u8>,
    closed: Option<io::Error>,
    dropped: u64,
}

impl SshSharedIo {
    pub(crate) fn new(read_timeout: Duration) -> Self {
        Self {
            inbound: Mutex::new(Inbound { buf: VecDeque::new(), closed: None, dropped: 0 }),
            cv: Condvar::new(),
            read_timeout,
            close_sent: AtomicBool::new(false),
        }
    }

    /// session reader 收到该实例的数据时调用(异步侧 → 阻塞读侧)。
    pub(crate) fn push(&self, data: &[u8]) {
        let mut inbound = self.inbound.lock().unwrap();
        // 上限对齐 core RxBuffer:远端推快于本地消费时丢最旧,防无界增长(留痕)。
        const MAX: usize = 65536;
        if inbound.buf.len() + data.len() > MAX {
            let overflow = (inbound.buf.len() + data.len()).saturating_sub(MAX);
            let drop_n = overflow.min(inbound.buf.len());
            if drop_n > 0 {
                inbound.dropped += drop_n as u64;
                tracing::warn!(
                    "SSH 实例缓冲溢出,丢最旧 {} 字节(累计 {} 字节)——本地消费过慢",
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

    /// 实例结束(Eof/Close/断连):置 closed 唤醒所有等待的 read(Err → 断开路径)。
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
            let (guard, timeout) = self.cv.wait_timeout(inbound, self.read_timeout).unwrap();
            inbound = guard;
            if timeout.timed_out() && inbound.buf.is_empty() && inbound.closed.is_none() {
                return Err(io::Error::from(io::ErrorKind::TimedOut));
            }
        }
    }
}

/// SSH 实例的 PortIo 句柄。write 经命令通道发往 session 任务(与 open 同通道保序)。
pub(crate) struct SshPortIo {
    shared: Arc<SshSharedIo>,
    cmd_tx: tokio::sync::mpsc::UnboundedSender<SshCommand>,
    /// 实例全键(hostId::shell@N)——命令路由与 Drop 关闭通知用。
    instance: String,
}

impl SshPortIo {
    pub(crate) fn new(
        shared: Arc<SshSharedIo>,
        cmd_tx: tokio::sync::mpsc::UnboundedSender<SshCommand>,
        instance: String,
    ) -> Self {
        Self { shared, cmd_tx, instance }
    }
}

/// 句柄释放即通知 session 关实例。close_sent 保证双句柄只发一次(同 RemotePortIo)。
impl Drop for SshPortIo {
    fn drop(&mut self) {
        if !self.shared.close_sent.swap(true, Ordering::AcqRel) {
            let _ = self.cmd_tx.send(SshCommand::CloseInstance { instance: self.instance.clone() });
        }
    }
}

impl io::Read for SshPortIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.shared.read(buf)
    }
}

/// 写回执等待上限:须短于 manager.write 的外层 5s 超时(真实结果先达,防假错)。
const WRITE_RPC_TIMEOUT: Duration = Duration::from_secs(4);

impl io::Write for SshPortIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<io::Result<()>>();
        self.cmd_tx
            .send(SshCommand::Write {
                instance: self.instance.clone(),
                data: buf.to_vec(),
                reply: reply_tx,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionAborted, "SSH 连接已断开"))?;
        match reply_rx.recv_timeout(WRITE_RPC_TIMEOUT) {
            Ok(Ok(())) => Ok(buf.len()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "SSH 写回执超时")),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl PortIo for SshPortIo {
    fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
        Ok(Box::new(SshPortIo {
            shared: Arc::clone(&self.shared),
            cmd_tx: self.cmd_tx.clone(),
            instance: self.instance.clone(),
        }))
    }
}

/// 从配置取读超时(阻塞读的 TimedOut 周期)。
pub(crate) fn read_timeout_of(config: &SerialConfig) -> Duration {
    Duration::from_millis(config.timeout_ms.clamp(10, 1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 桥接语义三则:数据先 push 后 read 可读;关闭后 read 恒 Err;空转超时返 TimedOut。
    #[test]
    fn push_read_close_semantics() {
        let shared = SshSharedIo::new(Duration::from_millis(50));
        shared.push(b"hello");
        let mut buf = [0u8; 8];
        assert_eq!(shared.read(&mut buf).unwrap(), 5);
        assert_eq!(&buf[..5], b"hello");
        shared.close_with_error(io::Error::new(io::ErrorKind::ConnectionReset, "断开"));
        assert!(matches!(
            shared.read(&mut buf),
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset
        ));
    }

    #[test]
    fn idle_read_times_out() {
        let shared = SshSharedIo::new(Duration::from_millis(30));
        let mut buf = [0u8; 4];
        assert!(matches!(
            shared.read(&mut buf),
            Err(e) if e.kind() == io::ErrorKind::TimedOut
        ));
    }

    /// 数据在等待期间到达:限时等待被 notify 唤醒,不空等满超时。
    #[test]
    fn wait_wakes_on_push() {
        let shared = Arc::new(SshSharedIo::new(Duration::from_secs(5)));
        let producer = Arc::clone(&shared);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            producer.push(b"x");
        });
        let mut buf = [0u8; 4];
        let t = std::time::Instant::now();
        assert_eq!(shared.read(&mut buf).unwrap(), 1);
        assert!(t.elapsed() < Duration::from_secs(2), "应被唤醒而非等满 5s");
    }
}

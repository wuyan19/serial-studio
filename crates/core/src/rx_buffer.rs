//! 每端口接收缓冲区：FIFO，供 MCP/宏做非破坏性 grep 与破坏性 drain。
//!
//! 同步原语（std Mutex + Condvar）：port_task 在 spawn_blocking 中 push，
//! manager 的 drain/grep 通过 spawn_blocking 包装调用（避免阻塞 tokio worker）。
//! 设计参考 terminal-serial 的 SerialManager 缓冲区。

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

const RX_BUFFER_MAX: usize = 65536;
const CONTEXT: usize = 16;

pub struct RxBuffer {
    buf: Mutex<VecDeque<u8>>,
    cvar: Condvar,
}

impl RxBuffer {
    pub fn new() -> Self {
        Self {
            buf: Mutex::new(VecDeque::with_capacity(RX_BUFFER_MAX)),
            cvar: Condvar::new(),
        }
    }

    /// 追加数据（满则丢弃最旧）。port_task 读循环调用。
    pub fn push(&self, data: &[u8]) {
        let mut buf = self.buf.lock().unwrap();
        for &b in data {
            if buf.len() >= RX_BUFFER_MAX {
                buf.pop_front();
            }
            buf.push_back(b);
        }
        self.cvar.notify_one();
    }

    /// 非破坏性读取全部。
    pub fn peek(&self) -> Vec<u8> {
        self.buf.lock().unwrap().iter().copied().collect()
    }

    /// 破坏性读取：返回并清空。空时按 timeout 等待数据到达。
    pub fn drain(&self, timeout_ms: u64) -> Vec<u8> {
        let mut buf = self.buf.lock().unwrap();
        if timeout_ms > 0 && buf.is_empty() {
            let guard = self
                .cvar
                .wait_timeout(buf, Duration::from_millis(timeout_ms))
                .unwrap_or_else(|e| e.into_inner());
            buf = guard.0;
        }
        buf.drain(..).collect()
    }

    /// 破坏性读取（带静默期判定，命令-响应场景用）：
    /// 首字节前一直等到 deadline；首字节到达后，每段只等 idle_ms，
    /// 连续 idle_ms 无新数据即视为响应完整，返回累积的全部内容。
    /// 解决 drain() "取首片即返回" 导致多分片响应被截断的问题。
    ///
    /// 注意：响应中途出现 >idle_ms 的间隙会从间隙处返回（如 modem 回显后停顿再回 OK）；
    /// 持续流式数据（间隙始终 <idle_ms）会一直阻塞到 deadline。这两种场景需评估 idle_ms
    /// 取值或改用 drain()/serial_read。返回内容包含调用时已缓冲的全部数据。
    pub fn drain_quiet(&self, deadline_ms: u64, idle_ms: u64) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let idle = Duration::from_millis(idle_ms);
        let mut buf = self.buf.lock().unwrap();
        let mut out = Vec::new();
        let mut seen_data = !buf.is_empty();
        out.extend(buf.drain(..));
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            // 首字节前：等到 deadline；之后：每段只等 idle（静默期判定）
            let wait = (if seen_data { idle } else { remaining }).min(remaining);
            let (guard, wt) = self
                .cvar
                .wait_timeout(buf, wait)
                .unwrap_or_else(|e| e.into_inner());
            buf = guard;
            if !buf.is_empty() {
                out.extend(buf.drain(..));
                seen_data = true;
            }
            if wt.timed_out() {
                break; // 静默期到（首字节后）或 deadline 到（首字节前）
            }
        }
        out
    }

    pub fn clear(&self) {
        self.buf.lock().unwrap().clear();
    }

    /// 正则匹配文本行（非破坏）。空时按 timeout 等待。返回匹配行。
    pub fn grep_text(&self, re: &regex::Regex, timeout_ms: u64) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let buf = self.buf.lock().unwrap();
            let bytes: Vec<u8> = buf.iter().copied().collect();
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<String> = text
                .lines()
                .filter(|l| re.is_match(l))
                .map(|s| s.to_string())
                .collect();
            if !lines.is_empty() || timeout_ms == 0 {
                return lines;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return lines;
            }
            let guard = self
                .cvar
                .wait_timeout(buf, remaining)
                .unwrap_or_else(|e| e.into_inner());
            drop(guard.0);
        }
    }

    /// 字节序列匹配（非破坏）。返回 (偏移, 上下文前后各 CONTEXT 字节)。
    pub fn grep_bytes(&self, pattern: &[u8], timeout_ms: u64) -> Vec<(usize, Vec<u8>)> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let buf = self.buf.lock().unwrap();
            let bytes: Vec<u8> = buf.iter().copied().collect();
            let matches: Vec<(usize, Vec<u8>)> = bytes
                .windows(pattern.len())
                .enumerate()
                .filter(|(_, w)| *w == pattern)
                .map(|(pos, _)| {
                    let start = pos.saturating_sub(CONTEXT);
                    let end = (pos + pattern.len() + CONTEXT).min(bytes.len());
                    (pos, bytes[start..end].to_vec())
                })
                .collect();
            if !matches.is_empty() || timeout_ms == 0 {
                return matches;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return matches;
            }
            let guard = self
                .cvar
                .wait_timeout(buf, remaining)
                .unwrap_or_else(|e| e.into_inner());
            drop(guard.0);
        }
    }
}

impl Default for RxBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_peek_drain() {
        let b = RxBuffer::new();
        b.push(b"hello");
        assert_eq!(b.peek(), b"hello");
        assert_eq!(b.drain(0), b"hello");
        assert!(b.peek().is_empty());
    }

    #[test]
    fn drain_timeout_returns_empty() {
        let b = RxBuffer::new();
        let start = Instant::now();
        let r = b.drain(50);
        assert!(r.is_empty());
        assert!(start.elapsed() >= Duration::from_millis(40));
    }

    #[test]
    fn drain_quiet_accumulates_multi_chunk() {
        // 模拟设备分三拨吐数据（每拨间隔 20ms < idle 30ms，流式期间静默期不断重置）：
        // drain_quiet 应等到最后一拨 + 一个 idle 静默期后，把三段拼齐返回。
        let b = std::sync::Arc::new(RxBuffer::new());
        let producer = std::sync::Arc::clone(&b);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            producer.push(b"part1-");
            std::thread::sleep(Duration::from_millis(20));
            producer.push(b"part2-");
            std::thread::sleep(Duration::from_millis(20));
            producer.push(b"part3");
        });
        let r = b.drain_quiet(1000, 30);
        assert_eq!(r, b"part1-part2-part3");
    }

    #[test]
    fn drain_quiet_no_data_returns_empty() {
        // 首字节前等到 deadline 仍无数据 → 返回空，且耗时 ≈ deadline。
        let b = RxBuffer::new();
        let start = Instant::now();
        let r = b.drain_quiet(50, 30);
        assert!(r.is_empty());
        assert!(start.elapsed() >= Duration::from_millis(45));
    }

    #[test]
    fn drain_quiet_buf_nonempty_returns_after_idle() {
        // 调用时缓冲区已有数据（seen_data 初始 true）：应等一个 idle 静默期后返回，而非等到 deadline。
        let b = RxBuffer::new();
        b.push(b"stale");
        let start = Instant::now();
        let r = b.drain_quiet(200, 30);
        assert_eq!(r, b"stale");
        assert!(
            start.elapsed() < Duration::from_millis(150),
            "不应等到 deadline: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn drain_quiet_deadline_zero_returns_initial() {
        // deadline=0：立即返回初始 buf 内容，不等待。
        let b = RxBuffer::new();
        b.push(b"x");
        assert_eq!(b.drain_quiet(0, 40), b"x");
        // 空缓冲 + deadline=0 同样立即返回空
        assert!(RxBuffer::new().drain_quiet(0, 40).is_empty());
    }

    #[test]
    fn drain_quiet_idle_ge_deadline_no_hang() {
        // idle > deadline：不能挂死，应被 deadline 兜底（约 deadline_ms 后返回空）。
        let b = RxBuffer::new();
        let start = Instant::now();
        let r = b.drain_quiet(40, 1000);
        assert!(r.is_empty());
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(300),
            "idle>deadline 不应挂死: {:?}",
            elapsed
        );
        assert!(
            elapsed >= Duration::from_millis(35),
            "应被 deadline 兜底: {:?}",
            elapsed
        );
    }

    #[test]
    fn drain_quiet_inter_gap_gt_idle_returns_early() {
        // 响应中途间隙 > idle：从间隙处返回（只拿到第一拨），文档化该行为。
        let b = std::sync::Arc::new(RxBuffer::new());
        let producer = std::sync::Arc::clone(&b);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            producer.push(b"chunk1");
            // 间隙 60ms > idle 30ms → drain_quiet 会在 chunk1 后约 30ms 返回
            std::thread::sleep(Duration::from_millis(60));
            producer.push(b"chunk2");
        });
        let r = b.drain_quiet(1000, 30);
        assert_eq!(r, b"chunk1", "间隙>idle 应只返回第一拨");
    }

    #[test]
    fn grep_text_matches_line() {
        let b = RxBuffer::new();
        b.push(b"OK\r\nERROR\r\n");
        let re = regex::Regex::new("OK").unwrap();
        assert_eq!(b.grep_text(&re, 0), vec!["OK".to_string()]);
        // 非破坏：缓冲区仍在（OK\r\nERROR\r\n = 11 字节）
        assert_eq!(b.peek().len(), 11);
    }

    #[test]
    fn grep_bytes_finds_pattern() {
        let b = RxBuffer::new();
        b.push(b"\xAA\x55\x01\x02");
        let m = b.grep_bytes(&[0xAA, 0x55], 0);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].0, 0);
    }
}

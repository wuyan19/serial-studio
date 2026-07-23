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

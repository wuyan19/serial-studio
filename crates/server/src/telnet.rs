//! Telnet 服务器：传统终端客户端（putty/telnet）接入。
//!
//! 多串口协商：客户端连接后发送端口名选口，之后双向转发该串口数据。
//! 数据通路：客户端输入 → SerialManager.write；EventBus 的 DataReceived → 客户端。
//!
//! 协议协商（IAC/WILL ECHO + SUPPRESS-GA）与命令过滤移植自 terminal-serial。

use crate::AppState;
use ss_core::SerialEvent;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

// telnet 协议常量
const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const SB: u8 = 250;
const SE: u8 = 240;
const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GA: u8 = 3;

// WILL ECHO（服务器负责回显）+ WILL SUPPRESS-GA（抑制 Go-Ahead）
const HANDSHAKE: &[u8] = &[IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SUPPRESS_GA];

/// Telnet 服务句柄（可停）。由 ServiceSupervisor 持有以支持热重启。
pub struct TelnetHandle {
    shutdown_tx: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

impl TelnetHandle {
    /// 停止 accept 循环并等待退出（释放监听端口）。
    /// 已连接的客户端 task 不受影响，自然结束。
    pub async fn stop(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.join.await;
    }
}

/// 启动 Telnet 服务器（非阻塞，返回可停句柄）。
pub async fn start_telnet(addr: String, state: AppState) -> anyhow::Result<TelnetHandle> {
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!("Telnet server: telnet://{}", addr);
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    tracing::info!("Telnet 服务器关闭");
                    return;
                }
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer)) => {
                            tracing::info!("telnet 客户端连接: {}", peer);
                            let state = state.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_client(stream, state).await {
                                    tracing::warn!("telnet 客户端错误: {}", e);
                                }
                            });
                        }
                        Err(e) => tracing::warn!("telnet accept 错误: {}", e),
                    }
                }
            }
        }
    });
    Ok(TelnetHandle { shutdown_tx, join })
}

/// 运行 Telnet 服务器（阻塞，兼容 headless/ss-server bin）。
pub async fn run_telnet(addr: String, state: AppState) -> anyhow::Result<()> {
    let handle = start_telnet(addr, state).await?;
    let _ = handle.join.await;
    Ok(())
}

async fn handle_client(mut stream: TcpStream, state: AppState) -> anyhow::Result<()> {
    // telnet 协议协商
    let _ = stream.write_all(HANDSHAKE).await;

    // 提示选口
    let open = state.manager.list_open_ports().await;
    if open.is_empty() {
        let _ = stream
            .write_all("\r\nserial-studio telnet\r\n没有已打开的串口，请先在 UI 打开后重连。\r\n".as_bytes())
            .await;
        return Ok(());
    }
    let prompt = format!(
        "\r\nserial-studio telnet\r\n已打开串口: {}\r\n输入端口名选择（如 {}）: ",
        open.join(", "),
        open[0]
    );
    let _ = stream.write_all(prompt.as_bytes()).await;

    // 读端口名（循环过滤 telnet 协商字节，回显，直到拿到一行）
    // telnet 客户端连接时会先发 IAC 协商，必须滤掉，否则协商字节被误当端口名
    let mut port = String::new();
    let mut buf = vec![0u8; 256];
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        let (payload, _) = filter_telnet(&buf[..n]);
        if !payload.is_empty() {
            let _ = stream.write_all(&payload).await; // 回显（WILL ECHO 下服务器负责）
        }
        port.push_str(&String::from_utf8_lossy(&payload));
        if port.contains('\n') || port.contains('\r') {
            break;
        }
    }
    let port: String = port
        .trim_matches(|c: char| c == '\r' || c == '\n' || c == ' ' || c == '\0')
        .to_string();

    if port.is_empty() || !state.manager.is_open(&port).await || state.manager.is_disconnected(&port).await {
        let _ = stream
            .write_all(format!("串口 {} 未打开或已断开，断开。\r\n", port).as_bytes())
            .await;
        return Ok(());
    }

    let _ = stream
        .write_all(format!("\r\n已连接 {}。直接输入即发送，关闭窗口退出。\r\n", port).as_bytes())
        .await;

    // 拆分读写为两个独立 future 并发跑，避免「写入串口」的 await 期间
    // 串口回显数据堆积在 EventBus 被 lagged 丢弃（快速输入时表现为回显吞字符）
    let mut event_rx = state.event_bus.subscribe();
    let (mut rd, mut wr) = stream.into_split();
    let port_for_read = port.clone();
    let port_for_log = port.clone();
    let mgr = state.manager.clone();

    // 客户端 → 串口
    let read_fut = async move {
        let mut buf = vec![0u8; 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let (payload, _) = filter_telnet(&buf[..n]);
                    // 剥离 NUL：telnet 回车发送 \r\0
                    let filtered: Vec<u8> = payload.into_iter().filter(|&b| b != 0).collect();
                    if !filtered.is_empty() {
                        let _ = mgr
                            .write(port_for_read.clone(), bytes::Bytes::from(filtered))
                            .await;
                    }
                }
            }
        }
    };

    // 串口 → 客户端
    let event_fut = async move {
        loop {
            match event_rx.recv().await {
                Ok(SerialEvent::DataReceived { port: p, data }) if p == port => {
                    if wr.write_all(&data).await.is_err() {
                        return;
                    }
                }
                Ok(SerialEvent::PortClosed { port: p }) if p == port => {
                    let _ = wr.write_all("\r\n[串口已关闭]\r\n".as_bytes()).await;
                    return;
                }
                Ok(SerialEvent::PortDisconnected { port: p }) if p == port => {
                    let _ = wr.write_all("\r\n[设备已断开 — 请在桌面端重连]\r\n".as_bytes()).await;
                    return;
                }
                Ok(SerialEvent::Error { port: p, message }) if p == port => {
                    let _ = wr
                        .write_all(format!("\r\n[错误: {}]\r\n", message).as_bytes())
                        .await;
                }
                Err(_) => return,
                _ => {}
            }
        }
    };

    // 任一 future 结束（客户端断开 / 串口关闭）则退出
    tokio::select! {
        _ = read_fut => {},
        _ = event_fut => {},
    }
    tracing::info!("telnet 客户端断开: {}", port_for_log);
    Ok(())
}

/// 过滤 telnet 协议命令，返回 (纯数据, 协商响应)。移植自 terminal-serial。
fn filter_telnet(data: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut payload = Vec::new();
    let mut response = Vec::new();
    let mut i = 0;
    while i < data.len() {
        if data[i] == IAC {
            if i + 1 >= data.len() {
                break;
            }
            match data[i + 1] {
                IAC => {
                    payload.push(IAC);
                    i += 2;
                }
                WILL | WONT => {
                    if i + 2 < data.len() {
                        response.extend_from_slice(&[IAC, DO, data[i + 2]]);
                    }
                    i += 3;
                }
                DO => {
                    if i + 2 < data.len() {
                        if data[i + 2] == OPT_ECHO || data[i + 2] == OPT_SUPPRESS_GA {
                            // 我们主动 WILL 过的，客户端同意，不需额外回复
                        } else {
                            response.extend_from_slice(&[IAC, WONT, data[i + 2]]);
                        }
                    }
                    i += 3;
                }
                DONT => {
                    if i + 2 < data.len() {
                        response.extend_from_slice(&[IAC, WONT, data[i + 2]]);
                    }
                    i += 3;
                }
                SB => {
                    i += 2;
                    while i + 1 < data.len() {
                        if data[i] == IAC && data[i + 1] == SE {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => {
                    i += 2;
                }
            }
        } else {
            payload.push(data[i]);
            i += 1;
        }
    }
    (payload, response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_strips_iac_commands() {
        // IAC WILL ECHO + 纯数据 "hi"
        let input = [IAC, WILL, OPT_ECHO, b'h', b'i'];
        let (payload, _resp) = filter_telnet(&input);
        assert_eq!(payload, b"hi");
    }

    #[test]
    fn iac_escaped_as_data() {
        // IAC IAC → 一个 0xFF 数据字节
        let input = [IAC, IAC, b'x'];
        let (payload, _) = filter_telnet(&input);
        assert_eq!(payload, vec![0xFF, b'x']);
    }

    #[test]
    fn nul_not_stripped_by_filter() {
        // NUL 剥离在调用方做，filter 只处理 IAC
        let input = [b'a', 0, b'b'];
        let (payload, _) = filter_telnet(&input);
        assert_eq!(payload, vec![b'a', 0, b'b']);
    }
}

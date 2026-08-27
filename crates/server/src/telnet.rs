//! Telnet 服务器：传统终端客户端（putty/telnet）接入。
//!
//! 多串口协商：客户端连接后发送端口名选口，之后双向转发该串口数据。
//! 数据通路：客户端输入 → SerialManager.write；EventBus 的 DataReceived → 客户端。
//!
//! 协议协商（IAC/WILL ECHO + SUPPRESS-GA）与命令过滤移植自 terminal-serial。
//! 线上文案（提示/告别/事件通知）保持 ASCII 英文——传统终端的编码随 locale
//! 漂移，非 ASCII 字节在部分客户端即乱码。

use crate::AppState;
use ss_core::SerialEvent;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

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

    // 编号选口菜单:以 manager map 键为权威(含已开的远端复合键),用列表接口补
    // 别名/昵称做友好名(设备昵称>uuid、端口别名>真实名)
    let open_keys = state.manager.list_open_ports().await;
    let aliases: std::collections::HashMap<String, Option<String>> =
        crate::list_ports_with_meta(&state)
            .await
            .into_iter()
            .map(|v| (v.info.name.clone(), v.alias))
            .collect();
    let open: Vec<(String, Option<String>)> = open_keys
        .into_iter()
        .map(|k| {
            let alias = aliases.get(&k).cloned().flatten();
            (k, alias)
        })
        .collect();
    if open.is_empty() {
        farewell(
            &mut stream,
            "\r\nNo open serial ports. Open one in the app, then reconnect.\r\n",
        )
        .await;
        return Ok(());
    }
    let names: Vec<String> = open
        .iter()
        .map(|(k, a)| friendly_port_name(k, a.as_deref(), &state))
        .collect();
    let sep = "-".repeat(27);
    let mut menu = format!("\r\n{sep}\r\n    Open Port List\r\n{sep}\r\n");
    for (i, name) in names.iter().enumerate() {
        menu.push_str(&format!("{} - {}\r\n", i + 1, name));
    }
    let select_prompt = format!("{sep}\r\nSelect <1~{}>: ", names.len());
    menu.push_str(&select_prompt);
    let _ = stream.write_all(menu.as_bytes()).await;

    // 选口:编号为主;名称回退(脚本/熟练用户按名寻址,canon 解析——裸名/别名/
    // 设备昵称作用域/叶别名——为已开口即选中)。空行重示提示不计数,连续
    // MAX_SELECTION_ATTEMPTS 次无效输入告别断开,防失控客户端无限占连接
    const MAX_SELECTION_ATTEMPTS: usize = 3;
    let mut attempts = 0;
    let (port, display) = loop {
        let Some(line) = read_line(&mut stream).await else {
            return Ok(()); // 客户端已断开
        };
        let typed = line.trim_matches(|c: char| c == '\r' || c == '\n' || c == ' ' || c == '\0');
        if typed.is_empty() {
            let _ = stream.write_all(select_prompt.as_bytes()).await;
            continue;
        }
        let selected = match typed.parse::<usize>() {
            Ok(n) if (1..=open.len()).contains(&n) => Some(open[n - 1].clone()),
            _ => {
                // 名称路径:canon_key 后须为已开且未断开的口
                let key = state.manager.canon_key(typed);
                if !key.is_empty()
                    && state.manager.is_open(&key).await
                    && !state.manager.is_disconnected(&key).await
                {
                    // 菜单构建后新开的口不在 open 里,别名取不到则回退键本身
                    Some(
                        open.iter()
                            .find(|(k, _)| k == &key)
                            .cloned()
                            .unwrap_or((key, None)),
                    )
                } else {
                    None
                }
            }
        };
        match selected {
            Some((key, alias)) => {
                let display = friendly_port_name(&key, alias.as_deref(), &state);
                break (key, display);
            }
            None => {
                attempts += 1;
                if attempts >= MAX_SELECTION_ATTEMPTS {
                    farewell(&mut stream, "No valid selection. Closing.\r\n").await;
                    return Ok(());
                }
                let _ = stream.write_all(select_prompt.as_bytes()).await;
            }
        }
    };

    let _ = stream
        .write_all(format!("\r\nConnected to {}.\r\n", display).as_bytes())
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
        let mut pending_cr = false; // \r 落在上一读块末尾时,吞掉下一块开头的 \n
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let (payload, _) = filter_telnet(&buf[..n]);
                    // 剥离 NUL：telnet 回车发送 \r\0
                    let filtered: Vec<u8> = payload.into_iter().filter(|&b| b != 0).collect();
                    // 行尾归一为 CR:telnet 客户端回车发 \r\n,多数串口设备把
                    // 随后的 \n 当第二条空命令(每条命令多出一个提示符)
                    let normalized = normalize_line_endings(&filtered, &mut pending_cr);
                    if !normalized.is_empty() {
                        let _ = mgr
                            .write(port_for_read.clone(), bytes::Bytes::from(normalized))
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
                    terminal_notice(&mut wr, "\r\n[port closed]\r\n").await;
                    return;
                }
                Ok(SerialEvent::PortDisconnected { port: p }) if p == port => {
                    terminal_notice(
                        &mut wr,
                        "\r\n[device disconnected - reconnect from the desktop app]\r\n",
                    )
                    .await;
                    return;
                }
                Ok(SerialEvent::Error { port: p, message }) if p == port => {
                    let _ = wr
                        .write_all(format!("\r\n[error: {}]\r\n", message).as_bytes())
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

/// 读一行选口输入:滤 IAC 协商字节(telnet 客户端连接即回协商,不滤会被误当
/// 端口名)、回显(WILL ECHO 下服务器负责),直到收到 \r/\n。客户端断开返回 None。
async fn read_line(stream: &mut TcpStream) -> Option<String> {
    let mut line = String::new();
    let mut buf = vec![0u8; 256];
    loop {
        let n = stream.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        let (payload, _) = filter_telnet(&buf[..n]);
        if !payload.is_empty() {
            let _ = stream.write_all(&payload).await;
        }
        line.push_str(&String::from_utf8_lossy(&payload));
        if line.contains('\n') || line.contains('\r') {
            return Some(line);
        }
    }
}

/// 发完告别消息再关连接（未拆分读写前的两条早退路径共用）。
///
/// 直接 write 后 drop 会触发 RST 竞态：真实 telnet 客户端连接后立即回发
/// IAC 协商应答，服务端此刻已停止读取 → 关闭时接收缓冲非空 → Windows 发
/// RST 而非 FIN → 客户端已收到未渲染的告别消息被整个丢弃，表现为
/// 「连上即退、什么都不显示」。故：写消息 → shutdown（FIN 保证消息先行）
/// → 排空客户端在途字节直至 EOF 或超时（此时接收缓冲已空，关闭是干净的）。
async fn farewell(stream: &mut TcpStream, msg: &str) {
    let _ = stream.write_all(msg.as_bytes()).await;
    let _ = stream.shutdown().await;
    let mut buf = [0u8; 256];
    let _ = timeout(Duration::from_millis(600), async {
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
}

/// 会话中断开通知（event 侧）：写消息后 shutdown 写半边 + 短暂停留。
/// 此处只持有写半边，无法排空读侧，靠 300ms 停留给客户端收完渲染——
/// 同 farewell 的 RST 问题的缓解形态。
async fn terminal_notice(wr: &mut tokio::net::tcp::OwnedWriteHalf, msg: &str) {
    let _ = wr.write_all(msg.as_bytes()).await;
    let _ = wr.shutdown().await;
    sleep(Duration::from_millis(300)).await;
}

/// 端口的用户可读名:设备段用昵称(uuid 兜底)、端口段用别名(真实名兜底)。
/// 产物同时是合法输入——canon_key 的昵称重写+叶别名解析能还原出同一 map 键
/// (别名替换只做一跳键;多级级联的后缀含 ::,叶别名解析只在下一跳发生,
/// 本地替换会造出还原不了的键,故后缀原样保留)。
fn friendly_port_name(key: &str, alias: Option<&str>, state: &AppState) -> String {
    let (dev, rest) = ss_core::split_port_key(key);
    if dev == ss_core::LOCAL_DEVICE_ID {
        return alias
            .map(str::to_string)
            .unwrap_or_else(|| rest.to_string());
    }
    let dev_name = state
        .addresses
        .nickname_of(dev)
        .unwrap_or_else(|| dev.to_string());
    let leaf = if rest.contains("::") {
        rest.to_string()
    } else {
        alias
            .map(str::to_string)
            .unwrap_or_else(|| rest.to_string())
    };
    format!("{}::{}", dev_name, leaf)
}

/// telnet 输入的行尾归一(CR 语义,串口控制台惯例):`\r\n`/裸 `\n` → 单个 `\r`。
/// `pending_cr` 跨读块延续状态——`\r` 在上一块末尾、`\n` 在下一块开头时同样吞并。
fn normalize_line_endings(data: &[u8], pending_cr: &mut bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        match b {
            b'\r' => {
                out.push(b'\r');
                *pending_cr = true;
            }
            b'\n' if *pending_cr => *pending_cr = false,
            b'\n' => out.push(b'\r'),
            _ => {
                *pending_cr = false;
                out.push(b);
            }
        }
    }
    out
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
    fn line_endings_collapse_crlf_to_cr() {
        // telnet 客户端回车发 \r\n → 设备只应收一个 \r
        let mut pending = false;
        assert_eq!(normalize_line_endings(b"at\r\n", &mut pending), b"at\r");
        assert!(!pending, "\\n 已被吞并,状态应复位");
    }

    #[test]
    fn line_endings_bare_lf_becomes_cr() {
        // 裸 \n(某些客户端模式)同样归一为 CR
        let mut pending = false;
        assert_eq!(normalize_line_endings(b"a\nb", &mut pending), b"a\rb");
    }

    #[test]
    fn line_endings_cr_split_across_reads() {
        // \r 在上一读块末尾、\n 在下一块开头 → 仍只出一个 \r
        let mut pending = false;
        assert_eq!(normalize_line_endings(b"x\r", &mut pending), b"x\r");
        assert!(pending);
        assert_eq!(normalize_line_endings(b"\nz", &mut pending), b"z");
        assert!(!pending);
    }

    #[test]
    fn line_endings_two_cr_kept() {
        // 连续两个显式 \r 是两次回车,不吞并
        let mut pending = false;
        assert_eq!(normalize_line_endings(b"a\rb\r", &mut pending), b"a\rb\r");
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

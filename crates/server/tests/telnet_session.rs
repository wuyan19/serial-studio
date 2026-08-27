//! Telnet 接入层端到端集成测试。
//!
//! 起真 telnet 监听（注入 FakeOpener 的内存状态），用裸 TCP 客户端复现
//! 真实客户端行为：协商 IAC 字节 → 选口提示 → 输入端口名 → 双向数据转发。

use ss_core::{
    EventBus, PortIo, PortOpener, SerialConfig, SerialError, SerialEvent, SerialManager, SessionId,
};
use ss_server::telnet::{start_telnet, TelnetHandle};
use ss_server::AppState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

// ===== 内存桩串口（read 返 TimedOut 模拟空闲;write 录制以便断言送达字节） =====

type WriteLog = std::sync::Mutex<Vec<u8>>;

struct RecordingPort(Arc<WriteLog>);
impl std::io::Read for RecordingPort {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::from(std::io::ErrorKind::TimedOut))
    }
}
impl std::io::Write for RecordingPort {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl PortIo for RecordingPort {
    fn try_clone(&self) -> std::io::Result<Box<dyn PortIo>> {
        Ok(Box::new(RecordingPort(Arc::clone(&self.0))))
    }
}

struct RecordingOpener(Arc<WriteLog>);
impl PortOpener for RecordingOpener {
    fn open(&self, _port: &str, _config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
        Ok(Box::new(RecordingPort(Arc::clone(&self.0))))
    }
}

/// 起内存状态 + telnet 监听，返回 (telnet 地址, manager, event_bus, 写入日志, 保活句柄)。
/// **句柄必须存活到测试结束**:TelnetHandle drop 即触发 shutdown(TelnetHandle.drop
/// 语义,见 telnet.rs),提前 drop 会表现为 ConnectionRefused。
async fn boot() -> (
    String,
    Arc<SerialManager>,
    Arc<EventBus>,
    Arc<WriteLog>,
    TelnetHandle,
) {
    let event_bus = Arc::new(EventBus::new(64));
    let write_log: Arc<WriteLog> = Arc::default();
    let manager = Arc::new(SerialManager::new(
        event_bus.clone(),
        Arc::new(RecordingOpener(Arc::clone(&write_log))),
    ));
    let (meta_tx, _) = tokio::sync::broadcast::channel(16);
    let (script_tx, _) = tokio::sync::broadcast::channel(16);
    let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
        meta_tx.clone(),
        "inst-telnet-session",
    ));
    devices.bind(Arc::downgrade(&devices));
    let state = AppState {
        manager: manager.clone(),
        event_bus: event_bus.clone(),
        meta_bus: Arc::new(meta_tx),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        devices,
        addresses: Arc::new(ss_server::address::AddressResolver::new(
            Arc::new(ss_server::device::DeviceClientManager::empty(
                tokio::sync::broadcast::channel(16).0,
                "inst-telnet-session",
            )),
            tokio::sync::broadcast::channel(16).0,
            "inst-telnet-session".into(),
        )),
        instance_id: "inst-telnet-session".into(),
    };
    // 选一个空闲端口（bind 0 后立刻让出，存在极小竞争窗口，本机测试可接受）
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let addr = format!("127.0.0.1:{}", port);
    let handle = start_telnet(addr.clone(), state).await.unwrap();
    (addr, manager, event_bus, write_log, handle)
}

/// 读直到缓冲包含 needle（3s 超时），返回累计缓冲。
async fn read_until(stream: &mut TcpStream, needle: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 256];
    let found = async {
        loop {
            let n = stream.read(&mut chunk).await.expect("读 telnet 流");
            assert!(n > 0, "telnet 服务器过早关闭连接");
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(needle.len()).any(|w| w == needle) {
                return;
            }
        }
    };
    match timeout(Duration::from_secs(3), found).await {
        Ok(()) => buf,
        Err(_) => panic!(
            "等待 {:?} 超时, 已收: {:?}",
            String::from_utf8_lossy(needle),
            String::from_utf8_lossy(&buf)
        ),
    }
}

#[tokio::test]
async fn telnet_full_flow_connect_select_and_forward() {
    let (addr, manager, event_bus, write_log, _telnet) = boot().await;

    // UI 侧先打开 COM7（telnet 要求已有打开的串口）
    let session = SessionId::next();
    manager
        .acquire("COM7".into(), SerialConfig::default(), session)
        .await
        .expect("打开 COM7");

    // 客户端连接（真实 telnet 客户端连接即回 IAC 协商应答）
    let mut client = TcpStream::connect(&addr)
        .await
        .expect("TCP 连接 telnet 服务器");

    // 1) 收到协商 + 编号选口菜单(表头 + 条目 + Select 提示;菜单条目可能是
    //    别名等友好名,不断言具体端口名形态)
    let banner = read_until(&mut client, "Select <1~1>".as_bytes()).await;
    let banner_text = String::from_utf8_lossy(&banner);
    assert!(
        banner_text.contains("Open Port List"),
        "应含菜单表头: {}",
        banner_text
    );
    assert!(
        banner_text.contains("1 - "),
        "应含编号条目: {}",
        banner_text
    );

    // 2) 客户端回协商应答 + 输入编号（模拟 telnet 客户端:先发 IAC DO ECHO 等协商,再发用户输入）
    client
        .write_all(&[255, 253, 1, 255, 253, 3]) // IAC DO ECHO, IAC DO SUPPRESS-GA
        .await
        .unwrap();
    client.write_all(b"1\r\n").await.unwrap();

    // 3) 收到回显 + 连接成功消息
    let resp = read_until(&mut client, "Connected to".as_bytes()).await;
    let resp_text = String::from_utf8_lossy(&resp);
    assert!(
        resp_text.contains("Connected to"),
        "应确认连接: {}",
        resp_text
    );

    // 4) 串口 → 客户端转发：向 EventBus 发 DataReceived,客户端应收到
    event_bus.publish(SerialEvent::DataReceived {
        port: "COM7".into(),
        data: b"hello-from-device".to_vec(),
    });

    let fwd = read_until(&mut client, b"hello-from-device").await;
    assert!(
        fwd.windows(17).any(|w| w == b"hello-from-device"),
        "客户端应收到串口数据"
    );

    // 5) 客户端 → 串口：回车发 \r\n(telnet 客户端惯例),设备只应收单个 \r——
    //    行尾不归一时设备把 \n 当第二条空命令(用户实测每条命令多一个提示符)
    client.write_all(b"AT\r\n").await.unwrap();
    let recorded = wait_for_write(&write_log, b"AT\r").await;
    assert_eq!(recorded, b"AT\r".to_vec(), "行尾应归一为单 CR");

    // 再发一条反向数据验证连接仍活着
    event_bus.publish(SerialEvent::DataReceived {
        port: "COM7".into(),
        data: b"still-alive".to_vec(),
    });

    let alive = read_until(&mut client, b"still-alive").await;
    assert!(
        alive.windows(11).any(|w| w == b"still-alive"),
        "连接应保持双向转发"
    );

    // 释放端口:串口读任务(spawn_blocking 5ms 轮询)靠 quit 位退出,
    // 不释放会让测试运行时 teardown 永远等不到 blocking 任务结束
    manager.release_all(session).await;
}

/// 无效输入重示提示,连续 3 次无效才告别断开;名称输入仍可用(脚本按名寻址)。
#[tokio::test]
async fn telnet_invalid_selection_reprompts_then_exhausts() {
    let (addr, manager, _bus, _log, _telnet) = boot().await;
    let session = SessionId::next();
    manager
        .acquire("COM7".into(), SerialConfig::default(), session)
        .await
        .unwrap();

    let mut client = TcpStream::connect(&addr).await.unwrap();
    read_until(&mut client, "Select <1~1>".as_bytes()).await;
    // 无效名称:不在已开列表 → 回显输入并重示 Select 提示(不断开)
    client.write_all(b"COM9\r\n").await.unwrap();
    let resp = read_until(&mut client, "Select <1~1>".as_bytes()).await;
    // 超范围编号 + 无效名称 → 凑满 3 次 → 告别断开
    client.write_all(b"9\r\n").await.unwrap();
    read_until(&mut client, "Select <1~1>".as_bytes()).await;
    client.write_all(b"zz\r\n").await.unwrap();
    read_until(&mut client, "No valid selection".as_bytes()).await;
    assert_clean_eof(&mut client).await;
    // 先释放再断言:断言 panic 时 release_all 不执行会让 teardown 挂在
    // blocking 读任务上(进程不退出,表现为测试"卡死")
    manager.release_all(session).await;
    let resp_text = String::from_utf8_lossy(&resp);
    assert!(resp_text.contains("COM9"), "应回显用户输入: {}", resp_text);
}

/// 名称选口回退路径:菜单构建前已开的口按名输入(脚本场景)。
#[tokio::test]
async fn telnet_selects_by_name_fallback() {
    let (addr, manager, _bus, _log, _telnet) = boot().await;
    let session = SessionId::next();
    manager
        .acquire("COM7".into(), SerialConfig::default(), session)
        .await
        .unwrap();

    let mut client = TcpStream::connect(&addr).await.unwrap();
    read_until(&mut client, "Select <1~1>".as_bytes()).await;
    // 裸名(菜单条目可能是别名,但裸名恒可寻址——真实端口名透传)
    client.write_all(b"COM7\r\n").await.unwrap();
    read_until(&mut client, "Connected to".as_bytes()).await;
    manager.release_all(session).await;
}

/// 无已开串口即连入(用户场景):协商+告别消息可见,且关连接不触发 RST。
#[tokio::test]
async fn telnet_no_open_ports_shows_farewell() {
    let (addr, _manager, _bus, _log, _telnet) = boot().await;

    let mut client = TcpStream::connect(&addr).await.unwrap();
    // 真实客户端时序:收到握手 → 立刻回 IAC 协商应答 → 再看服务器说什么。
    // 修复前:服务端写完告别即关,在途协商应答触发 RST,客户端缓冲(含告别)
    // 被丢弃——表现为连上即退、什么都不显示。
    let first = read_until(&mut client, "No open serial ports".as_bytes()).await;
    let text = String::from_utf8_lossy(&first);
    assert!(
        text.contains("No open serial ports"),
        "应含告别消息: {}",
        text
    );
    assert!(
        first.starts_with(&[255, 251, 1, 255, 251, 3]),
        "首字节应为 IAC WILL ECHO/SGA 协商"
    );
    client
        .write_all(&[255, 253, 1, 255, 253, 3]) // IAC DO ECHO / DO SGA(协商应答在途)
        .await
        .unwrap();
    assert_clean_eof(&mut client).await;
}

/// 读至连接结束,断言是干净 EOF(Ok(0)) 而非 ConnectionReset(RST)。
async fn assert_clean_eof(client: &mut TcpStream) {
    let mut buf = [0u8; 64];
    let drained = async {
        loop {
            match client.read(&mut buf).await {
                Ok(0) => return Ok(()),
                Ok(_) => continue,
                Err(e) => return Err(e),
            }
        }
    };
    match timeout(Duration::from_secs(3), drained).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => panic!("连接应以 FIN 收尾(EOF),实得错误(疑似 RST): {}", e),
        Err(_) => panic!("3s 内连接未关闭"),
    }
}

/// 轮询等待端口写入日志出现 expected 前缀,返回日志快照(写路径为异步,需等落盘)。
async fn wait_for_write(log: &WriteLog, expected: &[u8]) -> Vec<u8> {
    let waited = async {
        loop {
            let snap = log.lock().unwrap().clone();
            if snap.len() >= expected.len() {
                return snap;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    match timeout(Duration::from_secs(2), waited).await {
        Ok(snap) => snap,
        Err(_) => log.lock().unwrap().clone(),
    }
}

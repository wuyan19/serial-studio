//! SSH 文件传输集成测试(中继/WS 路径):依赖 ss-server 组装根与 router,
//! 随 AppState 基建留在 server 侧;SFTP 协议单测留在 ss-device files.rs 内嵌。
//! execute/release_owner 经 ss_device 重导出寻址;签名收 (ssh, devices) 两组件。

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ss_server::protocol::ServerMsg;
use ss_server::ssh::files::{execute, release_owner, FileOperation, FileResult};

    fn isolated_state() -> ss_server::AppState {
        let event_bus = Arc::new(ss_core::EventBus::new(64));
        let manager = Arc::new(ss_core::SerialManager::new(
            event_bus.clone(),
            Arc::new(ss_core::RealPortOpener),
        ));
        let (meta, _) = tokio::sync::broadcast::channel(16);
        let (scripts, _) = tokio::sync::broadcast::channel(16);
        let devices = Arc::new(ss_server::device::DeviceClientManager::empty(
            meta.clone(),
            "files-test",
        ));
        let ssh = Arc::new(ss_server::ssh::SshManager::empty());
        ss_server::AppState {
            access: Default::default(),
            port_groups: Arc::new(ss_server::port_groups::PortGroupsStore::memory("files-test")),
            manager,
            event_bus,
            meta_bus: Arc::new(meta.clone()),
            script_bus: Arc::new(scripts),
            enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
            closers: Default::default(),
            script_runs: Default::default(),
            addresses: Arc::new(ss_server::address::AddressResolver::new(
                devices.clone(),
                ssh.clone(),
                meta,
                "files-test".into(),
            )),
            devices,
            ssh,
            instance_id: "files-test".into(),
            mcp_extensions: Vec::new(),
        }
    }
    async fn relay_fixture(
        state: &ss_server::AppState,
        delay: Duration,
    ) -> (
        tokio::task::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
        Arc<tokio::sync::Notify>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.devices.update_registry(&[ss_core::RemoteDevice {
            secure_port: None,
            verify_http: false,
            id: "hub".into(),
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            nickname: None,
        }]);
        let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::new(tokio::sync::Notify::new());
        let count = closed.clone();
        let notify = seen.clone();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                    let ss_server::protocol::ClientMsg::SshFiles {
                        request_id,
                        host_id,
                        operation,
                    } = serde_json::from_str(&text).unwrap()
                    else {
                        panic!("wrong request")
                    };
                    assert_eq!(host_id, "nested::ssh-host");
                    let result = match operation {
                        FileOperation::Open => {
                            notify.notify_one();
                            tokio::time::sleep(delay).await;
                            FileResult::Opened {
                                session: "remote-token".into(),
                                path: "/home/test".into(),
                            }
                        }
                        FileOperation::List { session, path } => {
                            assert_eq!(session, "remote-token");
                            FileResult::Listed {
                                path,
                                entries: vec![],
                                protocol: None,
                            }
                        }
                        _ => panic!("unexpected operation"),
                    };
                    let response = ServerMsg::SshFilesResult {
                        request_id,
                        result: Some(result),
                        error: None,
                    };
                    if socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            serde_json::to_string(&response).unwrap(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                } else if message.is_close() {
                    break;
                }
            }
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        (task, closed, seen)
    }
    #[tokio::test]
    async fn relay_tokens_preserve_routes_and_enforce_owner_then_release() {
        let state = isolated_state();
        let (task, closed, _) = relay_fixture(&state, Duration::ZERO).await;
        let host = "hub::nested::ssh-host";
        let opened = execute(&state.ssh, &state.devices, "owner-a", host, FileOperation::Open)
            .await
            .unwrap();
        let FileResult::Opened { session, .. } = opened else {
            panic!("not opened")
        };
        assert_ne!(session, "remote-token");
        let list = FileOperation::List {
            session,
            path: "/home/test".into(),
        };
        assert!(execute(&state.ssh, &state.devices, "owner-b", host, list.clone())
            .await
            .is_err());
        assert!(execute(&state.ssh, &state.devices, "owner-a", "hub::other-host", list.clone())
            .await
            .is_err());
        assert!(matches!(
            execute(&state.ssh, &state.devices, "owner-a", host, list.clone())
                .await
                .unwrap(),
            FileResult::Listed { .. }
        ));
        release_owner(&state.ssh, "owner-a").await;
        assert!(execute(&state.ssh, &state.devices, "owner-a", host, list).await.is_err());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(state.ssh.files.sessions.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn ws_disconnect_cleans_open_that_finishes_late() {
        let state = isolated_state();
        let (remote, closed, seen) = relay_fixture(&state, Duration::from_millis(150)).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = ss_server::create_router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (mut frontend, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        frontend
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::to_string(&ss_server::protocol::ClientMsg::SshFiles {
                    request_id: "open-late".into(),
                    host_id: "hub::nested::ssh-host".into(),
                    operation: FileOperation::Open,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), seen.notified())
            .await
            .unwrap();
        frontend.close(None).await.unwrap();
        drop(frontend);
        tokio::time::timeout(Duration::from_secs(3), remote)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(state.ssh.files.sessions.lock().unwrap().is_empty());
        assert_eq!(state.ssh.files.slots.available_permits(), 32);
        server.abort();
    }
    // Windows 隔离:tokio 1.53/mio 1.2.2 下连死端口(内核 3ms 即 RST)的
    // TcpStream::connect future 永不完成——裸 tokio 最小用例可复现,与本仓库
    // 代码无关。本测试"立即拒绝快速返回"的前提在 Windows 不成立(有
    // connect_files 的 CONNECT_TIMEOUT 兜底,不再挂死,只是快不起来)。
    #[cfg_attr(windows, ignore = "tokio/mio on Windows: dead-port connect never completes")]
    #[tokio::test]
    async fn unreachable_relay_returns_without_waiting_for_session_timeout() {
        let state = isolated_state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        state.devices.update_registry(&[ss_core::RemoteDevice {
            secure_port: None,
            verify_http: false,
            id: "hub".into(),
            host: "127.0.0.1".into(),
            port,
            nickname: None,
        }]);
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            execute(&state.ssh, &state.devices, "test", "hub::missing", FileOperation::Open),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(state.ssh.files.slots.available_permits(), 32);
    }

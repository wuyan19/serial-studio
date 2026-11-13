//! Network policy tests with real listeners and an in-memory port opener.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use ss_core::{
    EventBus, PortIo, PortOpener, SerialConfig, SerialError, SerialEvent, SerialManager, SessionId,
};
use ss_server::access::{AccessConfig, AccessScope, AccessTarget};
use ss_server::address::AddressResolver;
use ss_server::device::DeviceClientManager;
use ss_server::port_groups::PortGroupsStore;
use ss_server::ssh::{SshAuthRecord, SshEndpointRecord, SshHostRecord, SshManager};
use ss_server::{create_router, AppState};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const PROTECTED: &str = "protected-ssh::shell";
const PROTECTED_ALIAS: &str = "private-ssh-alias";
const PROTECTED_SERIAL: &str = "COM63";
const PROTECTED_SERIAL_ALIAS: &str = "private-serial-alias";
const PUBLIC: &str = "public-ssh::shell";
const WAIT: Duration = Duration::from_secs(3);

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
struct TestPort(Arc<AtomicBool>);

impl io::Read for TestPort {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        let kind = if self.0.load(Ordering::Relaxed) {
            io::ErrorKind::TimedOut
        } else {
            io::ErrorKind::BrokenPipe
        };
        Err(kind.into())
    }
}

impl io::Write for TestPort {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl PortIo for TestPort {
    fn try_clone(&self) -> io::Result<Box<dyn PortIo>> {
        Ok(Box::new(self.clone()))
    }
}

impl PortOpener for TestPort {
    fn open(&self, _: &str, _: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
        Ok(Box::new(self.clone()))
    }
}

struct Fixture {
    alive: Arc<AtomicBool>,
    state: AppState,
    server: tokio::task::JoinHandle<()>,
    addr: SocketAddr,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        self.server.abort();
    }
}

impl Fixture {
    async fn start() -> Self {
        let alive = Arc::new(AtomicBool::new(true));
        let event_bus = Arc::new(EventBus::new(64));
        let (meta, _) = tokio::sync::broadcast::channel(16);
        let (scripts, _) = tokio::sync::broadcast::channel(16);
        let devices = Arc::new(DeviceClientManager::empty(meta.clone(), "access-fixture"));
        let ssh = Arc::new(SshManager::empty());
        ssh.update_registry(vec![
            ssh_host("protected-ssh", Some(PROTECTED_ALIAS)),
            ssh_host("public-ssh", None),
        ]);
        let addresses = Arc::new(AddressResolver::new(
            devices.clone(),
            ssh.clone(),
            meta.clone(),
            "access-fixture".into(),
        ));
        let resolve = addresses.key_resolver_fn();
        let manager = Arc::new(SerialManager::with_key_resolver(
            event_bus.clone(),
            Arc::new(TestPort(alive.clone())),
            Arc::new(move |port| {
                if port == PROTECTED_SERIAL_ALIAS {
                    PROTECTED_SERIAL.into()
                } else {
                    resolve(port)
                }
            }),
        ));
        let state = AppState {
            access: Default::default(),
            port_groups: Arc::new(PortGroupsStore::memory("access-fixture")),
            manager,
            event_bus,
            meta_bus: Arc::new(meta),
            script_bus: Arc::new(scripts),
            enable_scripting: Default::default(),
            script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
            closers: Default::default(),
            script_runs: Default::default(),
            devices,
            ssh,
            addresses,
            instance_id: "access-fixture".into(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router =
            create_router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            alive,
            state,
            server,
            addr,
        }
    }

    fn select_policy(&self) -> AccessConfig {
        AccessConfig {
            enabled: true,
            scope: AccessScope::Selected,
            targets: vec![
                AccessTarget::Ssh {
                    id: "protected-ssh".into(),
                },
                AccessTarget::Serial {
                    id: PROTECTED_SERIAL.into(),
                },
            ],
            tls_cert: "fixture-cert.pem".into(),
            tls_key: "fixture-key.pem".into(),
            ..AccessConfig::default()
        }
    }

    async fn ws(&self) -> Ws {
        tokio_tungstenite::connect_async(format!("ws://{}/ws", self.addr))
            .await
            .unwrap()
            .0
    }

    async fn http(&self, method: &str, path: &str, headers: &str, body: &str) -> (String, String) {
        timeout(WAIT, async {
            let mut stream = TcpStream::connect(self.addr).await.unwrap();
            let request = format!(
                "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{body}",
                self.addr, body.len(),
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).await.unwrap();
            let (head, body) = reply.split_once("\r\n\r\n").unwrap();
            (head.to_owned(), body.to_owned())
        }).await.unwrap()
    }

    async fn mcp(&self, name: &str, arguments: Value) -> (String, Value) {
        let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}});
        let (head, body) = self.http("POST", "/mcp", "", &request.to_string()).await;
        (head, serde_json::from_str(&body).unwrap_or(Value::Null))
    }
}

fn ssh_host(id: &str, alias: Option<&str>) -> SshHostRecord {
    SshHostRecord {
        id: id.into(),
        nickname: None,
        host: "127.0.0.1".into(),
        port: 22,
        username: "fixture".into(),
        auth: SshAuthRecord::Password {
            password: "test-ssh-secret".into(),
        },
        endpoints: vec![SshEndpointRecord {
            name: "shell".into(),
            r#type: "shell".into(),
            alias: alias.map(str::to_owned),
        }],
    }
}

async fn receive(ws: &mut Ws, kind: &str) -> Value {
    timeout(WAIT, async {
        while let Some(frame) = ws.next().await {
            if let Message::Text(text) = frame.unwrap() {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind {
                    return value;
                }
            }
        }
        panic!("connection closed before {kind}");
    })
    .await
    .unwrap()
}

async fn open(ws: &mut Ws, port: &str, req: u64) {
    let msg = json!({"action":"open","port":port,"req":req,"config":SerialConfig::default()});
    ws.send(Message::Text(msg.to_string())).await.unwrap();
}

#[tokio::test]
async fn plain_ws_rest_and_mcp_expose_only_unprotected_connections() {
    let fixture = Fixture::start().await;
    let mut legacy = fixture.ws().await;
    let initial = receive(&mut legacy, "ports").await.to_string();
    assert!(initial.contains(PROTECTED) && initial.contains(PUBLIC));
    open(&mut legacy, PROTECTED_ALIAS, 1).await;
    assert_eq!(receive(&mut legacy, "acquired").await["req"], 1);

    fixture
        .state
        .access
        .configure(fixture.select_policy())
        .unwrap();
    timeout(WAIT, async {
        while let Some(Ok(msg)) = legacy.next().await {
            if msg.is_close() {
                break;
            }
        }
    })
    .await
    .expect("existing legacy session should be invalidated");

    let mut legacy = fixture.ws().await;
    let ports = receive(&mut legacy, "ports").await.to_string();
    assert!(!ports.contains(PROTECTED) && ports.contains(PUBLIC));
    for (i, port) in [
        PROTECTED,
        PROTECTED_ALIAS,
        PROTECTED_SERIAL,
        PROTECTED_SERIAL_ALIAS,
    ]
    .into_iter()
    .enumerate()
    {
        open(&mut legacy, port, i as u64 + 2).await;
        let error = receive(&mut legacy, "error").await;
        assert_eq!(error["port"], port);
        assert!(error["message"].as_str().unwrap().contains("需要授权"));
    }
    open(&mut legacy, PUBLIC, 6).await;
    assert_eq!(receive(&mut legacy, "acquired").await["req"], 6);

    fixture.state.event_bus.publish(SerialEvent::DataReceived {
        port: PROTECTED.into(),
        data: b"private".into(),
    });
    fixture.state.event_bus.publish(SerialEvent::DataReceived {
        port: PUBLIC.into(),
        data: b"public".into(),
    });
    timeout(WAIT, async {
        loop {
            if let Message::Binary(bytes) = legacy.next().await.unwrap().unwrap() {
                assert!(bytes.ends_with(b"public"), "protected event was forwarded");
                break;
            }
        }
    })
    .await
    .unwrap();

    let (status, ports) = fixture.http("GET", "/api/ports", "", "").await;
    assert!(status.starts_with("HTTP/1.1 200"));
    assert!(!ports.contains(PROTECTED) && ports.contains(PUBLIC));
    let (_, list) = fixture.mcp("serial_list", json!({})).await;
    assert!(!list.to_string().contains(PROTECTED));
    assert!(list.to_string().contains(PUBLIC));
    for port in [
        PROTECTED,
        PROTECTED_ALIAS,
        PROTECTED_SERIAL,
        PROTECTED_SERIAL_ALIAS,
    ] {
        let (_, response) = fixture
            .mcp("serial_send", json!({"port":port,"data":"probe"}))
            .await;
        assert_eq!(response["result"]["isError"], true);
        assert!(response.to_string().contains("不允许通过 MCP 访问"));
    }
    let (_, response) = fixture
        .mcp("serial_send", json!({"port":PUBLIC,"data":"probe"}))
        .await;
    assert_ne!(response["result"]["isError"], true);
    assert!(response["result"]["content"].is_array());

    fixture
        .state
        .access
        .configure(AccessConfig {
            scope: AccessScope::All,
            ..fixture.select_policy()
        })
        .unwrap();
    let (status, _) = fixture.mcp("serial_list", json!({})).await;
    assert!(status.starts_with("HTTP/1.1 403"));
}

#[tokio::test]
async fn plaintext_cannot_exchange_codes_or_use_existing_tokens() {
    let fixture = Fixture::start().await;
    fixture
        .state
        .access
        .configure(fixture.select_policy())
        .unwrap();
    let code = fixture.state.access.status().code.unwrap();
    let body = json!({"code":code}).to_string();
    let forged = "X-Forwarded-Proto: https\r\nForwarded: proto=https\r\n";
    let (head, _) = fixture
        .http("POST", "/api/access/verify", forged, &body)
        .await;
    assert!(head.starts_with("HTTP/1.1 403"));
    assert!(!head.to_lowercase().contains("set-cookie"));
    let token = fixture
        .state
        .access
        .verify(&code, fixture.addr.ip(), true)
        .expect("plaintext cannot consume code");

    let mut req = format!("ws://{}/ws?access_pair=1", fixture.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("x-forwarded-proto", "https".parse().unwrap());
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    assert!(
        matches!(err, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
    );

    let cookie = format!("Cookie: __Host-serial_studio_access={token}\r\n");
    let (_, body) = fixture.http("GET", "/api/ports", &cookie, "").await;
    assert!(!body.contains(PROTECTED) && body.contains(PUBLIC));
    let mut req = format!("ws://{}/ws", fixture.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    assert!(
        matches!(err, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 401)
    );
}

#[tokio::test]
async fn opted_in_http_verifies_browser_and_desktop_without_exposing_protected_ports_to_legacy() {
    let fixture = Fixture::start().await;
    fixture
        .state
        .access
        .configure(AccessConfig {
            allow_http: true,
            tls_cert: String::new(),
            tls_key: String::new(),
            ..fixture.select_policy()
        })
        .unwrap();

    let mut legacy = fixture.ws().await;
    let ports = receive(&mut legacy, "ports").await.to_string();
    assert!(!ports.contains(PROTECTED) && ports.contains(PUBLIC));

    let code = fixture.state.access.status().code.unwrap();
    let body = json!({"code": code}).to_string();
    let (head, _) = fixture
        .http(
            "POST",
            "/api/access/verify",
            "Origin: http://evil.example\r\n",
            &body,
        )
        .await;
    assert!(head.starts_with("HTTP/1.1 403"));
    let origin = format!("Origin: http://{}\r\n", fixture.addr);
    let (head, _) = fixture
        .http("POST", "/api/access/verify", &origin, &body)
        .await;
    assert!(head.starts_with("HTTP/1.1 200"));
    let cookie = head
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && !cookie.contains("; Secure")
    );
    let cookie = format!("Cookie: {}\r\n", cookie.split(';').next().unwrap());
    let (_, ports) = fixture.http("GET", "/api/ports", &cookie, "").await;
    assert!(ports.contains(PROTECTED) && ports.contains(PUBLIC));

    let mut req = format!("ws://{}/ws", fixture.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", "http://evil.example".parse().unwrap());
    req.headers_mut().insert(
        "cookie",
        cookie
            .trim()
            .strip_prefix("Cookie: ")
            .unwrap()
            .parse()
            .unwrap(),
    );
    assert!(
        matches!(tokio_tungstenite::connect_async(req).await.unwrap_err(),
        tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
    );
    let (head, _) = fixture
        .http(
            "POST",
            "/api/access/logout",
            &format!("{origin}{cookie}"),
            "",
        )
        .await;
    assert!(head.starts_with("HTTP/1.1 204"));
    let (_, ports) = fixture.http("GET", "/api/ports", &cookie, "").await;
    assert!(!ports.contains(PROTECTED));

    let url = format!("ws://{}/ws?access_pair=1", fixture.addr);
    assert!(
        matches!(tokio_tungstenite::connect_async(&url).await.unwrap_err(),
        tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 400)
    );
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert(
        "sec-websocket-protocol",
        "serial-studio.access.v1".parse().unwrap(),
    );
    let (mut pair, response) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(
        response.headers()["sec-websocket-protocol"],
        "serial-studio.access.v1"
    );
    let code = fixture.state.access.status().code.unwrap();
    pair.send(Message::Text(json!({"code": code}).to_string()))
        .await
        .unwrap();
    let reply = timeout(WAIT, pair.next()).await.unwrap().unwrap().unwrap();
    let reply: serde_json::Value = serde_json::from_str(reply.to_text().unwrap()).unwrap();
    let token = reply["token"].as_str().unwrap();
    assert!(!fixture.state.access.validate(token, false, true));
    let mut req = format!("ws://{}/ws", fixture.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let mut verified = tokio_tungstenite::connect_async(req).await.unwrap().0;
    assert!(receive(&mut verified, "ports")
        .await
        .to_string()
        .contains(PROTECTED));
    open(&mut verified, PROTECTED, 1).await;
    assert_eq!(receive(&mut verified, "acquired").await["req"], 1);
}

async fn read_telnet(stream: &mut TcpStream, pattern: &str) -> String {
    timeout(WAIT, async {
        let mut bytes = Vec::new();
        let mut buffer = [0; 256];
        while !String::from_utf8_lossy(&bytes).contains(pattern) {
            let count = stream.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "connection closed before {pattern}");
            bytes.extend_from_slice(&buffer[..count]);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn telnet_hides_protected_open_ports_and_rejects_direct_alias_selection() {
    let fixture = Fixture::start().await;
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);
    let listener = ss_server::telnet::start_telnet(addr.to_string(), fixture.state.clone())
        .await
        .unwrap();
    let session = SessionId::next();
    for port in [PROTECTED, PROTECTED_SERIAL, PUBLIC] {
        fixture
            .state
            .manager
            .acquire(port.into(), SerialConfig::default(), session)
            .await
            .unwrap();
    }
    fixture
        .state
        .access
        .configure(fixture.select_policy())
        .unwrap();
    let mut telnet = TcpStream::connect(addr).await.unwrap();
    let menu = read_telnet(&mut telnet, "Select <1~1>").await;
    assert!(menu.contains("Open Port List"));
    assert!(!menu.contains(PROTECTED_ALIAS) && !menu.contains(PROTECTED_SERIAL));
    for port in [PROTECTED_ALIAS, PROTECTED_SERIAL_ALIAS] {
        telnet
            .write_all(format!("{port}\r\n").as_bytes())
            .await
            .unwrap();
        let response = read_telnet(&mut telnet, "Select <1~1>").await;
        assert!(!response.contains("Connected to"));
    }
    telnet.write_all(b"1\r\n").await.unwrap();
    read_telnet(&mut telnet, "Connected to").await;

    fixture
        .state
        .access
        .configure(AccessConfig {
            scope: AccessScope::All,
            ..fixture.select_policy()
        })
        .unwrap();
    let mut remaining = Vec::new();
    timeout(WAIT, telnet.read_to_end(&mut remaining))
        .await
        .unwrap()
        .unwrap();
    let mut new_client = TcpStream::connect(addr).await.unwrap();
    let mut first = [0];
    assert_eq!(
        timeout(WAIT, new_client.read(&mut first))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    listener.stop().await;
    fixture.state.manager.release_all(session).await;
}

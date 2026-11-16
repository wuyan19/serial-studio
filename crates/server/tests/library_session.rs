//! Library synchronization uses isolated configuration and never opens a device.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn receive(ws: &mut Ws, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(Ok(Message::Text(raw))) = ws.next().await {
            let value: Value = serde_json::from_str(&raw).unwrap();
            if value["type"] == kind {
                return value;
            }
        }
        panic!("connection closed before expected response");
    })
    .await
    .unwrap()
}
async fn send(ws: &mut Ws, message: Value) {
    ws.send(Message::Text(message.to_string())).await.unwrap();
}

#[tokio::test]
async fn shared_library_reads_legacy_files_and_notifies_other_clients() {
    let dir = std::env::temp_dir().join(format!("ss-library-session-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var(ss_server::config::CONFIG_DIR_ENV, &dir);
    std::fs::write(dir.join("macros.json"), r#"{"legacy":{"steps":[]}}"#).unwrap();
    std::fs::write(
        dir.join("scripts.json"),
        r#"{"legacy-script":{"code":"log('test')"}}"#,
    )
    .unwrap();
    let state = ss_server::create_state();
    let manager = state.manager.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, ss_server::create_router(state))
            .await
            .unwrap();
    });
    let mut a = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    let mut b = tokio_tungstenite::connect_async(&url).await.unwrap().0;
    receive(&mut a, "devices").await;
    receive(&mut b, "devices").await;
    for (kind, key) in [("macros", "legacy"), ("scripts", "legacy-script")] {
        send(
            &mut a,
            json!({"action":"library_get","kind":kind,"request_id":"read"}),
        )
        .await;
        let value = receive(&mut a, "library_result").await;
        assert_eq!(value["request_id"], "read");
        assert!(value["items"].get(key).is_some());
        assert!(value["server_id"].as_str().is_some());
    }
    send(&mut a, json!({"action":"library_patch","kind":"macros","request_id":"save","changes":{"web":{"before":null,"after":{"steps":[]}}}})).await;
    let saved = receive(&mut a, "library_result").await;
    assert_eq!(saved["request_id"], "save");
    assert!(saved["items"].get("legacy").is_some());
    assert!(saved["items"].get("web").is_some());
    receive(&mut b, "scripts_changed").await;
    send(
        &mut b,
        json!({"action":"library_get","kind":"macros","request_id":"other"}),
    )
    .await;
    assert_eq!(
        receive(&mut b, "library_result").await["items"],
        saved["items"]
    );
    send(&mut b, json!({"action":"library_patch","kind":"macros","request_id":"conflict","changes":{"web":{"before":null,"after":{"steps":[]}}}})).await;
    let conflict = receive(&mut b, "library_result").await;
    assert_eq!(conflict["request_id"], "conflict");
    assert!(conflict["error"].is_string());
    assert!(conflict["items"].is_null());
    assert_eq!(manager.holder_count("COM1").await, None);
    a.close(None).await.unwrap();
    b.close(None).await.unwrap();
    server.abort();
    std::env::remove_var(ss_server::config::CONFIG_DIR_ENV);
    std::fs::remove_dir_all(dir).unwrap();
}

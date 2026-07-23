//! Serial Studio 服务端库：axum 路由 + 共享状态。
//!
//! 抽成 lib 是为了让 Tauri app（GUI 模式）和独立 ss-server bin（headless 模式）
//! 共用同一套路由——方案 B 的核心：一份后端，两种宿主。

mod mcp;
pub mod telnet;
mod ws;

use axum::{extract::State, routing::{get, post}, Json, Router};
use ss_core::{EventBus, Macro, MacroStep, SerialManager};
use std::collections::HashMap;
use std::sync::Arc;

/// 应用共享状态：GUI 模式和 headless 模式共用。
#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<SerialManager>,
    pub event_bus: Arc<EventBus>,
    pub macros: Arc<HashMap<String, Macro>>,
}

/// 构造默认状态（256 容量的 EventBus + 内置示例宏）。
pub fn create_state() -> AppState {
    let event_bus = Arc::new(EventBus::new(256));
    let manager = Arc::new(SerialManager::new(event_bus.clone()));
    let macros = Arc::new(default_macros());
    AppState { manager, event_bus, macros }
}

/// 内置示例宏（后续可改为从配置文件加载）。
fn default_macros() -> HashMap<String, Macro> {
    let mut m = HashMap::new();
    m.insert(
        "at_test".into(),
        Macro {
            description: Some("AT 测试：发送 AT，等待 OK".into()),
            steps: vec![
                MacroStep::Send { data: "AT".into(), format: "text".into(), auto_newline: true },
                MacroStep::Expect { pattern: "OK".into(), timeout_ms: 3000 },
            ],
        },
    );
    m.insert(
        "clear_buf".into(),
        Macro {
            description: Some("清空接收缓冲区".into()),
            steps: vec![MacroStep::Clear],
        },
    );
    m
}

/// 构造 axum 路由。GUI/headless 共用。
pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/api/ports", get(list_ports))
        .route("/mcp", post(mcp::mcp_handler))
        .with_state(state)
}

/// REST: 列出端口（WS 客户端也可通过 `{"action":"list"}` 获取）。
async fn list_ports(State(state): State<AppState>) -> Json<Vec<ss_core::PortInfo>> {
    Json(state.manager.list_ports().await)
}

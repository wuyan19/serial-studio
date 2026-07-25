//! Serial Studio 服务端库：axum 路由 + 共享状态。
//!
//! 抽成 lib 是为了让 Tauri app（GUI 模式）和独立 ss-server bin（headless 模式）
//! 共用同一套路由——方案 B 的核心：一份后端，两种宿主。

mod mcp;
pub mod macros_store;
pub mod settings;
pub mod supervisor;
pub mod telnet;
mod ws;

use axum::{extract::State, routing::{get, post}, Json, Router};
use ss_core::{EventBus, RealPortOpener, SerialManager};
use std::sync::Arc;

/// 应用共享状态：GUI 模式和 headless 模式共用。
#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<SerialManager>,
    pub event_bus: Arc<EventBus>,
}

/// 构造默认状态。宏定义存前端本地，服务端无状态（只执行 run_macro）。
pub fn create_state() -> AppState {
    let event_bus = Arc::new(EventBus::new(1024));
    let manager = Arc::new(SerialManager::new(event_bus.clone(), Arc::new(RealPortOpener)));
    AppState { manager, event_bus }
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

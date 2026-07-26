//! Serial Studio 服务端库：axum 路由 + 共享状态。
//!
//! 抽成 lib 是为了让 Tauri app（GUI 模式）和独立 ss-server bin（headless 模式）
//! 共用同一套路由——方案 B 的核心：一份后端，两种宿主。

mod mcp;
pub mod macros_store;
pub mod port_meta_store;
pub mod settings;
pub mod supervisor;
pub mod telnet;
mod ws;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{extract::State, routing::{get, post}, Json, Router};
use rust_embed::RustEmbed;
use ss_core::{EventBus, RealPortOpener, SerialManager};
use std::sync::Arc;
use tokio::sync::broadcast;

/// 应用共享状态：GUI 模式和 headless 模式共用。
#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<SerialManager>,
    pub event_bus: Arc<EventBus>,
    /// 端口元数据（别名等）变更广播。set_alias 后通知所有 WS/IPC 客户端刷新列表，
    /// 否则别的客户端要等下一个串口事件才看到新别名。与串口 EventBus 分离——
    /// 这是用户配置变更，不是串口硬件事件，不进 core 的 SerialEvent。
    pub meta_bus: Arc<broadcast::Sender<()>>,
}

/// 构造默认状态。宏定义存前端本地，服务端无状态（只执行 run_macro）。
pub fn create_state() -> AppState {
    let event_bus = Arc::new(EventBus::new(1024));
    let manager = Arc::new(SerialManager::new(event_bus.clone(), Arc::new(RealPortOpener)));
    let (meta_tx, _) = broadcast::channel(16);
    AppState { manager, event_bus, meta_bus: Arc::new(meta_tx) }
}

/// 列出端口并注入 ports.json 中的别名元数据。
/// 三条 list 路径（REST / WS / Tauri）共用：别名由端口所在机器的后端注入，
/// 远程模式自动取远程别名。core 的 manager.list_ports 只出运行时事实（alias=None），
/// 此处在 server 层覆盖——core 不接触持久化。
pub async fn list_ports_with_meta(state: &AppState) -> Vec<ss_core::PortInfo> {
    let meta = port_meta_store::load();
    let mut ports = state.manager.list_ports().await;
    for p in &mut ports {
        if let Some(m) = meta.get(&p.name) {
            p.alias = m.alias.clone();
        }
    }
    ports
}

/// 设置端口别名并广播元数据变更：写 ports.json 后向 meta_bus 发一次通知，
/// 让所有已连 WS 客户端和本地 Tauri UI 刷新列表。alias 写入的唯一入口（Tauri 命令 / WS action 共用）。
pub fn set_alias_and_notify(state: &AppState, port: &str, alias: Option<String>) -> Result<(), String> {
    port_meta_store::set_alias(port, alias)?;
    let _ = state.meta_bus.send(());
    Ok(())
}


/// 内嵌前端（ui/dist，编译期打入）。ss-server 单文件即"网关 + 网页"：
/// 浏览器开 http://host:port/ 直接出界面，自动连本机 /ws。
#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct WebAsset;

/// 静态资源 + SPA 回退：命中文件就返回，否则回退 index.html。
async fn serve_web(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    if !path.is_empty() {
        if let Some(file) = WebAsset::get(path) {
            return asset_response(path, file);
        }
    }
    match WebAsset::get("index.html") {
        Some(file) => asset_response("index.html", file),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn asset_response(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let ct = mime_guess::from_path(path).first_or_octet_stream().to_string();
    let mut res = Response::new(Body::from(file.data.into_owned()));
    res.headers_mut().insert(header::CONTENT_TYPE, ct.parse().unwrap());
    res
}

/// 构造 axum 路由。GUI/headless 共用。
pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/api/ports", get(list_ports))
        .route("/mcp", post(mcp::mcp_handler))
        .fallback(serve_web)
        .with_state(state)
}

/// REST: 列出端口（带别名）。WS 客户端也可通过 `{"action":"list"}` 获取。
async fn list_ports(State(state): State<AppState>) -> Json<Vec<ss_core::PortInfo>> {
    Json(list_ports_with_meta(&state).await)
}

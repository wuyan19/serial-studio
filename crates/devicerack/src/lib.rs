//! devicerack：AI 设备调试的拓扑管理平台。
//!
//! 组合形态（设计文档 §2 P0）：复用 ss-server 的共享运行时与基础路由
//! （/ws、/api/ports、/mcp），叠加拓扑域（REST + SSE + MCP 工具集），
//! 自嵌 ui-topo 控制台 SPA。不依赖 tauri-app。

pub mod api;
pub mod audit;
pub mod device;
pub mod events;
pub mod lease;
pub mod mcp_topo;
pub mod session;
pub mod test_support;
pub mod topology;

pub use api::TopoState;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use rust_embed::RustEmbed;

/// 内嵌前端（ui-topo/dist，编译期打入；build.rs 保证目录存在——未构建时为占位页）。
#[derive(RustEmbed)]
#[folder = "../../ui-topo/dist"]
struct WebAsset;

/// 静态资源 + SPA 回退（同 ss-server 模式）。
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
    let ct = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    let mut res = Response::new(Body::from(file.data.into_owned()));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, ct.parse().unwrap());
    res
}

/// 组装完整路由：ss-server 基础路由（/mcp 已注入拓扑+租约工具扩展与写闸）
/// + 拓扑/租约 REST + SSE + 自嵌 SPA fallback。
pub fn create_router(state: TopoState) -> Router {
    let mut base = state.base.clone();
    base.mcp_extensions = vec![std::sync::Arc::new(mcp_topo::TopoTools {
        bus: (*state.topo_bus).clone(),
        leases: std::sync::Arc::clone(&state.leases),
        sessions: std::sync::Arc::clone(&state.sessions),
    })];
    ss_server::base_router(base)
        .merge(api::routes().with_state(state))
        .fallback(serve_web)
}

//! 拓扑 REST 接口（/api/topologies CRUD）与组装状态 TopoState。
//!
//! 通知走独立 SSE 通道（/api/events，见 events.rs），不改 ss-server 的 WS 协议——
//! 这是设计文档 §6 的实现修正：命令面 REST、通知面 SSE，拓扑数据变更频率低，
//! 无需把 ui-topo 绑进串口终端的 WS 词典。

use crate::topology::{self, MemberInput, MemberKind, Topology};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use ss_server::AppState;
use std::sync::Arc;
use tokio::sync::broadcast;

/// topo-hub 组装状态：ss-server 共享运行时 + 拓扑域变更广播。
/// bus 是空通道语义（收发双方只关心"变了"，不传载荷）。
#[derive(Clone)]
pub struct TopoState {
    pub base: AppState,
    pub topo_bus: Arc<broadcast::Sender<()>>,
}

/// 创建/更新请求体。POST 要求 name（description/members 缺省为空）；
/// PUT 全部可选（提供才更新）。
#[derive(Deserialize)]
pub struct TopoBody {
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub members: Option<Vec<MemberInput>>,
}

/// 成员的展示视图（detail 页/工具输出共用）：键 + 定型 + 设备标签与在线态。
#[derive(Serialize)]
pub struct MemberView {
    pub kind: MemberKind,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 仅远端设备有值（hub 知道连接状态；SSH 懒连接、本机恒在）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

/// 拓扑详情（GET /api/topologies/:id）。成员视图字段名避开 Topology.members
/// （serde(flatten) 下同名字段序列化顺序未定义，不赌）。
#[derive(Serialize)]
pub struct TopologyDetail {
    #[serde(flatten)]
    pub topo: Topology,
    pub member_views: Vec<MemberView>,
}

pub fn routes() -> Router<TopoState> {
    Router::new()
        .route("/api/topologies", get(list).post(create))
        .route("/api/topologies/:id", get(detail).put(update).delete(remove))
        .route("/api/events", get(crate::events::sse))
}

type ApiError = (StatusCode, Json<Value>);

fn bad(message: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message.into() })))
}

fn not_found(id: &str) -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({ "error": format!("拓扑不存在: {id}") })))
}

async fn list(State(_state): State<TopoState>) -> Json<Vec<Topology>> {
    Json(topology::load())
}

async fn create(
    State(state): State<TopoState>,
    Json(body): Json<TopoBody>,
) -> Result<(StatusCode, Json<Topology>), ApiError> {
    let name = body.name.ok_or_else(|| bad("name 不能为空"))?;
    let topo = topology::create(
        &name,
        body.description.as_deref().unwrap_or(""),
        body.members.as_deref().unwrap_or(&[]),
        &state.base,
    )
    .map_err(bad)?;
    let _ = state.topo_bus.send(());
    Ok((StatusCode::CREATED, Json(topo)))
}

async fn detail(
    State(state): State<TopoState>,
    Path(id): Path<String>,
) -> Result<Json<TopologyDetail>, ApiError> {
    let topo = topology::find(&id).ok_or_else(|| not_found(&id))?;
    let member_views = member_views(&topo, &state.base).await;
    Ok(Json(TopologyDetail {
        topo,
        member_views,
    }))
}

async fn update(
    State(state): State<TopoState>,
    Path(id): Path<String>,
    Json(body): Json<TopoBody>,
) -> Result<Json<Topology>, ApiError> {
    let topo = topology::update(
        &id,
        body.name.as_deref(),
        body.description.as_deref(),
        body.members.as_deref(),
        &state.base,
    )
    .map_err(bad)?;
    let _ = state.topo_bus.send(());
    Ok(Json(topo))
}

async fn remove(State(state): State<TopoState>, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    topology::delete(&id).map_err(|e| {
        if e.contains("不存在") {
            not_found(&id)
        } else {
            bad(e)
        }
    })?;
    let _ = state.topo_bus.send(());
    Ok(StatusCode::NO_CONTENT)
}

/// 成员展示视图：端点按端口表查属主设备，设备查各注册表。
/// 端点查不到端口行（远端设备离线）时回退键本身——展示降级，不报错。
pub async fn member_views(topo: &Topology, state: &AppState) -> Vec<MemberView> {
    let rows = ss_server::list_ports_with_meta(state).await;
    topo.members
        .iter()
        .map(|m| {
            let (label, detail, online) = match m.kind {
                MemberKind::Device => device_labels(&m.key, state),
                MemberKind::Endpoint => match rows.iter().find(|r| r.info.name == m.key) {
                    Some(row) => (
                        format!(
                            "{} · {}",
                            row.device.as_ref().map(|d| d.label.as_str()).unwrap_or("?"),
                            row.alias.as_deref().unwrap_or(ss_core::split_port_key(&m.key).1)
                        ),
                        row.device.as_ref().and_then(|d| d.detail.clone()),
                        row.device.as_ref().and_then(|d| d.online),
                    ),
                    None => (m.key.clone(), None, None),
                },
            };
            MemberView {
                kind: m.kind,
                key: m.key.clone(),
                note: m.note.clone(),
                label,
                detail,
                online,
            }
        })
        .collect()
}

/// 设备键 → (展示名, 完整地址, 在线态)。local → 本机；SSH/远端查注册表。
fn device_labels(id: &str, state: &AppState) -> (String, Option<String>, Option<bool>) {
    if id == ss_core::LOCAL_DEVICE_ID {
        return ("本机".into(), None, None);
    }
    if let Some(rec) = state
        .ssh
        .registry_snapshot()
        .into_iter()
        .find(|r| r.id == id)
    {
        return (
            rec.label(),
            Some(format!("{}@{}:{}", rec.username, rec.host, rec.port)),
            None,
        );
    }
    if let Some((d, online)) = state
        .devices
        .device_views()
        .into_iter()
        .find(|(d, _)| d.id == id)
    {
        let addr = format!("{}:{}", d.host, d.port);
        let label = d
            .nickname
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(addr.clone());
        return (label, Some(addr), Some(online));
    }
    (id.to_string(), None, None)
}

//! 拓扑 REST 接口（/api/topologies CRUD）与组装状态 TopoState。
//!
//! 通知走独立 SSE 通道（/api/events，见 events.rs），不改 ss-server 的 WS 协议——
//! 这是设计文档 §6 的实现修正：命令面 REST、通知面 SSE，拓扑数据变更频率低，
//! 无需把 ui-rack 绑进串口终端的 WS 词典。

use crate::device::{self, Channel, Device, DeviceInput};
use crate::lease;
use crate::topology::{self, LinkInput, MemberInput, Topology};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use ss_server::AppState;
use ss_server::PortView;
use std::sync::Arc;
use tokio::sync::broadcast;

/// devicerack 组装状态：ss-server 共享运行时 + 拓扑/租约两条变更广播 + 租约管理器
/// + I/O 会话管理器（设备本体论工具面的连接/影子缓冲）。
/// bus 是空通道语义（收发双方只关心"变了"，不传载荷）。
#[derive(Clone)]
pub struct TopoState {
    pub base: AppState,
    pub topo_bus: Arc<broadcast::Sender<()>>,
    pub lease_bus: Arc<broadcast::Sender<()>>,
    pub leases: Arc<lease::LeaseManager>,
    pub sessions: Arc<crate::session::SessionManager>,
}

impl TopoState {
    /// 生产组装点：总线 + 租约管理器（配置读 lease.json）+ 会话管理器
    /// （租约管理器注入会话联动回调——释放/过期收回 I/O 连接）。
    pub fn create(base: AppState) -> TopoState {
        let (ttx, _) = broadcast::channel(16);
        let (ltx, _) = broadcast::channel(16);
        let leases = lease::LeaseManager::new(lease::load_config(), ltx.clone());
        let sessions = crate::session::SessionManager::new(std::sync::Arc::clone(&leases));
        leases.attach_sessions(std::sync::Arc::clone(&sessions));
        TopoState {
            base,
            topo_bus: Arc::new(ttx),
            lease_bus: Arc::new(ltx),
            leases,
            sessions,
        }
    }
}

/// 活跃租约的 REST 视图（占用中心消费）。
#[derive(Serialize)]
pub struct LeaseView {
    pub id: String,
    pub label: String,
    pub grants: Vec<lease::Grant>,
    pub acquired_at: chrono::DateTime<chrono::Local>,
    pub expires_at: chrono::DateTime<chrono::Local>,
    pub remaining_minutes: i64,
}

/// 创建/更新请求体。POST 要求 name（description/members/links 缺省为空）；
/// PUT 全部可选（提供才更新）。
#[derive(Deserialize)]
pub struct TopoBody {
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub members: Option<Vec<MemberInput>>,
    #[serde(default)]
    pub links: Option<Vec<LinkInput>>,
}

/// 成员（被测设备）的展示视图：设备 + 通道明细（在线/占用由前端经 leases join）。
#[derive(Serialize)]
pub struct ChannelView {
    #[serde(rename = "type")]
    pub kind: String,
    /// 通道目标键（串口端口键 / SSH 通道 id）。
    pub key: String,
    /// 展示标签（"串口 COM4·115200bps" / "SSH 车间网关"）。
    pub label: String,
    /// 通道端口当前在端口表中可见（串口在位/SSH 端点行存在）。
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holders: Option<usize>,
    /// 串口通道存储的波特率（终端即点即开用）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
}

#[derive(Serialize)]
pub struct MemberView {
    pub device: String,
    pub name: String,
    pub model: String,
    pub location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub channels: Vec<ChannelView>,
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
        .route(
            "/api/topologies/:id",
            get(detail).put(update).delete(remove),
        )
        .route("/api/devices", get(devices_list).post(devices_create))
        .route(
            "/api/devices/:id",
            axum::routing::put(devices_update).delete(devices_delete),
        )
        .route("/api/leases", get(leases_list))
        .route("/api/leases/:id", axum::routing::delete(lease_force_delete))
        .route("/api/remotes", get(remotes_list).put(remotes_save))
        .route("/api/settings", get(settings_get).put(settings_put))
        // 访问验证管理面（底座 AccessManager 的 REST 投影；serial-studio 桌面端
        // 走 Tauri invoke，devicerack 无壳故自给管理端点。返回体含验证码明文——
        // 管理面与底座同前提：可信内网）
        .route("/api/access/config", get(access_config_get).put(access_config_put))
        .route("/api/access/code", post(access_code_rotate))
        .route("/api/access/sessions", post(access_sessions_revoke))
        .route("/api/events", get(crate::events::sse))
}

type ApiError = (StatusCode, Json<Value>);

fn bad(message: impl Into<String>) -> ApiError {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.into() })),
    )
}

fn not_found(id: &str) -> ApiError {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": format!("不存在: {id}") })),
    )
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
        body.links.as_deref().unwrap_or(&[]),
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
    Ok(Json(TopologyDetail { topo, member_views }))
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
        body.links.as_deref(),
    )
    .map_err(bad)?;
    let _ = state.topo_bus.send(());
    Ok(Json(topo))
}

async fn remove(
    State(state): State<TopoState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
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

async fn leases_list(State(state): State<TopoState>) -> Json<Vec<LeaseView>> {
    Json(
        state
            .leases
            .list()
            .into_iter()
            .map(|l| LeaseView {
                remaining_minutes: lease::remaining_minutes(&l),
                id: l.id,
                label: l.label,
                grants: l.grants,
                acquired_at: l.acquired_at,
                expires_at: l.expires_at,
            })
            .collect(),
    )
}

/// 人工强释放（占用中心）。无 token 校验——闸的语义是"人可以随时收回 AI 的写权"。
async fn lease_force_delete(
    State(state): State<TopoState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .leases
        .force_release(&id, &state.base)
        .await
        .map_err(|e| {
            if e.contains("不存在") {
                not_found(&id)
            } else {
                bad(e)
            }
        })?;
    Ok(StatusCode::NO_CONTENT)
}

// ===== 远端设备与设置（原 Tauri IPC 专属，平台 Web 化补 REST 入口）=====

async fn remotes_list() -> Json<Vec<ss_core::RemoteDevice>> {
    Json(ss_server::remotes_store::load())
}

/// 全量覆盖远端设备表（昵称校验在 store 层）：更新连接池并触发（重）连接，
/// meta_bus 通知所有客户端刷新端口列表。
async fn remotes_save(
    State(state): State<TopoState>,
    Json(body): Json<RemotesBody>,
) -> Result<Json<Vec<ss_core::RemoteDevice>>, ApiError> {
    ss_server::remotes_store::save(&body.devices).map_err(bad)?;
    state.base.devices.update_registry(&body.devices);
    state.base.devices.start();
    let _ = state.base.meta_bus.send(());
    Ok(Json(body.devices))
}

#[derive(Deserialize)]
pub struct RemotesBody {
    pub devices: Vec<ss_core::RemoteDevice>,
}

/// 设置视图：服务器 settings.json + 租约 lease.json（后者展示运行中定格值）。
#[derive(Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    pub server: ss_server::settings::Settings,
    pub lease: lease::LeaseConfig,
}

async fn settings_get(State(state): State<TopoState>) -> Json<SettingsView> {
    // 监听参数（ws_host/ws_port）照 serial-studio 语义直读 settings.json——
    // 它就是持久真相源（启动 resolve_listen 读它；改后重启生效）
    Json(SettingsView {
        server: ss_server::settings::load(),
        lease: state.leases.cfg.clone(),
    })
}

/// 提供的字段才更新（instance_id 永不覆盖）；enable_scripting 热生效（刷新
/// AppState 缓存的原子开关）；监听参数/telnet 端口/lease.json 写盘后重启生效。
#[derive(Deserialize)]
pub struct SettingsBody {
    ws_host: Option<String>,
    ws_port: Option<u16>,
    telnet_port: Option<u16>,
    enable_scripting: Option<bool>,
    script_log_to_disk: Option<bool>,
    lease: Option<lease::LeaseConfig>,
}

async fn settings_put(
    State(state): State<TopoState>,
    Json(body): Json<SettingsBody>,
) -> Result<Json<SettingsView>, ApiError> {
    let mut s = ss_server::settings::load();
    if let Some(v) = body.ws_host {
        if v.trim().is_empty() {
            return Err(bad("监听地址不能为空".to_string()));
        }
        s.ws_host = v;
    }
    if let Some(v) = body.ws_port {
        if v == 0 {
            return Err(bad("监听端口不能为 0".to_string()));
        }
        s.ws_port = v;
    }
    if let Some(v) = body.telnet_port {
        s.telnet_port = v;
    }
    if let Some(v) = body.script_log_to_disk {
        s.script_log_to_disk = v;
    }
    if let Some(v) = body.enable_scripting {
        s.enable_scripting = v;
        state
            .base
            .enable_scripting
            .store(v, std::sync::atomic::Ordering::Relaxed);
    }
    ss_server::settings::save(&s).map_err(bad)?;
    if let Some(cfg) = &body.lease {
        lease::save_config(cfg).map_err(bad)?;
    }
    // 返回视图回显落盘后的 settings.json（s 已合并写入值；监听改动重启生效）
    Ok(Json(SettingsView {
        server: s,
        lease: body.lease.unwrap_or_else(|| state.leases.cfg.clone()),
    }))
}

/// 成员（被测设备）展示视图：设备注册表 + 端口表实时状态。
/// 设备已删除（注册表查无）时给占位视图——展示降级，不报错。
pub async fn member_views(topo: &Topology, state: &AppState) -> Vec<MemberView> {
    let rows = ss_server::list_ports_with_meta(state).await;
    topo.members
        .iter()
        .map(|m| match device::find(&m.device) {
            Some(d) => {
                let channels = channel_views(&d, state, &rows);
                MemberView {
                    device: d.id,
                    name: d.name,
                    model: d.model,
                    location: d.location,
                    note: m.note.clone(),
                    channels,
                }
            }
            None => MemberView {
                device: m.device.clone(),
                name: format!("（已删除 {}）", m.device),
                model: String::new(),
                location: String::new(),
                note: m.note.clone(),
                channels: Vec::new(),
            },
        })
        .collect()
}

/// 设备的通道视图：串口通道在端口表精确匹配（label 带存储的波特率）；
/// SSH 通道按 id 取端点行（present = 任一端点行可见）。
pub fn channel_views(d: &Device, _state: &AppState, rows: &[PortView]) -> Vec<ChannelView> {
    d.channels
        .iter()
        .map(|ch| match ch {
            Channel::Serial { port, config } => {
                let row = rows.iter().find(|r| r.info.name == *port);
                ChannelView {
                    kind: "serial".into(),
                    key: port.clone(),
                    label: ch.label(),
                    present: row.is_some(),
                    opened: row.map(|r| r.info.opened),
                    holders: row.map(|r| r.info.holders),
                    baud_rate: Some(config.baud_rate),
                }
            }
            Channel::Ssh(s) => {
                let endpoints: Vec<&PortView> = rows
                    .iter()
                    .filter(|r| ss_core::split_port_key(&r.info.name).0 == s.id)
                    .collect();
                ChannelView {
                    kind: "ssh".into(),
                    key: s.id.clone(),
                    label: ch.label(),
                    present: !endpoints.is_empty(),
                    opened: endpoints.first().map(|r| r.info.opened),
                    holders: endpoints.first().map(|r| r.info.holders),
                    baud_rate: None,
                }
            }
        })
        .collect()
}

// ===== 被测设备 CRUD =====

async fn devices_list() -> Json<Vec<Device>> {
    Json(device::load())
}

async fn devices_create(
    State(state): State<TopoState>,
    Json(input): Json<DeviceInput>,
) -> Result<(StatusCode, Json<Device>), ApiError> {
    let d = device::create(&input, &state.base).map_err(bad)?;
    let _ = state.topo_bus.send(());
    Ok((StatusCode::CREATED, Json(d)))
}

async fn devices_update(
    State(state): State<TopoState>,
    Path(id): Path<String>,
    Json(input): Json<DeviceInput>,
) -> Result<Json<Device>, ApiError> {
    let d = device::update(&id, &input, &state.base).map_err(|e| {
        if e.contains("不存在") {
            (StatusCode::NOT_FOUND, Json(json!({ "error": e })))
        } else {
            bad(e)
        }
    })?;
    let _ = state.topo_bus.send(());
    Ok(Json(d))
}

async fn devices_delete(
    State(state): State<TopoState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    device::delete(&id, &state.base).map_err(|e| {
        if e.contains("不存在") {
            (StatusCode::NOT_FOUND, Json(json!({ "error": e })))
        } else {
            bad(e)
        }
    })?;
    let _ = state.topo_bus.send(());
    Ok(StatusCode::NO_CONTENT)
}

// ===== 访问验证管理面 =====
// 说明：配置立即生效于闸与验证逻辑；TLS 监听的生命周期管理（supervisor 重绑
// HTTPS/Telnet）是 serial-studio 桌面壳的能力，devicerack 进程暂未接入——启用
// 验证时走「允许 HTTP 验证」路径（配置校验允许无证书 + allow_http）。

async fn access_config_get(State(state): State<TopoState>) -> Json<ss_server::access::AccessStatus> {
    Json(state.base.access.status())
}

async fn access_config_put(
    State(state): State<TopoState>,
    Json(config): Json<ss_server::access::AccessConfig>,
) -> Result<Json<ss_server::access::AccessStatus>, ApiError> {
    // 校验+应用一体；拒绝时保原配置，错误文案回前端
    state
        .base
        .access
        .configure(config)
        .map(|()| Json(state.base.access.status()))
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))))
}

async fn access_code_rotate(State(state): State<TopoState>) -> Json<ss_server::access::AccessStatus> {
    Json(state.base.access.rotate_code())
}

async fn access_sessions_revoke(State(state): State<TopoState>) -> StatusCode {
    state.base.access.revoke_all();
    StatusCode::NO_CONTENT
}

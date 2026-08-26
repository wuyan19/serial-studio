//! Serial Studio 服务端库：axum 路由 + 共享状态。
//!
//! 抽成 lib 是为了让 Tauri app（GUI 模式）和独立 ss-server bin（headless 模式）
//! 共用同一套路由——方案 B 的核心：一份后端，两种宿主。

pub mod address;
pub mod config;
pub mod device;
pub mod macros_store;
mod mcp;
pub mod port_meta_store;
pub mod protocol;
pub mod remotes_store;
pub mod scripts_store;
pub mod settings;
pub mod supervisor;
pub mod telnet;
mod ws;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use ss_core::{EventBus, SerialManager, SessionId};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::broadcast;

/// 应用共享状态：GUI 模式和 headless 模式共用。
/// 运行中脚本的归属:断连/关窗时据此 abort 本连接启动的脚本,防 orphan 占槽(无超时后变无界)。
#[derive(Debug)]
pub enum ScriptOwner {
    /// WS 连接(session 级)。
    Session(SessionId),
    /// Tauri 窗口(label)。
    Window(String),
}

/// 一条运行中脚本:停止信号 + 归属。
#[derive(Debug)]
pub struct ScriptRun {
    pub abort: Arc<std::sync::atomic::AtomicBool>,
    pub owner: ScriptOwner,
}

#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<SerialManager>,
    pub event_bus: Arc<EventBus>,
    /// 端口元数据（别名等）变更广播。set_alias 后通知所有 WS/IPC 客户端刷新列表，
    /// 否则别的客户端要等下一个串口事件才看到新别名。与串口 EventBus 分离——
    /// 这是用户配置变更，不是串口硬件事件，不进 core 的 SerialEvent。
    pub meta_bus: Arc<broadcast::Sender<()>>,
    /// 脚本库(scripts.json)变更广播。save/upsert/remove 后通知所有 WS/IPC 客户端
    /// 重新 load_scripts——否则 MCP/Tauri 写入后前端不感知,要重启才看到(内存权威模型)。
    /// 与 meta_bus 同构但隔离:不同数据域,前端各自 reload。
    pub script_bus: Arc<broadcast::Sender<()>>,
    /// 远程脚本执行开关（缓存自 settings.json,WS/MCP 每次检查读内存而非读盘）。
    /// `save_settings`/`apply_settings` 时同步刷新。
    pub enable_scripting: Arc<std::sync::atomic::AtomicBool>,
    /// 脚本并发上限信号量:远程 DoS 防护,限制同时执行的脚本数。
    pub script_semaphore: Arc<tokio::sync::Semaphore>,
    /// WS 连接的关闭信号:session → oneshot sender。force_close 经此点对点断开被踢的连接
    /// (不靠 EventBus 广播——广播 Lagged 会丢,踢人须必送达)。
    pub closers: Arc<std::sync::Mutex<HashMap<SessionId, tokio::sync::oneshot::Sender<()>>>>,
    /// 运行中脚本的停止信号:run_id → abort flag。StopScript 时 set flag,脚本 sleep 分段轮询
    /// 命中即抛 JS 异常退出(见 ss_core::script)。脚本结束自动移除。
    pub script_runs: Arc<std::sync::Mutex<HashMap<String, ScriptRun>>>,
    /// 远程设备连接池:每注册设备一条 WS 到远端 ss。挂在 AppState(跨 ServiceSupervisor
    /// 热重启保留,连接不重建);start() 惰性幂等,由 supervisor.start 触发。
    pub devices: Arc<device::DeviceClientManager>,
    /// 端口寻址解析:别名(本机/远端)与设备昵称 → 规范键。manager 的 KeyResolver
    /// 与 MCP 直查共用同一实例;meta_bus 驱动别名索引重建。
    pub addresses: Arc<address::AddressResolver>,
    /// 本实例全局身份(段名=实例 id 的根基)。settings 首启生成落盘,跨重启稳定;
    /// 测试注入固定值不落盘。列表合并与别名索引的环检测语义判据用它。
    pub instance_id: Arc<str>,
}

/// 同时允许执行的脚本数（远程 DoS 防护:每脚本一个 OS 线程 + QuickJS runtime）。
const SCRIPT_MAX_CONCURRENCY: usize = 4;

/// 构造默认状态(生产组装点)。宏定义存前端本地，服务端无状态（只执行 run_macro）。
/// opener 注入 CompositeOpener:本地串口走 serial,远端设备键路由到 DeviceClientManager
/// (core 的 RealPortOpener 仅在测试直接使用)。
/// manager 注入 AddressResolver 的 KeyResolver:别名/设备昵称解析单点在 manager 边界,
/// WS/MCP/Telnet/脚本各出口自动获得别名能力。
pub fn create_state() -> AppState {
    let event_bus = Arc::new(EventBus::new(1024));
    let (meta_tx, _) = broadcast::channel(16);
    let (script_tx, _) = broadcast::channel(16);
    let instance_id: Arc<str> = settings::instance_id().into();
    let devices = Arc::new(device::DeviceClientManager::from_registry(
        meta_tx.clone(),
        instance_id.to_string(),
    ));
    devices.bind(std::sync::Arc::downgrade(&devices)); // self-weak:client 握手学习上报用
    let addresses = Arc::new(address::AddressResolver::new(
        Arc::clone(&devices),
        meta_tx.clone(),
        instance_id.clone(),
    ));
    let manager = Arc::new(SerialManager::with_key_resolver(
        event_bus.clone(),
        Arc::new(device::CompositeOpener::new(Arc::clone(&devices))),
        addresses.key_resolver_fn(),
    ));
    let enable_scripting = Arc::new(std::sync::atomic::AtomicBool::new(
        settings::load().enable_scripting,
    ));
    AppState {
        manager,
        event_bus,
        meta_bus: Arc::new(meta_tx),
        script_bus: Arc::new(script_tx),
        enable_scripting,
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(SCRIPT_MAX_CONCURRENCY)),
        closers: Arc::new(std::sync::Mutex::new(HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(HashMap::new())),
        devices,
        addresses,
        instance_id,
    }
}

/// 面向客户端的端口视图：core 的运行时事实(`PortInfo`) + server 层用户元数据(alias)。
/// serde(flatten) 把 PortInfo 内联，线 JSON 扁平为 `{name,opened,holders,alias}`，
/// 前端 PortInfo 接口无需改。core 不持有别名——别名属 server 关注点。
/// 未来加 description/color 只在此 struct 加字段，core 不受影响。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PortView {
    #[serde(flatten)]
    pub info: ss_core::PortInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

/// 端口键的裸名部分(剥设备前缀)。ports.json 按裸名存本机端口的别名——
/// 本机端口键本就是裸名(遗留 `local::` 输入经 normalize 剥除),此函数对本机口
/// 恒等;远端口别名随远端 PortView 透传,不走本地 ports.json。
pub fn bare_name_of(port: &str) -> &str {
    ss_core::split_port_key(port).1
}

/// 列表透传深度上限(段数,含末段端口名):4 段 = 三跳级联。病态长链的兜底,
/// 非功能开关——真实深度受物理注册关系约束(每跳首段须为该机已注册设备)。
pub(crate) const MAX_PASSTHROUGH_SEGMENTS: usize = 4;

/// 远端桶条目透传判定(纯函数,列表合并与别名索引共用):组装候选键后按段链
/// 双层检查——
/// 1. **语义判据**(段名=实例 id 后生效):非首段含本机实例 id = 绕回路径
///    (互注册幽灵 `instB::instA::COM7`,A 收到即知是自己的口绕回来的)→ 丢弃;
///    首段豁免——首段是本机 compose 产生的直连段,自连镜像 `selfId::COM7` 合法;
/// 2. **结构判据**(永在,兜底旧版对端——其段名仍是本地 uuid,语义判据失明):
///    段重复 = 环(自连第二轮 `me::me::COM7`、互注册绕回 `ab::ba::ab::…`)→ 丢弃。
///    段数超上限丢弃;否则返回透传键(多级级联口在直连设备的 UI 可见,归其分组平铺)。
pub(crate) fn passthrough_port_key(dev_id: &str, wire: &str, self_id: &str) -> Option<String> {
    let key = ss_core::compose_port_key(dev_id, wire);
    let mut seen = HashSet::with_capacity(MAX_PASSTHROUGH_SEGMENTS + 1);
    for (i, seg) in key.split(ss_core::PORT_KEY_SEP).enumerate() {
        if i > 0 && seg == self_id {
            return None; // 非首段含本机实例 id → 绕回(幽灵),不透传
        }
        if !seen.insert(seg) {
            return None; // 段重复 → 环,不透传
        }
    }
    if seen.len() > MAX_PASSTHROUGH_SEGMENTS {
        return None; // 超深 → 病态长链,不透传
    }
    Some(key)
}

/// 列出端口并组合别名，返回面向客户端的 PortView。三条 list 路径（REST / WS / Tauri）共用。
///
/// 合并三个来源:
/// 1. 本地桶:manager.list_ports()(本机枚举 + 本地占有状态)+ ports.json 别名;
/// 2. 远端设备桶:DeviceClient 缓存的远端 PortView(远端别名透传——别名归端口
///    所在机器),键 = compose(devId, 远端线名)。**多级条目透传**,环检测与深度
///    上限见 [`passthrough_port_key`]——否则自连/互注册时列表每轮上报自我复制
///    (回声环,4→8→12…);多级级联的口(`devB::devC::COM3`)归直连设备分组平铺;
/// 3. 本地占有权快照覆盖 opened/holders/disconnected——**本地为唯一真相**
///    (远端 WS 断后其缓存是陈旧的,红标以本地 drainer 为准)。
pub async fn list_ports_with_meta(state: &AppState) -> Vec<PortView> {
    let meta = port_meta_store::load();
    let mut views: Vec<PortView> = state
        .manager
        .list_ports()
        .await
        .into_iter()
        .map(|info| {
            let alias = meta
                .get(bare_name_of(&info.name))
                .and_then(|m| m.alias.clone());
            PortView { info, alias }
        })
        .collect();
    // 远端桶(键加本设备段;后缀保持远端线名)。多级条目透传,环/超深由谓词判定
    // (语义判据用本机实例 id);线名已在 DeviceClient 入站归一(剥遗留 local::)。
    // 远端桶缓存本身不过滤(二级条目量级极小),谓词在两处消费点兜底。
    for (dev_id, ports) in state.devices.remote_buckets() {
        for pv in ports {
            let Some(name) = passthrough_port_key(&dev_id, &pv.info.name, &state.instance_id)
            else {
                continue; // 环(段重复/绕回)或超深,不透传
            };
            views.push(PortView {
                info: ss_core::PortInfo { name, ..pv.info },
                alias: pv.alias,
            });
        }
    }
    // 本地占有权覆盖远端桶的运行时状态
    let snap: HashMap<String, ss_core::PortInfo> = state
        .manager
        .snapshot_open_states()
        .await
        .into_iter()
        .map(|p| (p.name.clone(), p))
        .collect();
    for v in views.iter_mut() {
        if let Some(info) = snap.get(&v.info.name) {
            v.info.opened = info.opened;
            v.info.holders = info.holders;
            v.info.disconnected = info.disconnected;
        }
    }
    views
}

/// 设置端口别名并广播元数据变更：写 ports.json 后向 meta_bus 发一次通知，
/// 让所有已连 WS 客户端和本地 Tauri UI 刷新列表。alias 写入的唯一入口（Tauri 命令 / WS action 共用）。
/// 端口键为复合键:本机端口写本地 ports.json(裸名键);远端设备端口经设备连接
/// 转发 set_alias(写远端 ports.json——别名归端口所在机器)。
pub fn set_alias_and_notify(
    state: &AppState,
    port: &str,
    alias: Option<String>,
) -> Result<(), String> {
    validate_alias(&alias)?;
    match ss_core::split_port_key(port) {
        (ss_core::LOCAL_DEVICE_ID, name) => {
            port_meta_store::set_alias(name, alias)?;
            let _ = state.meta_bus.send(());
            Ok(())
        }
        (dev, rest) => {
            // 远端写入成功后远端回 meta_changed → DeviceClient 重拉 → 缓存 diff →
            // 本地 meta_bus(变更传播一轮收敛,不在此直接扇出——防自连回授环)
            state.devices.set_alias_blocking(dev, rest, alias)
        }
    }
}

/// 别名合法性校验(set_alias 唯一写入口的闸门):
/// - 含 `::` 会污染复合键首段切分(别名只按裸名整串匹配,含分隔符即成不可达死名字);
/// - 与真实枚举串口名冲突会让寻址产生歧义(Windows 串口名大小写不敏感,一并比对)。
/// 注:此校验只管本机写入的别名;远端设备的别名归远端校验——跨机同名冲突由
/// AddressResolver 的"真实名恒优先于别名"在解析侧兜底。
pub fn validate_alias(alias: &Option<String>) -> Result<(), String> {
    let Some(a) = alias else {
        return Ok(()); // None = 清除,合法
    };
    if a.contains(ss_core::PORT_KEY_SEP) {
        return Err(format!("别名不能包含「{0}」(复合键分隔符): {a}", ss_core::PORT_KEY_SEP));
    }
    if ss_core::serial::list_port_names()
        .iter()
        .any(|p| p.eq_ignore_ascii_case(a))
    {
        return Err(format!("别名「{a}」与真实串口名冲突,请换一个"));
    }
    Ok(())
}

/// 脚本编写 SKILL 全文(嵌入二进制;前端「脚本指南」对话框展示 / 复制给外部 Agent 用)。
/// skills/ 在源码树,tauri 构建整体编译,include_str! 编译期读得到(同 ui/dist 的跨目录引用)。
pub const SCRIPT_SKILL: &str = include_str!("../../../skills/serial-studio-script/SKILL.md");

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
    let ct = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    let mut res = Response::new(Body::from(file.data.into_owned()));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, ct.parse().unwrap());
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
async fn list_ports(State(state): State<AppState>) -> Json<Vec<PortView>> {
    Json(list_ports_with_meta(&state).await)
}

#[cfg(test)]
mod tests {
    //! PortView 线形状契约：serde(flatten) 必须产出扁平 JSON，
    //! 前端 PortInfo 接口（{name,opened,holders,alias?}）才能无感匹配。

    use super::*;

    #[test]
    fn alias_validation_rejects_separator_and_real_port_names() {
        // 含复合键分隔符 → 污染首段切分
        assert!(validate_alias(&Some("te::st".into())).is_err());
        // None(清除)与普通名合法;真实串口名的冲突检测依赖系统枚举,
        // CI/容器上枚举常为空——此处只断言不含分隔符的普通值不被 :: 规则误杀。
        // (真实端口名冲突分支由 validate_alias 内 list_port_names 比对,环境相关,不做硬断言)
        assert!(validate_alias(&None).is_ok());
        assert!(validate_alias(&Some("GPS".into())).is_ok() || {
            // 若本机恰好存在名为 GPS 的串口则合法被拒——两种结果都视为规则生效
            ss_core::serial::list_port_names().iter().any(|p| p == "GPS")
        });
    }

    #[test]
    fn port_view_flattens_to_flat_wire() {
        let v = PortView {
            info: ss_core::PortInfo {
                name: "COM7".into(),
                opened: true,
                holders: 2,
                disconnected: false,
            },
            alias: Some("GPS".into()),
        };
        let json = serde_json::to_value(&v).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(
            obj.len(),
            5,
            "flatten 应内联 PortInfo 字段(含 disconnected) + alias"
        );
        assert_eq!(obj["name"], "COM7");
        assert_eq!(obj["opened"], true);
        assert_eq!(obj["holders"], 2);
        assert_eq!(obj["disconnected"], false);
        assert_eq!(obj["alias"], "GPS");
    }

    #[test]
    fn port_view_skips_none_alias() {
        let v = PortView {
            info: ss_core::PortInfo {
                name: "COM3".into(),
                opened: false,
                holders: 0,
                disconnected: false,
            },
            alias: None,
        };
        let json = serde_json::to_value(&v).unwrap();
        let obj = json.as_object().unwrap();
        assert!(!obj.contains_key("alias"), "None alias 不应出现在线上");
        assert_eq!(obj.len(), 4);
    }

    #[test]
    fn passthrough_allows_bare_and_multilevel() {
        // 一级(现状形态):远端自己的口,照常透传
        assert_eq!(
            passthrough_port_key("dev-b", "COM7", "inst-a"),
            Some("dev-b::COM7".into())
        );
        // 二级(远端的远端桶,即本次放宽):A→B→C 的 C 口
        assert_eq!(
            passthrough_port_key("dev-b", "dev-c::COM7", "inst-a"),
            Some("dev-b::dev-c::COM7".into())
        );
        // 三跳(上限内)
        assert_eq!(
            passthrough_port_key("a", "b::c::COM7", "self"),
            Some("a::b::c::COM7".into())
        );
    }

    #[test]
    fn passthrough_drops_repeated_segment_loops() {
        // 自连第二轮:镜像条目回到自己远端桶,compose 后本机段重复
        assert_eq!(passthrough_port_key("dev-me", "dev-me::COM7", "self"), None);
        // 互注册绕回:ab::ba::ab(第三轮增殖被斩断)
        assert_eq!(passthrough_port_key("ab", "ba::ab::COM7", "self"), None);
        // 非环的重复段形态不涉及本机也照斩——结构性判据只看段链
        assert_eq!(passthrough_port_key("ab", "cd::ab::COM7", "self"), None);
    }

    #[test]
    fn passthrough_semantic_ghost_detection() {
        // 语义判据(段名=实例 id 生效):非首段含本机实例 id = 绕回幽灵。
        // 互注册:B 上报"我下级有 A 的口",线名首段是 A 的实例 id
        let ghost = passthrough_port_key("inst-b", "inst-a::COM7", "inst-a");
        assert_eq!(ghost, None, "非首段含本机 id 应识别为幽灵丢弃");
        // 多级绕回:链中任何非首段位置含本机 id 都斩
        assert_eq!(passthrough_port_key("b", "c::inst-a::COM7", "inst-a"), None);
        // 首段豁免:自连镜像,首段=本机段(本机 compose 产生),合法保留
        assert_eq!(
            passthrough_port_key("inst-a", "COM7", "inst-a"),
            Some("inst-a::COM7".into()),
            "自连一级镜像合法(首段豁免)"
        );
        // 非本机 id 不受语义判据影响(仅结构判据管)
        assert_eq!(
            passthrough_port_key("inst-b", "inst-c::COM7", "inst-a"),
            Some("inst-b::inst-c::COM7".into())
        );
    }

    #[test]
    fn passthrough_drops_excessive_depth() {
        // 5 段(四跳)超上限:病态长链兜底
        assert_eq!(passthrough_port_key("a", "b::c::d::COM7", "self"), None);
        // 4 段(三跳)恰好在上限内
        assert!(passthrough_port_key("a", "b::c::COM7", "self").is_some());
    }
}

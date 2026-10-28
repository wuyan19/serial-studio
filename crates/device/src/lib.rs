//! ss-device：设备访问域——SSH/远端设备/寻址解析/端口视图/设备相关存储。
//!
//! 从 ss-server 拆出（crate 布局审核 P1）：ss-server 曾五职合一（适配器+设备域+
//! 组合逻辑+持久化+组装根），设备访问模块被迫全面 pub。本 crate 承载设备域：
//! 连接层（SSH 会话池/远端设备客户端）、寻址（别名→规范键）、线协议（WS 词典）、
//! 端口视图组合的纯函数与设备存储。ss-server 依赖本 crate 并向其适配器（ws/mcp/
//! telnet）提供类型；topo-hub 同时直接依赖。

pub mod address;
pub mod config;
pub mod device;
pub mod port_meta_store;
pub mod protocol;
pub mod remotes_store;
pub mod ssh;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub use address::AddressResolver;
pub use device::DeviceClientManager;
pub use protocol::{ClientMsg, DeviceStateView, ServerMsg};
pub use ssh::SshManager;

// ===== 端口视图（结构化元数据，列表合并产物）=====

/// 端口行的属主设备视图(结构化元数据,列表合并每行内嵌)。id=稳定主键，
/// label=已解析展示名(昵称优先)，detail=完整地址(悬停/详情用)，via=hub 够到
/// 该设备的途径，online 仅 via="remote" 有值(hub 知道连接状态；SSH 懒连接、
/// 本机恒在)。via 用字符串枚举而非 Rust enum:新版对端上报的新值不得让旧版
/// 反序列化失败(kind 同理)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceView {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub via: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

/// 面向客户端的端口视图：core 的运行时事实(`PortInfo`) + 结构化元数据。
/// serde(flatten) 把 PortInfo 内联；alias/kind/instance/device 均可缺省——
/// 旧版对端解析新版上报得 None(平滑降级)，新版自身输出恒填充。
/// name 复合键仍是唯一寻址键(降级为不透明句柄)，语义消费走结构化字段，
/// UI 不再解析字符串猜属主/类别。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PortView {
    #[serde(flatten)]
    pub info: ss_core::PortInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// 端点类别："serial"|"ssh"(字符串枚举，为 exec/tcp 等新端点类型留空间)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 运行实例序号(Some(n)=shell@N 实例行；缺省=端点定义行/串口行)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<u32>,
    /// 属主设备(原始属主，非连接桶；远端桶经改写规则维持绝对属主)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceView>,
}

// ===== 纯函数（组合/改写/透传判定，无 IO）=====

/// 本机设备视图(本地串口行的 device)。
pub fn local_device_view() -> DeviceView {
    DeviceView {
        id: ss_core::LOCAL_DEVICE_ID.into(),
        label: "本地".into(),
        detail: None,
        via: "local".into(),
        online: None,
    }
}

/// SSH 设备视图(注册表记录 → 结构化属主)。label 复用记录的解析规则(昵称回退 user@host)。
pub fn ssh_device_view(rec: &ssh::SshHostRecord) -> DeviceView {
    DeviceView {
        id: rec.id.clone(),
        label: rec.label(),
        detail: Some(format!("{}@{}:{}", rec.username, rec.host, rec.port)),
        via: "ssh".into(),
        online: None,
    }
}

/// 端点 type → 线上 kind。v1 仅 shell(→ssh)；未知值透传(字符串枚举，新旧互不炸)。
pub fn endpoint_kind(t: &str) -> String {
    if t == "shell" {
        "ssh".into()
    } else {
        t.to_string()
    }
}

/// 实例行名(shell@N)→ 序号；无 `@` 或尾段非数字 → None(端点定义行)。
pub fn instance_no(rest: &str) -> Option<u32> {
    rest.rsplit_once('@').and_then(|(_, n)| n.parse().ok())
}

/// 远端桶行的 device 改写(纯函数)：行的 device 缺失(旧版对端)或 via=local
/// (对端自称本机的串口)时，改写为本机注册的直连设备视角；其余(对端的 SSH/
/// 远端设备)原样保留。维持不变量：行上 device 恒为绝对属主——多级级联的口
/// (devB::devC::COM3)归 origin 设备 devC，不归直连中转 devB。
pub fn rewrite_remote_device(device: &mut Option<DeviceView>, direct: &DeviceView) {
    let take = match device.as_ref() {
        Some(d) => d.via == "local",
        None => true,
    };
    if take {
        *device = Some(direct.clone());
    }
}

/// 旧版对端透传的多级行(线名自身含 `::`)不带 device 字段，而 origin 恰在线名
/// 首段——合成最小属主视图(id=首段，via=remote，无昵称/地址)，不归直连中转
/// (None 若直接走直连改写会把 origin 标成中转设备)。裸名返回 None(对端自家
/// 串口，走直连改写)。新对端自带 device，不经此函数。
pub fn legacy_origin_view(wire: &str) -> Option<DeviceView> {
    let (origin, _) = ss_core::split_port_key(wire);
    (origin != ss_core::LOCAL_DEVICE_ID).then(|| DeviceView {
        id: origin.into(),
        label: origin.into(),
        detail: None,
        via: "remote".into(),
        online: None,
    })
}

/// 端口键的裸名部分(剥设备前缀)。ports.json 按裸名存本机端口的别名——
/// 本机端口键本就是裸名(遗留 `local::` 输入经 normalize 剥除),此函数对本机口
/// 恒等;远端口别名随远端 PortView 透传,不走本地 ports.json。
pub fn bare_name_of(port: &str) -> &str {
    ss_core::split_port_key(port).1
}

/// 列表透传深度上限(段数,含末段端口名):4 段 = 三跳级联。病态长链的兜底,
/// 非功能开关——真实深度受物理注册关系约束(每跳首段须为该机已注册设备)。
pub const MAX_PASSTHROUGH_SEGMENTS: usize = 4;

/// 远端桶条目透传判定(纯函数,列表合并与别名索引共用):组装候选键后按段链
/// 双层检查——
/// 1. **语义判据**(段名=实例 id 后生效):非首段含本机实例 id = 绕回路径
///    (互注册幽灵 `instB::instA::COM7`,A 收到即知是自己的口绕回来的)→ 丢弃;
///    首段豁免——首段是本机 compose 产生的直连段,自连镜像 `selfId::COM7` 合法;
/// 2. **结构判据**(永在,兜底旧版对端——其段名仍是本地 uuid,语义判据失明):
///    段重复 = 环(自连第二轮 `me::me::COM7`、互注册绕回 `ab::ba::ab::…`)→ 丢弃。
///    段数超上限丢弃;否则返回透传键(多级级联口在直连设备的 UI 可见,归其分组平铺)。
pub fn passthrough_port_key(dev_id: &str, wire: &str, self_id: &str) -> Option<String> {
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

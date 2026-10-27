//! 拓扑域 MCP 工具集：topo_list / topo_get / topo_create / topo_update / topo_delete
//! + 租约 lease_acquire / lease_renew / lease_release / lease_status。
//!
//! 经 ss-server 的 McpExtension 注入 `/mcp`（见 mcp_ext.rs）。输出沿用内置工具的
//! 文本风格（content/text，中点分隔扁平单行）——AI 消费方与 serial_list 一致。
//! 变更后向 topo_bus/lease_bus 广播（SSE 客户端重拉）。
//!
//! 写闸（intercept）：serial_send/read/clear/脚本 在内置分发前经本扩展准入——
//! 目标端口须被本会话（principal = 参数 token > Mcp-Session-Id 头）的活跃租约
//! 覆盖。闸只作用于 MCP 来源；web/本地不经此路径（设计 §4）。

use crate::api::member_views;
use crate::lease::{remaining_minutes, AcquireError, LeaseManager, Scope};
use crate::topology::{self, MemberInput};
use serde::Deserialize;
use serde_json::{json, Value};
use ss_server::mcp_ext::McpExtension;
use ss_server::AppState;
use std::sync::Arc;
use tokio::sync::broadcast;

pub struct TopoTools {
    pub bus: broadcast::Sender<()>,
    pub leases: Arc<LeaseManager>,
}

fn ok_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

impl TopoTools {
    async fn topo_list(&self) -> Value {
        let list = topology::load();
        if list.is_empty() {
            return ok_text("暂无拓扑。用 topo_create 创建；可用 serial_list 查可引用的端口与设备。".into());
        }
        let lines: Vec<String> = list
            .iter()
            .map(|t| {
                let mut s = format!("{} · id {} · 成员 {} 项", t.name, t.id, t.members.len());
                if !t.description.is_empty() {
                    s.push_str(&format!(" · {}", t.description));
                }
                s
            })
            .collect();
        ok_text(lines.join("\n"))
    }

    async fn topo_get(&self, args: Value, state: &AppState) -> Value {
        let topo_ref = match args.get("topo").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => return error_text("缺少参数 topo（拓扑 id 或名称）".into()),
        };
        let Some(topo) = topology::find(topo_ref) else {
            return error_text(format!("拓扑不存在: {topo_ref}"));
        };
        let members = member_views(&topo, state).await;
        let mut lines = vec![format!(
            "{} · id {} · 成员 {} 项 · 更新于 {}",
            topo.name,
            topo.id,
            members.len(),
            topo.updated_at
        )];
        if !topo.description.is_empty() {
            lines.push(format!("描述: {}", topo.description));
        }
        for m in &members {
            let mut line = format!("{} {} · {}", m.kind.label(), m.key, m.label);
            if let Some(d) = &m.detail {
                line.push_str(&format!(" · {d}"));
            }
            if m.online == Some(false) {
                line.push_str(" · 离线");
            }
            if let Some(n) = &m.note {
                line.push_str(&format!(" · {n}"));
            }
            lines.push(line);
        }
        ok_text(lines.join("\n"))
    }

    async fn topo_create(&self, args: Value, state: &AppState) -> Value {
        let parsed: Result<CreateArgs, _> = serde_json::from_value(args);
        let Ok(a) = parsed else {
            return error_text("参数解析失败：需要 name（必填）、description?、members: [{key, note?}]".into());
        };
        match topology::create(&a.name, &a.description, &a.members, state) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!(
                    "已创建拓扑 {}（{}），成员 {} 项。成员键须为已注册设备或本机端口，可用 serial_list 查。",
                    t.name, t.id, t.members.len()
                ))
            }
            Err(e) => error_text(e),
        }
    }

    async fn topo_update(&self, args: Value, state: &AppState) -> Value {
        let parsed: Result<UpdateArgs, _> = serde_json::from_value(args);
        let Ok(a) = parsed else {
            return error_text("参数解析失败：需要 topo（id 或名称），name?/description?/members? 提供才更新".into());
        };
        match topology::update(
            &a.topo,
            a.name.as_deref(),
            a.description.as_deref(),
            a.members.as_deref(),
            state,
        ) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!(
                    "已更新拓扑 {}（{}），成员 {} 项。",
                    t.name, t.id, t.members.len()
                ))
            }
            Err(e) => error_text(e),
        }
    }

    async fn topo_delete(&self, args: Value) -> Value {
        let Some(topo_ref) = args.get("topo").and_then(|t| t.as_str()) else {
            return error_text("缺少参数 topo（拓扑 id 或名称）".into());
        };
        match topology::delete(topo_ref) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!("已删除拓扑 {}（{}）。", t.name, t.id))
            }
            Err(e) => error_text(e),
        }
    }
}

#[derive(Deserialize)]
struct CreateArgs {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    members: Vec<MemberInput>,
}

#[derive(Deserialize)]
struct UpdateArgs {
    topo: String,
    name: Option<String>,
    description: Option<String>,
    members: Option<Vec<MemberInput>>,
}

impl TopoTools {
    /// 写闸拦截目标端口的解析：port 参数 canon；缺省且恰好一个已开端口时用它；
    /// 解析不出（无参且零/多端口）→ None → 放行（工具自身会报错，闸不越位）。
    async fn gate_target_port(args: &Value, state: &AppState) -> Option<String> {
        if let Some(p) = args.get("port").and_then(|v| v.as_str()) {
            return Some(state.manager.canon_key(p));
        }
        let open = state.manager.list_open_ports().await;
        match open.len() {
            1 => Some(open[0].clone()),
            _ => None,
        }
    }

    async fn lease_acquire(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(token) = principal.map(str::to_string) else {
            return error_text(
                "申请租约须先标识会话：initialize 取 token（标准客户端自动带头），或在工具参数传 token".into(),
            );
        };
        let Ok(a) = serde_json::from_value::<AcquireArgs>(args) else {
            return error_text(
                "参数解析失败：topology? / devices? / endpoints?（可并用取并集）、holder?、ttl_minutes?".into(),
            );
        };
        let scope = Scope {
            topology: a.topology,
            devices: a.devices,
            endpoints: a.endpoints,
        };
        if scope.is_empty() {
            return error_text("申请范围为空：给 topology、devices 或 endpoints 至少一项".into());
        }
        let label = a
            .holder
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| format!("session-{}", &token[..8.min(token.len())]));
        match self.leases.acquire(&token, &label, &scope, a.ttl_minutes, state) {
            Ok(l) => ok_text(format!(
                "已获租约 {}（{}，剩余 {} 分钟）：{}{}",
                l.id,
                fmt_time(l.expires_at),
                remaining_minutes(&l),
                l.grants
                    .iter()
                    .map(|g| format!("{} {}", g.kind.label(), g.key))
                    .collect::<Vec<_>>()
                    .join("、"),
                // 提醒续租手段，长任务靠自己保活
                "\n用完 lease_release 释放；长任务用 lease_renew 顺延。"
            )),
            Err(AcquireError::Conflict(cs)) => {
                let lines: Vec<String> = cs
                    .iter()
                    .map(|c| {
                        format!(
                            "冲突 {} · 持有 {}（{}，剩余 {} 分钟）",
                            c.key,
                            c.holder,
                            c.lease_id,
                            (c.expires_at - chrono::Local::now()).num_minutes().max(0)
                        )
                    })
                    .collect();
                error_text(format!(
                    "申请被拒（{} 处冲突，未建立任何租约）：\n{}\n可等其释放/过期后重试，或换范围申请。",
                    lines.len(),
                    lines.join("\n")
                ))
            }
            Err(AcquireError::Invalid(e)) => error_text(e),
        }
    }

    async fn lease_renew(&self, args: Value, principal: Option<&str>) -> Value {
        let Some(id) = args.get("lease_id").and_then(|v| v.as_str()) else {
            return error_text("缺少参数 lease_id".into());
        };
        let Some(token) = principal else {
            return error_text("续租须会话标识（token 参数或 Mcp-Session-Id 头）".into());
        };
        let ttl = args.get("ttl_minutes").and_then(|v| v.as_u64());
        match self.leases.renew(id, token, ttl) {
            Ok(l) => ok_text(format!(
                "已续租 {} 至 {}（剩余 {} 分钟）",
                l.id,
                fmt_time(l.expires_at),
                remaining_minutes(&l)
            )),
            Err(e) => error_text(e),
        }
    }

    async fn lease_release(&self, args: Value, principal: Option<&str>) -> Value {
        let Some(id) = args.get("lease_id").and_then(|v| v.as_str()) else {
            return error_text("缺少参数 lease_id".into());
        };
        let Some(token) = principal else {
            return error_text("释放须会话标识（token 参数或 Mcp-Session-Id 头）".into());
        };
        match self.leases.release(id, token) {
            Ok(l) => ok_text(format!("已释放租约 {}（{}）。", l.id, l.label)),
            Err(e) => error_text(e),
        }
    }

    async fn lease_status(&self, principal: Option<&str>) -> Value {
        let Some(token) = principal else {
            return error_text("匿名会话无租约记录；initialize 取 token 或工具参数传 token".into());
        };
        let leases = self.leases.of_token(token);
        if leases.is_empty() {
            return ok_text("本会话当前无活跃租约。".into());
        }
        let lines: Vec<String> = leases
            .iter()
            .map(|l| {
                format!(
                    "{} · 剩余 {} 分钟 · {}",
                    l.id,
                    remaining_minutes(l),
                    l.grants
                        .iter()
                        .map(|g| format!("{} {}", g.kind.label(), g.key))
                        .collect::<Vec<_>>()
                        .join("、")
                )
            })
            .collect();
        ok_text(lines.join("\n"))
    }
}

#[derive(Deserialize)]
struct AcquireArgs {
    topology: Option<String>,
    #[serde(default)]
    devices: Vec<String>,
    #[serde(default)]
    endpoints: Vec<String>,
    holder: Option<String>,
    ttl_minutes: Option<u64>,
}

fn fmt_time(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%m-%d %H:%M").to_string()
}

impl McpExtension for TopoTools {
    fn tools(&self) -> Vec<Value> {
        vec![
            json!({
                "name": "topo_list",
                "description": "列出全部拓扑：名称、id、成员数、描述，中点分隔的扁平单行。调试前先看这里选拓扑。",
                "inputSchema": { "type": "object", "properties": {} }
            }),
            json!({
                "name": "topo_get",
                "description": "查看拓扑详情：成员清单（设备/端点、展示名、地址、在线状态、备注）。成员键即 lease_acquire 可用的引用。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topo": { "type": "string", "description": "拓扑 id 或名称" }
                    },
                    "required": ["topo"]
                }
            }),
            json!({
                "name": "topo_create",
                "description": "创建拓扑。成员键两种粒度：设备 id（如 SSH 设备 uuid、远端设备 id、local=本机全部串口）或端口键（本机 COM3、sshUuid::shell、别名/昵称作用域亦可，服务端定型）。键须真实存在，全部合法才创建。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "拓扑名称（同表唯一）" },
                        "description": { "type": "string", "description": "用途说明（可选）" },
                        "members": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": { "type": "string", "description": "设备 id 或端口键" },
                                    "note": { "type": "string", "description": "备注，如「被测主板」（可选）" }
                                },
                                "required": ["key"]
                            }
                        }
                    },
                    "required": ["name"]
                }
            }),
            json!({
                "name": "topo_update",
                "description": "更新拓扑：name/description/members 提供才更新，members 提供时整体替换（键同样须全部合法）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topo": { "type": "string", "description": "拓扑 id 或名称" },
                        "name": { "type": "string" },
                        "description": { "type": "string" },
                        "members": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": { "type": "string" },
                                    "note": { "type": "string" }
                                },
                                "required": ["key"]
                            }
                        }
                    },
                    "required": ["topo"]
                }
            }),
            json!({
                "name": "topo_delete",
                "description": "删除拓扑（仅删定义，不动设备与端口）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topo": { "type": "string", "description": "拓扑 id 或名称" }
                    },
                    "required": ["topo"]
                }
            }),
            json!({
                "name": "lease_acquire",
                "description": "申请租约（排他写权，all-or-nothing）：拓扑整体 / 设备列表 / 端点列表可并用取并集。须会话标识（initialize 的 token，标准客户端自动带头）。冲突整体拒绝并返回各端点当前持有者与到期时间。默认 30 分钟，到期自动释放，长任务用 lease_renew 顺延。持有租约后 serial_send/read/clear 与脚本工具才可用（写闸）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topology": { "type": "string", "description": "拓扑 id 或名称（成员并集）" },
                        "devices": { "type": "array", "items": { "type": "string" }, "description": "设备 id 列表（local=本机全部串口 / SSH 设备 id / 远端设备 id）" },
                        "endpoints": { "type": "array", "items": { "type": "string" }, "description": "端口键列表（支持别名，服务端定型）" },
                        "holder": { "type": "string", "description": "持有者自报名（展示与审计用，如 claude/agent-1）" },
                        "ttl_minutes": { "type": "integer", "description": "有效分钟数（默认 30，上限可配）" }
                    }
                }
            }),
            json!({
                "name": "lease_renew",
                "description": "续租：顺延到期时间（默认再 30 分钟）。仅持有会话可续。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "lease_id": { "type": "string" },
                        "ttl_minutes": { "type": "integer" }
                    },
                    "required": ["lease_id"]
                }
            }),
            json!({
                "name": "lease_release",
                "description": "释放租约（用完即还）。仅持有会话可释放。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "lease_id": { "type": "string" }
                    },
                    "required": ["lease_id"]
                }
            }),
            json!({
                "name": "lease_status",
                "description": "本会话的活跃租约清单（id、剩余时间、覆盖范围）。",
                "inputSchema": { "type": "object", "properties": {} }
            }),
        ]
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        principal: Option<&'a str>,
        state: &'a AppState,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>,
    > {
        Box::pin(async move {
            match name {
                "topo_list" => Some(self.topo_list().await),
                "topo_get" => Some(self.topo_get(args, state).await),
                "topo_create" => Some(self.topo_create(args, state).await),
                "topo_update" => Some(self.topo_update(args, state).await),
                "topo_delete" => Some(self.topo_delete(args).await),
                "lease_acquire" => Some(self.lease_acquire(args, principal, state).await),
                "lease_renew" => Some(self.lease_renew(args, principal).await),
                "lease_release" => Some(self.lease_release(args, principal).await),
                "lease_status" => Some(self.lease_status(principal).await),
                _ => None,
            }
        })
    }

    /// 写闸：仅当 enable_gate 开启且能解析目标端口时判定；拒绝文案附当前
    /// 持有者与到期时间。gate 内部已审计 write_denied。
    fn intercept<'a>(
        &'a self,
        _name: &'a str,
        args: Value,
        principal: Option<&'a str>,
        state: &'a AppState,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>,
    > {
        Box::pin(async move {
            if !self.leases.gate_enabled() {
                return None;
            }
            let Some(port) = Self::gate_target_port(&args, state).await else {
                return None;
            };
            match self.leases.gate(principal, &port) {
                Ok(()) => None,
                Err(msg) => Some(error_text(msg)),
            }
        })
    }
}

//! 拓扑域 MCP 工具集：topo_list / topo_get / topo_create / topo_update / topo_delete。
//!
//! 经 ss-server 的 McpExtension 注入 `/mcp`（见 mcp_ext.rs）。输出沿用内置工具的
//! 文本风格（content/text，中点分隔扁平单行）——AI 消费方与 serial_list 一致。
//! 变更后向 topo_bus 广播（SSE 客户端与后续 WS 通知同源）。

use crate::api::member_views;
use crate::topology::{self, MemberInput};
use serde::Deserialize;
use serde_json::{json, Value};
use ss_server::mcp_ext::McpExtension;
use ss_server::AppState;
use tokio::sync::broadcast;

pub struct TopoTools {
    pub bus: broadcast::Sender<()>,
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
        ]
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        args: Value,
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
                _ => None,
            }
        })
    }
}

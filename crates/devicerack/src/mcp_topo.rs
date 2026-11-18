//! 设备本体论 MCP 工具面（分叉 serial-studio 内置 serial_*）。
//!
//! 工具分层：
//! - 发现：get_topology（无参=列表）/ get_device（无参=列表）/ list_my_leases；
//! - 租约：acquire_lease / renew_lease / release_lease——租约即写权，I/O 入口检查；
//! - 通道 I/O：exec_command（无状态命令）/ open_session + send_input（持久会话）/
//!   read_output（游标补读） / close_session——设备+通道寻址，agent 不见端口键；
//! - 管理（隐藏，is_admin_tool 声明）：device_create/update/delete、
//!   topo_create/update/delete——tools/list 不出现但 tools/call 可用。
//!
//! builtin_tools_visible()=false：内置 serial_*/port_* 不进 tools/list（分叉声明），
//! tools/call 对内置名照常分发。intercept 写闸保留——agent 万一猜用内置名仍受闸。
//!
//! 输出沿用文本风格（content/text，中点分隔扁平单行）。变更后向
//! topo_bus/lease_bus 广播（SSE 客户端重拉）。

use crate::api::member_views;
use crate::device;
use crate::lease::{remaining_minutes, AcquireError, LeaseManager, Scope};
use crate::session::{ResolvedChannel, SessionManager};
use crate::topology::{self, LinkInput, MemberInput};
use serde::Deserialize;
use serde_json::{json, Value};
use ss_server::mcp_ext::McpExtension;
use ss_server::AppState;
use std::sync::Arc;
use tokio::sync::broadcast;

pub struct TopoTools {
    pub bus: broadcast::Sender<()>,
    pub leases: Arc<LeaseManager>,
    pub sessions: Arc<SessionManager>,
}

fn ok_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// I/O 工具通用入参。
fn arg_device(args: &Value) -> Option<String> {
    args.get("device")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
}

fn arg_channel(args: &Value) -> Option<String> {
    args.get("channel")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
}

impl TopoTools {
    // ===== 发现层 =====

    async fn topo_list(&self) -> Value {
        let list = topology::load();
        if list.is_empty() {
            return ok_text(
                "暂无拓扑（拓扑由管理端 topo_create 创建——tools/list 隐藏的管理工具，可直接调用）。".into(),
            );
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

    async fn get_topology(&self, args: Value, state: &AppState) -> Value {
        let topo_ref = args
            .get("topology")
            .and_then(|t| t.as_str())
            .filter(|t| !t.trim().is_empty());
        let Some(topo_ref) = topo_ref else {
            return self.topo_list().await;
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
            let mut line = format!("设备 {}（{}）", m.name, m.device);
            if !m.channels.is_empty() {
                let chans: Vec<String> = m
                    .channels
                    .iter()
                    .map(|c| format!("{}{}", c.label, if c.present { "" } else { "（不在位）" }))
                    .collect();
                line.push_str(&format!(" · 通道: {}", chans.join("、")));
            }
            if let Some(l) = self.leases.lease_of_device(&m.device) {
                line.push_str(&format!(
                    " · 占用中（{}，剩余 {} 分钟）",
                    l.label,
                    remaining_minutes(&l)
                ));
            }
            if let Some(n) = &m.note {
                line.push_str(&format!(" · {n}"));
            }
            lines.push(line);
        }
        for l in &topo.links {
            let name_of = |id: &str| {
                device::find(id)
                    .map(|d| d.name)
                    .unwrap_or_else(|| id.to_string())
            };
            // 端口标签进设备名（"ESG6220:GE1/1/1"），与 Web 图视图同形
            let from = match &l.from_port {
                Some(p) => format!("{}:{p}", name_of(&l.from)),
                None => name_of(&l.from),
            };
            let to = match &l.to_port {
                Some(p) => format!("{}:{p}", name_of(&l.to)),
                None => name_of(&l.to),
            };
            let label = l.label.as_deref().unwrap_or("");
            lines.push(format!(
                "连接 {from} ↔ {to}{}",
                if label.is_empty() {
                    String::new()
                } else {
                    format!(" · {label}")
                }
            ));
        }
        ok_text(lines.join("\n"))
    }

    async fn device_list(&self) -> Value {
        let list = device::load();
        if list.is_empty() {
            return ok_text(
                "暂无被测设备。用 device_create 注册（设备=身份，通道=串口/SSH 接入，如一台交换机 = COM4 串口 + admin/support 两条 SSH 凭据）。".into(),
            );
        }
        let lines: Vec<String> = list
            .iter()
            .map(|d| {
                let chans: Vec<String> = d.channels.iter().map(|c| c.label()).collect();
                let mut s = format!(
                    "{} · id {} · 通道: {}",
                    d.name,
                    d.id,
                    if chans.is_empty() {
                        "（无）".into()
                    } else {
                        chans.join("、")
                    }
                );
                if let Some(l) = self.leases.lease_of_device(&d.id) {
                    s.push_str(&format!(
                        " · 占用中（{}，剩余 {} 分钟）",
                        l.label,
                        remaining_minutes(&l)
                    ));
                }
                if !d.location.is_empty() {
                    s.push_str(&format!(" · {}", d.location));
                }
                s
            })
            .collect();
        ok_text(lines.join("\n"))
    }

    async fn get_device(&self, args: Value, _state: &AppState) -> Value {
        let dev_ref = arg_device(&args);
        let Some(dev_ref) = dev_ref else {
            return self.device_list().await;
        };
        let Some(d) = device::find(&dev_ref) else {
            return error_text(format!("设备不存在: {dev_ref}（不传 device 可列出全部）"));
        };
        let mut lines = vec![format!(
            "{} · id {}{}{}",
            d.name,
            d.id,
            if d.model.is_empty() {
                String::new()
            } else {
                format!(" · 型号 {}", d.model)
            },
            if d.location.is_empty() {
                String::new()
            } else {
                format!(" · 位置 {}", d.location)
            },
        )];
        // 通道带序号：I/O 工具的 channel 参数可用序号（"0"）或标签子串
        for (i, ch) in d.channels.iter().enumerate() {
            lines.push(match ch {
                device::Channel::Serial { port, .. } => {
                    format!("通道[{i}] 串口 {port} · {}", ch.label())
                }
                device::Channel::Ssh(s) => format!(
                    "通道[{i}] SSH {} · {}:{} · 认证 {}",
                    s.label(),
                    s.host,
                    s.port,
                    ss_server::ssh::auth_label_of(&s.auth)
                ),
            });
        }
        if let Some(l) = self.leases.lease_of_device(&d.id) {
            lines.push(format!(
                "占用中 · 持有 {}（至 {}，剩余 {} 分钟）",
                l.label,
                fmt_time(l.expires_at),
                remaining_minutes(&l)
            ));
        } else {
            lines.push("空闲".into());
        }
        lines.push(
            "I/O：acquire_lease 后用 exec_command / open_session（channel 可省略=默认通道）。"
                .into(),
        );
        ok_text(lines.join("\n"))
    }

    // ===== 通道 I/O 层（session.rs 承载连接与影子缓冲）=====

    /// I/O 入口：io_gate（会话+租约+通道解析）→ open（连接取或建）。
    async fn io_prepare(
        &self,
        args: &Value,
        principal: Option<&str>,
        state: &AppState,
    ) -> Result<(String, ResolvedChannel), Value> {
        let Some(dev) = arg_device(args) else {
            return Err(error_text(
                "缺少参数 device（设备 id 或名称，get_device 不传参可列出全部）".into(),
            ));
        };
        let ch = arg_channel(args);
        let rc = match self.sessions.io_gate(principal, &dev, ch.as_deref()) {
            Ok(rc) => rc,
            Err(e) => return Err(error_text(e)),
        };
        let Some(token) = principal else {
            return Err(error_text("须会话标识（initialize 取 token）".into()));
        };
        if let Err(e) = self
            .sessions
            .open(token, &rc.port_key, rc.config.clone(), state)
            .await
        {
            return Err(error_text(e));
        }
        Ok((token.to_string(), rc))
    }

    async fn exec_command(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(command) = args
            .get("command")
            .and_then(|c| c.as_str())
            .filter(|c| !c.trim().is_empty())
        else {
            return error_text("缺少参数 command（要执行的命令）".into());
        };
        let (token, rc) = match self.io_prepare(&args, principal, state).await {
            Ok(v) => v,
            Err(e) => return e,
        };
        let wait_ms = args.get("wait_ms").and_then(|v| v.as_u64()).unwrap_or(3000);
        let idle_ms = args.get("idle_ms").and_then(|v| v.as_u64()).unwrap_or(250);
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(64 * 1024) as usize;
        let (out, cursor, truncated, timed_out) = match self
            .sessions
            .send_and_collect(
                &token,
                &rc.port_key,
                command,
                true,
                wait_ms,
                idle_ms,
                max_bytes,
                state,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => return error_text(e),
        };
        let mut s = out;
        if timed_out {
            s.push_str("\n（等待超时无输出：设备可能不回显或命令仍在执行，read_output(device) 可轮询新数据）");
        }
        if truncated {
            s.push_str(&format!(
                "\n…（截断：用 read_output(device, channel, since={cursor}) 补读剩余）"
            ));
        }
        ok_text(s)
    }

    async fn open_session(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let (_, rc) = match self.io_prepare(&args, principal, state).await {
            Ok(v) => v,
            Err(e) => return e,
        };
        // 会话即通道：后续 send_input/read_output 用同样的 device+channel 寻址
        ok_text(format!(
            "已开会话：{}。后续 send_input/read_output/close_session 传相同的 device+channel 即定位本会话；用完 close_session。",
            rc.label
        ))
    }

    async fn send_input(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(data) = args.get("data").and_then(|d| d.as_str()) else {
            return error_text("缺少参数 data（要发送的数据）".into());
        };
        let (token, rc) = match self.io_prepare(&args, principal, state).await {
            Ok(v) => v,
            Err(e) => return e,
        };
        let append_newline = args
            .get("append_newline")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let wait_ms = args.get("wait_ms").and_then(|v| v.as_u64()).unwrap_or(2000);
        let idle_ms = args.get("idle_ms").and_then(|v| v.as_u64()).unwrap_or(250);
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(64 * 1024) as usize;
        let (out, cursor, truncated, timed_out) = match self
            .sessions
            .send_and_collect(
                &token,
                &rc.port_key,
                data,
                append_newline,
                wait_ms,
                idle_ms,
                max_bytes,
                state,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => return error_text(e),
        };
        let mut s = if wait_ms == 0 {
            "已发送（未等待响应；read_output(device) 可后续轮询输出）".to_string()
        } else {
            out
        };
        if truncated {
            s.push_str(&format!(
                "\n…（截断：用 read_output(device, channel, since={cursor}) 补读剩余）"
            ));
        }
        if wait_ms > 0 && timed_out {
            s.push_str("\n（等待超时无输出：设备可能不回显或命令仍在执行）");
        }
        ok_text(s)
    }

    async fn read_output(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(token) = principal.map(str::to_string) else {
            return error_text("须会话标识（initialize 取 token）".into());
        };
        let Some(dev) = arg_device(&args) else {
            return error_text("缺少参数 device（会话的设备寻址）".into());
        };
        let ch = arg_channel(&args);
        // 读不破坏：仅解析通道寻址（会话须已由 open_session/exec_command 建立）
        let rc = match SessionManager::resolve(&dev, ch.as_deref()) {
            Ok(rc) => rc,
            Err(e) => return error_text(e),
        };
        // since：字符串或数字 JSON 形态皆可（cursor 本是数）
        let since = match args.get("since") {
            None => None,
            Some(v) => match v
                .as_str()
                .and_then(|c| c.parse::<usize>().ok())
                .or_else(|| v.as_u64().map(|n| n as usize))
            {
                Some(n) => Some(n),
                None => {
                    return error_text(
                        "since 须为数字游标（上次返回的 cursor 值）、\"0\"（从头读）或省略（只读新数据）".into(),
                    )
                }
            },
        };
        let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(64 * 1024) as usize;
        let (data, cursor, dropped, truncated) = match self
            .sessions
            .read_since(&token, &rc.port_key, since, timeout_ms, max_bytes, state)
            .await
        {
            Ok(v) => v,
            Err(e) => return error_text(e),
        };
        let mut s = data;
        if dropped > 0 {
            s.push_str(&format!(
                "\n（⚠ 缓冲滚动丢弃 {dropped} 字节——读晚了，窗口外数据已失）"
            ));
        }
        if truncated {
            s.push_str(&format!(
                "\n…（截断：read_output(device, channel, since={cursor}) 继续读）"
            ));
        }
        ok_text(s)
    }

    async fn close_session(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(token) = principal.map(str::to_string) else {
            return error_text("须会话标识（initialize 取 token）".into());
        };
        let Some(dev) = arg_device(&args) else {
            return error_text("缺少参数 device（会话的设备寻址）".into());
        };
        let ch = arg_channel(&args);
        let rc = match SessionManager::resolve(&dev, ch.as_deref()) {
            Ok(rc) => rc,
            Err(e) => return error_text(e),
        };
        match self.sessions.close(&token, &rc.port_key, state).await {
            Ok(true) => ok_text(format!("已关闭会话（通道 {}）", rc.label)),
            Ok(false) => ok_text(format!("会话已不在（通道 {}）", rc.label)),
            Err(e) => error_text(e),
        }
    }

    // ===== 租约层 =====

    async fn acquire_lease(&self, args: Value, principal: Option<&str>) -> Value {
        let Some(token) = principal.map(str::to_string) else {
            return error_text(
                "申请租约须先标识会话：initialize 取 token（标准客户端自动带头），或在工具参数传 token".into(),
            );
        };
        let Ok(a) = serde_json::from_value::<AcquireArgs>(args) else {
            return error_text(
                "参数解析失败：topology? / devices? / endpoints?（可并用取并集）、holder?、ttl_minutes?、wait_timeout_ms?".into(),
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
        let wait_ms = a.wait_timeout_ms.unwrap_or(0);
        let outcome = if wait_ms > 0 {
            self.leases
                .acquire_with_wait(&token, &label, &scope, a.ttl_minutes, wait_ms)
                .await
        } else {
            self.leases.acquire(&token, &label, &scope, a.ttl_minutes)
        };
        let name_of = |id: &str| {
            device::find(id)
                .map(|d| d.name)
                .unwrap_or_else(|| id.to_string())
        };
        match outcome {
            Ok(l) => ok_text(format!(
                "已获租约 {}（{}，剩余 {} 分钟）：设备 {}{}",
                l.id,
                fmt_time(l.expires_at),
                remaining_minutes(&l),
                l.grants
                    .iter()
                    .map(|g| name_of(&g.device))
                    .collect::<Vec<_>>()
                    .join("、"),
                "\n租约=写权：exec_command / open_session 直接可用。用完 release_lease；长任务 renew_lease 顺延。"
            )),
            Err(AcquireError::Conflict(cs)) => {
                let lines: Vec<String> = cs
                    .iter()
                    .map(|c| {
                        format!(
                            "冲突 {} · 持有 {}（{}，剩余 {} 分钟）",
                            c.device_name,
                            c.holder,
                            c.lease_id,
                            (c.expires_at - chrono::Local::now()).num_minutes().max(0)
                        )
                    })
                    .collect();
                error_text(format!(
                    "申请被拒（{} 处冲突，未建立任何租约）：\n{}\n可等其释放/过期后重试，或带 wait_timeout_ms 排队等待。",
                    lines.len(),
                    lines.join("\n")
                ))
            }
            Err(AcquireError::Invalid(e)) => error_text(e),
        }
    }

    async fn renew_lease(&self, args: Value, principal: Option<&str>) -> Value {
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

    async fn release_lease(&self, args: Value, principal: Option<&str>, state: &AppState) -> Value {
        let Some(id) = args.get("lease_id").and_then(|v| v.as_str()) else {
            return error_text("缺少参数 lease_id".into());
        };
        let Some(token) = principal else {
            return error_text("释放须会话标识（token 参数或 Mcp-Session-Id 头）".into());
        };
        match self.leases.release(id, token) {
            Ok(l) => {
                // 联动收回该会话在租约设备上的 I/O 会话连接与影子缓冲
                let closed = self
                    .leases
                    .reclaim_sessions(token, &l.grants_ids(), state)
                    .await;
                let mut s = format!("已释放租约 {}（{}）。", l.id, l.label);
                if !closed.is_empty() {
                    s.push_str(&format!("顺带关闭其 I/O 通道连接: {}", closed.join("、")));
                }
                ok_text(s)
            }
            Err(e) => error_text(e),
        }
    }

    async fn list_my_leases(&self, principal: Option<&str>) -> Value {
        let Some(token) = principal else {
            return error_text("匿名会话无租约记录；initialize 取 token 或工具参数传 token".into());
        };
        let leases = self.leases.of_token(token);
        if leases.is_empty() {
            return ok_text("本会话当前无活跃租约。".into());
        }
        let name_of = |id: &str| {
            device::find(id)
                .map(|d| d.name)
                .unwrap_or_else(|| id.to_string())
        };
        let lines: Vec<String> = leases
            .iter()
            .map(|l| {
                format!(
                    "{} · 剩余 {} 分钟 · 设备 {}",
                    l.id,
                    remaining_minutes(l),
                    l.grants
                        .iter()
                        .map(|g| name_of(&g.device))
                        .collect::<Vec<_>>()
                        .join("、")
                )
            })
            .collect();
        ok_text(lines.join("\n"))
    }

    // ===== 管理层（is_admin_tool 隐藏，tools/call 可用）=====

    async fn topo_create(&self, args: Value) -> Value {
        let parsed: Result<CreateArgs, _> = serde_json::from_value(args);
        let Ok(a) = parsed else {
            return error_text("参数解析失败：需要 name（必填）、description?、members: [{device, note?, x?, y?}]、links: [{from, to, from_port?, to_port?, label?}]".into());
        };
        match topology::create(&a.name, &a.description, &a.members, &a.links) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!(
                    "已创建拓扑 {}（{}），成员 {} 项。成员引用被测设备（get_device 可查，未注册先 device_create）。",
                    t.name, t.id, t.members.len()
                ))
            }
            Err(e) => error_text(e),
        }
    }

    async fn topo_update(&self, args: Value) -> Value {
        let parsed: Result<UpdateArgs, _> = serde_json::from_value(args);
        let Ok(a) = parsed else {
            return error_text("参数解析失败：需要 topology（id 或名称），name?/description?/members?/links? 提供才更新".into());
        };
        match topology::update(
            &a.topo,
            a.name.as_deref(),
            a.description.as_deref(),
            a.members.as_deref(),
            a.links.as_deref(),
        ) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!(
                    "已更新拓扑 {}（{}），成员 {} 项。",
                    t.name,
                    t.id,
                    t.members.len()
                ))
            }
            Err(e) => error_text(e),
        }
    }

    async fn topo_delete(&self, args: Value) -> Value {
        let Some(topo_ref) = args.get("topology").and_then(|t| t.as_str()) else {
            return error_text("缺少参数 topology（拓扑 id 或名称）".into());
        };
        match topology::delete(topo_ref) {
            Ok(t) => {
                let _ = self.bus.send(());
                ok_text(format!("已删除拓扑 {}（{}）。", t.name, t.id))
            }
            Err(e) => error_text(e),
        }
    }

    async fn device_create(&self, args: Value, state: &AppState) -> Value {
        let Ok(a) = serde_json::from_value::<DeviceArgs>(args) else {
            return error_text("参数解析失败：需要 name（必填）、model?/location?、channels: [{type:serial,port,config?}|{type:ssh,host,port?,username,nickname?,auth}]".into());
        };
        match device::create(&a.into_input(), state) {
            Ok(d) => {
                let _ = self.bus.send(());
                ok_text(format!(
                    "已注册设备 {}（{}），通道 {} 条。拓扑成员/租约按设备引用（名称或 id 均可）。",
                    d.name,
                    d.id,
                    d.channels.len()
                ))
            }
            Err(e) => error_text(e),
        }
    }

    async fn device_update(&self, args: Value, state: &AppState) -> Value {
        let Some(dev_ref) = args
            .get("device")
            .and_then(|t| t.as_str())
            .map(str::to_string)
        else {
            return error_text("缺少参数 device（设备 id 或名称）".into());
        };
        let Ok(a) = serde_json::from_value::<DeviceArgs>(args) else {
            return error_text("参数解析失败：需要 name（必填）、model?/location?、channels: [{type:serial,port,config?}|{type:ssh,host,port?,username,nickname?,auth}]".into());
        };
        let Some(existing) = device::find(&dev_ref) else {
            return error_text(format!("设备不存在: {dev_ref}"));
        };
        match device::update(&existing.id, &a.into_input(), state) {
            Ok(d) => {
                let _ = self.bus.send(());
                ok_text(format!("已更新设备 {}（{}）。", d.name, d.id))
            }
            Err(e) => error_text(e),
        }
    }

    async fn device_delete(&self, args: Value, state: &AppState) -> Value {
        let Some(dev_ref) = args.get("device").and_then(|t| t.as_str()) else {
            return error_text("缺少参数 device（设备 id 或名称）".into());
        };
        let Some(d) = device::find(dev_ref) else {
            return error_text(format!("设备不存在: {dev_ref}"));
        };
        match device::delete(&d.id, state) {
            Ok(d) => {
                let _ = self.bus.send(());
                ok_text(format!("已删除设备 {}（{}）。", d.name, d.id))
            }
            Err(e) => error_text(e),
        }
    }

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
}

#[derive(Deserialize)]
struct CreateArgs {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    members: Vec<MemberInput>,
    #[serde(default)]
    links: Vec<LinkInput>,
}

#[derive(Deserialize)]
struct UpdateArgs {
    topo: String,
    name: Option<String>,
    description: Option<String>,
    members: Option<Vec<MemberInput>>,
    links: Option<Vec<LinkInput>>,
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
    /// >0 时冲突则服务端排队轮询等待（500ms 重试，上限 10 分钟），到期仍冲突才拒绝。
    #[serde(default)]
    wait_timeout_ms: Option<u64>,
}

/// device_create/update 的参数（device 字段仅 update 消费）。
#[derive(Deserialize)]
struct DeviceArgs {
    name: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    channels: Vec<device::Channel>,
}

impl DeviceArgs {
    fn into_input(self) -> device::DeviceInput {
        device::DeviceInput {
            name: self.name,
            model: self.model,
            location: self.location,
            channels: self.channels,
        }
    }
}

fn fmt_time(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%m-%d %H:%M").to_string()
}

/// 通道选择参数的 schema（I/O 工具共用）。
fn channel_schema() -> Value {
    json!({
        "channel": {
            "type": "string",
            "description": "通道选择：序号（get_device 输出的通道[n]，如 \"0\"）或标签子串（如 \"console\"、SSH 用户名）；省略=默认通道（首个串口，无串口取首个 SSH）"
        }
    })
}

impl McpExtension for TopoTools {
    /// 分叉声明：内置 serial_*/port_* 不进 tools/list（tools/call 照常分发）。
    fn builtin_tools_visible(&self) -> bool {
        false
    }

    /// 产品自报家门：initialize 的 serverInfo.name 报 devicerack。
    fn server_name(&self) -> Option<String> {
        Some("devicerack".into())
    }

    /// 管理面（设备/拓扑 CRUD）：tools/list 隐藏；tools/call 可用（已建立的自动化不受影响）。
    fn is_admin_tool(&self, name: &str) -> bool {
        matches!(
            name,
            "device_create"
                | "device_update"
                | "device_delete"
                | "topo_create"
                | "topo_update"
                | "topo_delete"
        )
    }

    fn tools(&self) -> Vec<Value> {
        vec![
            json!({
                "name": "get_topology",
                "description": "查看拓扑：不传 topology 列出全部（名称、id、成员数、描述，调试前先看这里选拓扑）；传 topology 给详情——成员设备清单（通道明细、在线状态、占用）与设备间连线（两端端口标签）。成员设备 id 或名称可直接用于 acquire_lease / exec_command。",
                "annotations": { "readOnlyHint": true },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topology": { "type": "string", "description": "拓扑 id 或名称；省略列出全部拓扑" }
                    }
                }
            }),
            json!({
                "name": "get_device",
                "description": "查看被测设备：不传 device 列出全部（名称、通道摘要、占用状态）；传 device 给详情——通道清单（带序号，I/O 工具的 channel 参数用）、当前租约占用。设备=被调试的一台机器（如一台交换机），通道=接入方式（串口控制台 + SSH 登录）。",
                "annotations": { "readOnlyHint": true },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "设备 id 或名称；省略列出全部设备" }
                    }
                }
            }),
            json!({
                "name": "list_my_leases",
                "description": "本会话的活跃租约清单（id、剩余时间、覆盖设备）。用于会话恢复或确认归还状态。",
                "annotations": { "readOnlyHint": true },
                "inputSchema": { "type": "object", "properties": {} }
            }),
            json!({
                "name": "acquire_lease",
                "description": "申请设备租约（设备级排他写权，all-or-nothing）：topology / devices / endpoints（可并用取并集）至少一项。冲突整体拒绝并返回各设备当前持有者与到期时间；给 wait_timeout_ms 则服务端排队等待。默认 30 分钟，到期自动释放，长任务用 renew_lease 顺延。租约即写权：拿到后 exec_command / open_session 直接可用，无需手动建立连接。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topology": { "type": "string", "description": "拓扑 id 或名称（成员设备并集）" },
                        "devices": { "type": "array", "items": { "type": "string" }, "description": "设备 id 或名称列表" },
                        "endpoints": { "type": "array", "items": { "type": "string" }, "description": "端口键列表（糖：解析到属主设备；未注册端口报错引导 device_create）" },
                        "holder": { "type": "string", "description": "持有者自报名（展示与审计用，如 claude/agent-1）" },
                        "ttl_minutes": { "type": "integer", "description": "有效分钟数（默认 30，上限可配）" },
                        "wait_timeout_ms": { "type": "integer", "description": "冲突时服务端排队等待的毫秒数（上限 600000；期间 500ms 轮询重试，持有者释放或过期即获得）" }
                    }
                }
            }),
            json!({
                "name": "renew_lease",
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
                "name": "release_lease",
                "description": "释放租约（用完即还）。仅持有会话可释放。释放时顺带关闭本会话在租约设备上建立的 I/O 通道连接。",
                "inputSchema": {
                    "type": "object",
                    "properties": { "lease_id": { "type": "string" } },
                    "required": ["lease_id"]
                }
            }),
            json!({
                "name": "exec_command",
                "description": "在设备通道上执行一条命令并一次调用拿完整输出（show/display/ping 等独立命令）。发送后等待响应：首字节最多等 wait_ms，其后 idle_ms 内无新数据即收尾。连接由平台复用（同通道后续调用不重连）。需要跨命令保持 CLI 状态（配置模式、交互式程序）用 open_session + send_input。须先 acquire_lease。",
                "annotations": { "readOnlyHint": false, "destructiveHint": true },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "设备 id 或名称" },
                        "command": { "type": "string", "description": "要执行的命令（单条，自动追加换行）" },
                        "wait_ms": { "type": "integer", "default": 3000, "description": "等待首字节的超时毫秒数" },
                        "idle_ms": { "type": "integer", "default": 250, "description": "收到首字节后无新数据多少毫秒视为输出结束" },
                        "max_bytes": { "type": "integer", "default": 65536, "description": "单次返回上限（按字符数计），超出截断并提示 read_output 补读" },
                        "channel": channel_schema()["channel"].clone()
                    },
                    "required": ["device", "command"]
                }
            }),
            json!({
                "name": "open_session",
                "description": "在设备通道上打开持久终端会话（须先 acquire_lease）：适用于需要保持 CLI 状态的场景——进入配置模式逐行下发、运行交互式程序、观察 debug 持续输出。会话即设备通道：后续 send_input/read_output/close_session 传相同的 device+channel 即定位本会话。连接与命令状态保持到 close_session 或租约结束。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "设备 id 或名称" },
                        "channel": channel_schema()["channel"].clone()
                    },
                    "required": ["device"]
                }
            }),
            json!({
                "name": "send_input",
                "description": "向会话发送数据并一次调用返回本条响应：wait_ms>0 时首字节最多等 wait_ms、其后 idle_ms 无新数据即收尾；wait_ms=0 只发不等（发密码、Ctrl+C、y 确认等，配 append_newline=false）。device+channel 须与 open_session 一致。截断时按提示 read_output 补读。",
                "annotations": { "readOnlyHint": false, "destructiveHint": true },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "设备 id 或名称（须与 open_session 的通道一致）" },
                        "data": { "type": "string", "description": "要发送的数据" },
                        "wait_ms": { "type": "integer", "default": 2000, "description": "等待首字节的超时；0 表示只发不等" },
                        "idle_ms": { "type": "integer", "default": 250, "description": "收到首字节后无新数据多少毫秒视为结束" },
                        "append_newline": { "type": "boolean", "default": true, "description": "是否自动追加换行（发密码等场景设 false）" },
                        "max_bytes": { "type": "integer", "default": 65536, "description": "单次返回上限" },
                        "channel": channel_schema()["channel"].clone()
                    },
                    "required": ["device", "data"]
                }
            }),
            json!({
                "name": "read_output",
                "description": "游标读会话输出（辅助工具，通常不需要）：(1) send_input/exec_command 返回截断提示时传 since=<cursor> 补读剩余；(2) 观察 debug/monitor 持续输出时轮询（timeout_ms 等新数据）；(3) since=0 从头读。非破坏性：读后可再读，cursor 记录已读位置。",
                "annotations": { "readOnlyHint": true },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "会话的设备寻址" },
                        "since": { "type": "string", "description": "游标（上次返回的 cursor 数字值）；省略=只读新数据；\"0\"=从头读" },
                        "timeout_ms": { "type": "integer", "default": 0, "description": "无新数据时等待毫秒数；0 立即返回" },
                        "max_bytes": { "type": "integer", "default": 65536, "description": "单次返回上限" },
                        "channel": channel_schema()["channel"].clone()
                    },
                    "required": ["device"]
                }
            }),
            json!({
                "name": "close_session",
                "description": "关闭持久终端会话（释放该通道的连接持有；末位持有者才真正断开连接）。不释放租约；租约用 release_lease。device+channel 须与 open_session 一致。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "会话的设备寻址" },
                        "channel": channel_schema()["channel"].clone()
                    },
                    "required": ["device"]
                }
            }),
            // ===== 管理面（is_admin_tool 声明 → tools/list 隐藏，tools/call 可用）=====
            json!({
                "name": "device_create",
                "description": "【管理】注册被测设备。channels 为接入通道：{type:serial,port=端口键,config?}（本机 COM4 或级联键 devB::COM4）与 {type:ssh,host,port?,username,nickname?,auth}（内联连接配置；同一端口/主机凭据只能属于一台设备）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "设备名（同表唯一，如「车间交换机#3」）" },
                        "model": { "type": "string", "description": "型号（可选）" },
                        "location": { "type": "string", "description": "位置（可选）" },
                        "channels": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": { "type": "string", "enum": ["serial", "ssh"] },
                                    "port": { "type": "string", "description": "端口：type=serial 时为端口键（本机 COM4 或级联键 devB::COM4）；type=ssh 时为 TCP 端口号（数字，缺省 22）" },
                                    "host": { "type": "string", "description": "type=ssh 时目标主机" },
                                    "username": { "type": "string", "description": "type=ssh 时的登录用户" },
                                    "nickname": { "type": "string", "description": "type=ssh 时的展示昵称（可选）" },
                                    "auth": {
                                        "type": "object",
                                        "description": "type=ssh 时的认证：{type:agent} / {type:password,password} / {type:key,key_path}"
                                    }
                                },
                                "required": ["type"]
                            }
                        }
                    },
                    "required": ["name"]
                }
            }),
            json!({
                "name": "device_update",
                "description": "【管理】更新被测设备（name/model/location/channels 提供才更新，channels 提供时整体替换）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "device": { "type": "string", "description": "设备 id 或名称" },
                        "name": { "type": "string" },
                        "model": { "type": "string" },
                        "location": { "type": "string" },
                        "channels": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": { "type": "string", "enum": ["serial", "ssh"] },
                                    "port": { "type": "string", "description": "serial=端口键；ssh=TCP 端口号（数字，缺省 22）" },
                                    "host": { "type": "string" },
                                    "username": { "type": "string" },
                                    "nickname": { "type": "string" },
                                    "auth": { "type": "object" }
                                },
                                "required": ["type"]
                            }
                        }
                    },
                    "required": ["device", "name"]
                }
            }),
            json!({
                "name": "device_delete",
                "description": "【管理】删除被测设备（被拓扑引用时拒绝并列出拓扑）。不影响底层端口与 SSH 凭据。",
                "inputSchema": {
                    "type": "object",
                    "properties": { "device": { "type": "string", "description": "设备 id 或名称" } },
                    "required": ["device"]
                }
            }),
            json!({
                "name": "topo_create",
                "description": "【管理】创建拓扑。成员=被测设备引用（get_device 可查，同一设备可加入多个拓扑），links 描述设备间连线（拓扑图渲染用），两端可标物理端口（from_port/to_port，如 GE1/1/1、eth0）。",
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
                                    "device": { "type": "string", "description": "被测设备 id 或名称（get_device 可查）" },
                                    "note": { "type": "string", "description": "备注，如「被测主板」（可选）" },
                                    "x": { "type": "number", "description": "画布横坐标（可选，Web 图编辑器位置）" },
                                    "y": { "type": "number", "description": "画布纵坐标（可选）" }
                                },
                                "required": ["device"]
                            }
                        },
                        "links": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "from": { "type": "string", "description": "成员设备 id 或名称" },
                                    "to": { "type": "string", "description": "成员设备 id 或名称" },
                                    "from_port": { "type": "string", "description": "from 端设备上的物理端口标签，如 GE1/1/1（可选）" },
                                    "to_port": { "type": "string", "description": "to 端设备上的物理端口标签，如 eth0（可选）" },
                                    "label": { "type": "string", "description": "连线说明（可选）" }
                                },
                                "required": ["from", "to"]
                            }
                        }
                    },
                    "required": ["name"]
                }
            }),
            json!({
                "name": "topo_update",
                "description": "【管理】更新拓扑：name/description/members/links 提供才更新，members/links 提供时整体替换（须全部合法；members 替换后指向已移除成员的存量连线会随之剪除）。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "topology": { "type": "string", "description": "拓扑 id 或名称" },
                        "name": { "type": "string" },
                        "description": { "type": "string" },
                        "members": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "device": { "type": "string" },
                                    "note": { "type": "string" },
                                    "x": { "type": "number" },
                                    "y": { "type": "number" }
                                },
                                "required": ["device"]
                            }
                        },
                        "links": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "from": { "type": "string" },
                                    "to": { "type": "string" },
                                    "from_port": { "type": "string" },
                                    "to_port": { "type": "string" },
                                    "label": { "type": "string" }
                                },
                                "required": ["from", "to"]
                            }
                        }
                    },
                    "required": ["topology"]
                }
            }),
            json!({
                "name": "topo_delete",
                "description": "【管理】删除拓扑（仅删定义，不动设备与端口）。",
                "inputSchema": {
                    "type": "object",
                    "properties": { "topology": { "type": "string", "description": "拓扑 id 或名称" } },
                    "required": ["topology"]
                }
            }),
        ]
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        principal: Option<&'a str>,
        state: &'a AppState,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>> {
        Box::pin(async move {
            match name {
                // 发现
                "get_topology" => Some(self.get_topology(args, state).await),
                "get_device" => Some(self.get_device(args, state).await),
                "list_my_leases" => Some(self.list_my_leases(principal).await),
                // 租约
                "acquire_lease" => Some(self.acquire_lease(args, principal).await),
                "renew_lease" => Some(self.renew_lease(args, principal).await),
                "release_lease" => Some(self.release_lease(args, principal, state).await),
                // 通道 I/O
                "exec_command" => Some(self.exec_command(args, principal, state).await),
                "open_session" => Some(self.open_session(args, principal, state).await),
                "send_input" => Some(self.send_input(args, principal, state).await),
                "read_output" => Some(self.read_output(args, principal, state).await),
                "close_session" => Some(self.close_session(args, principal, state).await),
                // 管理（隐藏面，tools/call 可用）
                "topo_create" => Some(self.topo_create(args).await),
                "topo_update" => Some(self.topo_update(args).await),
                "topo_delete" => Some(self.topo_delete(args).await),
                "device_create" => Some(self.device_create(args, state).await),
                "device_update" => Some(self.device_update(args, state).await),
                "device_delete" => Some(self.device_delete(args, state).await),
                _ => None,
            }
        })
    }

    /// 写闸：保留（agent 猜用内置工具名时仍受闸；分叉面 I/O 在 session 层自查租约）。
    fn intercept<'a>(
        &'a self,
        _name: &'a str,
        args: Value,
        principal: Option<&'a str>,
        state: &'a AppState,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>> {
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

    /// 脚本写闸：逐次检查闭包（与 intercept 共用租约闸）。
    fn script_gate(
        &self,
        principal: Option<&str>,
        _state: &AppState,
    ) -> Option<ss_core::WriteGateFn> {
        if !self.leases.gate_enabled() {
            return None;
        }
        // gate 需要 'static 闭包（脚本线程 Send）——把 token clone 进去
        let token = principal?.to_string();
        let leases = Arc::clone(&self.leases);
        Some(Arc::new(move |port: &str| leases.gate(Some(&token), port)))
    }
}

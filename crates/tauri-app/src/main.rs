// release 模式 Windows 用 GUI 子系统：双击不弹 cmd 黑窗。
// debug 保留 console，方便看 tracing/panic。
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

//! Serial Studio Tauri 桌面应用（控制面）。
//!
//! 架构（控制面/数据面分离）：
//! - 控制面（本文件）：Tauri 命令管理配置 + 服务生命周期（ServiceSupervisor）。
//! - 数据面（ss-server）：WS/MCP/Telnet，由 Supervisor 启停，共享 AppState。
//!
//! 热重启：改监听配置 → invoke apply_settings → Supervisor.stop()+start()，
//! 不重启程序，串口连接/宏保留（AppState 共享，只换 listener）。

use clap::Parser;
use ss_core::SessionId;
use ss_server::AppState;
use tauri::{ipc::{Channel, InvokeResponseBody}, Emitter, Manager};
use ss_server::settings::Settings;
use ss_server::supervisor::{ServiceStatus, ServiceSupervisor};
use ss_server::create_state;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[derive(Parser)]
#[command(name = "serial-studio", version, about = "Serial Studio 桌面应用")]
struct Args {
    /// 禁用 GUI，以 headless 模式运行（仅后台服务）
    #[arg(long)]
    no_gui: bool,
}

fn main() {
    // windows_subsystem="windows" 下 stdout 默认无效。从终端启动时 attach 父 console
    // 恢复 stdout（--no-gui 或终端跑能看日志）；双击无父 console，静默跳过。
    #[cfg(target_os = "windows")]
    let _ = attach_parent_console();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    if args.no_gui {
        run_headless().expect("headless 运行失败");
    } else {
        run_gui();
    }
}

// ===== 控制面：Tauri 命令（前端 invoke，不经 WS）=====

#[tauri::command]
async fn get_settings() -> Result<Settings, String> {
    Ok(ss_server::settings::load())
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    ss_server::settings::save(&settings)?;
    state
        .enable_scripting
        .store(settings.enable_scripting, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 应用配置：写 settings.json + 重启服务使新监听地址/端口生效。
/// 串口连接和宏保留（AppState 跨重启共享）。
#[tauri::command]
async fn apply_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: Settings,
    supervisor: tauri::State<'_, Arc<ServiceSupervisor>>,
) -> Result<(), String> {
    ss_server::settings::save(&settings)?;
    state
        .enable_scripting
        .store(settings.enable_scripting, std::sync::atomic::Ordering::Relaxed);
    match supervisor.restart(&settings).await {
        Ok(()) => {
            let _ = app.emit("service-status", serde_json::json!({ "running": true }));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "service-status",
                serde_json::json!({ "running": false, "error": e.clone() }),
            );
            Err(e)
        }
    }
}

#[tauri::command]
async fn service_status(
    supervisor: tauri::State<'_, Arc<ServiceSupervisor>>,
) -> Result<ServiceStatus, String> {
    Ok(supervisor.status().await)
}

/// 加载用户宏（exe 同目录 macros.json）。宏是用户配置，跟着用户走，不存服务端状态。
#[tauri::command]
async fn load_macros() -> Result<std::collections::BTreeMap<String, ss_core::Macro>, String> {
    Ok(ss_server::macros_store::load())
}

/// 保存用户宏到 macros.json。
#[tauri::command]
async fn save_macros(
    macros: std::collections::BTreeMap<String, ss_core::Macro>,
) -> Result<(), String> {
    ss_server::macros_store::save(&macros)
}

/// 加载用户脚本(exe 同目录 scripts.json)。与宏一样是用户配置,跟着用户走。
#[tauri::command]
async fn load_scripts() -> Result<std::collections::BTreeMap<String, ss_core::Script>, String> {
    Ok(ss_server::scripts_store::load())
}

/// 脚本编写 SKILL 全文(嵌入二进制;前端「脚本指南」对话框展示 / 复制给外部 Agent)。
#[tauri::command]
async fn get_script_skill() -> Result<String, String> {
    Ok(ss_server::SCRIPT_SKILL.into())
}

/// 保存用户脚本到 scripts.json。
#[tauri::command]
async fn save_scripts(
    scripts: std::collections::BTreeMap<String, ss_core::Script>,
) -> Result<(), String> {
    ss_server::scripts_store::save(&scripts)
}

// ===== 数据面：Tauri command（本地模式 IPC，与 axum WS 是同一核心域的两个 adapter）=====

/// 窗口级会话注册表：把 Tauri 窗口 label 映射到串口占有份额归属的 SessionId。
/// open/close 命令按调用窗口取/建会话；窗口销毁时 take 出会话并 release_all。
#[derive(Default)]
struct SessionRegistry {
    map: Mutex<HashMap<String, SessionId>>,
}

impl SessionRegistry {
    fn get_or_create(&self, label: &str) -> SessionId {
        let mut map = self.map.lock().unwrap();
        *map.entry(label.to_string()).or_insert_with(SessionId::next)
    }
    fn take(&self, label: &str) -> Option<SessionId> {
        self.map.lock().unwrap().remove(label)
    }
    /// 当前所有本地窗口的会话(用于 force_close_others 的 keep 集合)。
    fn all(&self) -> HashSet<SessionId> {
        self.map.lock().unwrap().values().cloned().collect()
    }
}

/// 本地模式字节直传通道注册表：(窗口 label, 端口) → Channel。
///
/// 与 SessionRegistry 同构（都按 window.label 索引），让 Destroyed 清理一行搞定。
/// DataReceived 按 port 广播到所有登记窗口——当前只有主窗口用 LocalTransport，
/// 远程窗口走 WS 不登记 channel，故 send 返回 0 时静默丢弃（本地不关心）。
#[derive(Default)]
struct PortChannels {
    // window_label → (port → channel)
    map: Mutex<HashMap<String, HashMap<String, Channel<InvokeResponseBody>>>>,
}

impl PortChannels {
    /// 登记。同 (window,port) 重复登记覆盖前者（前端 reload 重连场景）。
    fn register(&self, window_label: &str, port: &str, channel: Channel<InvokeResponseBody>) {
        let mut map = self.map.lock().unwrap();
        map.entry(window_label.to_string())
            .or_default()
            .insert(port.to_string(), channel);
    }

    /// 按 port 广播原始字节到所有登记窗口。返回命中窗口数。
    /// 锁内只收集 Channel clone（Arc 内部，廉价），立即放锁再 send，
    /// 避免 Channel::send 的 webview eval 在锁内阻塞 register/remove。
    fn send(&self, port: &str, data: Vec<u8>) -> usize {
        let targets: Vec<Channel<InvokeResponseBody>> = {
            let map = self.map.lock().unwrap();
            map.values().filter_map(|w| w.get(port).cloned()).collect()
        };
        let len = targets.len();
        if len == 0 {
            return 0;
        }
        let mut data = Some(data);
        for (i, ch) in targets.iter().enumerate() {
            // 最后一个窗口吃原始 data（move），其余 clone。实际单窗口恒为 1 个。
            let payload = if i == len - 1 {
                data.take().unwrap()
            } else {
                data.as_ref().unwrap().clone()
            };
            // send 失败（webview 已死）→ Err，静默忽略；不阻断其它窗口
            let _ = ch.send(InvokeResponseBody::Raw(payload));
        }
        len
    }

    /// 摘某窗口某端口（close_port_stream）。
    fn remove_port(&self, window_label: &str, port: &str) {
        if let Some(w) = self.map.lock().unwrap().get_mut(window_label) {
            w.remove(port);
        }
    }

    /// 摘所有窗口下该端口（PortClosed 全局关闭兜底）。
    fn remove_port_all(&self, port: &str) {
        for w in self.map.lock().unwrap().values_mut() {
            w.remove(port);
        }
    }

    /// 摘某窗口全部通道（Destroyed）。
    fn remove_window(&self, window_label: &str) {
        self.map.lock().unwrap().remove(window_label);
    }
}

#[tauri::command]
async fn list_ports(state: tauri::State<'_, AppState>) -> Result<Vec<ss_server::PortView>, String> {
    Ok(ss_server::list_ports_with_meta(&state).await)
}

/// 打开端口并订阅字节流。
/// 顺序：先 register channel 再 acquire——确保端口产生数据前通道已就位，不丢首批；
/// acquire 失败时回滚 register，防悬挂通道。
#[tauri::command]
async fn open_port_stream(
    sessions: tauri::State<'_, SessionRegistry>,
    channels: tauri::State<'_, PortChannels>,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    port: String,
    config: ss_core::SerialConfig,
    on_event: Channel<InvokeResponseBody>,
) -> Result<ss_core::AcquireResult, String> {
    let session = sessions.get_or_create(window.label());
    let label = window.label().to_string();
    channels.register(&label, &port, on_event);
    match state.manager.acquire(port.clone(), config, session).await {
        Ok(result) => Ok(result),
        Err(e) => {
            channels.remove_port(&label, &port);
            Err(e.to_string())
        }
    }
}

/// 关闭订阅并释放持有。先 release 再 remove：
/// release 期间仍在途的数据能被通道消费；末位释放触发 PortClosed 会兜底 remove_port_all。
#[tauri::command]
async fn close_port_stream(
    sessions: tauri::State<'_, SessionRegistry>,
    channels: tauri::State<'_, PortChannels>,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    port: String,
) -> Result<ss_core::ReleaseOutcome, String> {
    let session = sessions.get_or_create(window.label());
    let outcome = state
        .manager
        .release(&port, session)
        .await
        .map_err(|e| e.to_string())?;
    channels.remove_port(window.label(), &port);
    Ok(outcome)
}

/// 强制关闭:只踢远程持有者(线上),保留本地窗口的持有。仅本地 UI 提供(不暴露给 WS)。
#[tauri::command]
async fn force_close_port(
    sessions: tauri::State<'_, SessionRegistry>,
    state: tauri::State<'_, AppState>,
    port: String,
) -> Result<(), String> {
    let local = sessions.all();
    let kicked = state
        .manager
        .force_close_others(&port, &local)
        .await
        .map_err(|e| e.to_string())?;
    // 点对点断开被踢的 WS 连接(经 AppState.closers,必送达)
    let mut closers = state.closers.lock().unwrap();
    for s in &kicked {
        if let Some(tx) = closers.remove(s) {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// 设置端口别名（""/None = 清除）。写 exe 同目录 ports.json 并广播元数据变更，
/// 让已连的远程 WS 客户端刷新。open 命令不碰磁盘——别名一律走此入口。
#[tauri::command]
async fn set_port_alias(
    state: tauri::State<'_, AppState>,
    port: String,
    alias: Option<String>,
) -> Result<(), String> {
    ss_server::set_alias_and_notify(&state, &port, alias)
}

/// 弹出原生保存对话框让用户选位置，写 JSON 文本。桌面端导出用（Web 走浏览器 blob 下载）。
/// 返回 true=已保存，false=用户取消（不报错）。
#[tauri::command]
async fn save_json_file(default_name: String, content: String) -> Result<bool, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file()
        .await;
    match file {
        Some(handle) => {
            handle.write(content.as_bytes()).await.map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
async fn write_port(
    state: tauri::State<'_, AppState>,
    port: String,
    data: String,
) -> Result<usize, String> {
    state
        .manager
        .write(port, bytes::Bytes::from(data.into_bytes()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_macro(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    name: String,
    port: String,
    r#macro: ss_core::Macro,
    run_id: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    let app = app.clone();
    // 注册停止信号(复用 script_runs 表,owner=Window):关窗时一并 abort 防 orphan;stop_macro set flag 退出。
    let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.script_runs.lock().unwrap().insert(
        run_id.clone(),
        ss_server::ScriptRun { abort: abort.clone(), owner: ss_server::ScriptOwner::Window(window.label().to_string()) },
    );
    let script_runs = state.script_runs.clone();
    let run_id_for_cleanup = run_id.clone();
    tokio::spawn(async move {
        let result = ss_core::run_macro(&port, &r#macro, &manager, abort).await;
        script_runs.lock().unwrap().remove(&run_id_for_cleanup);
        let (success, message) = match result {
            Ok(()) => (true, "完成".to_string()),
            Err(ss_core::MacroError::Aborted) => (false, ss_core::MacroError::Aborted.display_message()),
            Err(e) => (false, e.to_string()),
        };
        let _ = app.emit(
            "macro-result",
            serde_json::json!({ "run_id": run_id, "name": name, "success": success, "message": message }),
        );
    });
    Ok(())
}

/// 运行 JS 脚本(本地主权路径,不查 enable_scripting——那是远程 WS/MCP 的闸门)。
/// state.manager 是 Arc<SerialManager>,run_script 正好收 Arc,直接 move。
#[tauri::command]
async fn run_script(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    name: String,
    port: String,
    script: ss_core::Script,
    args: std::collections::HashMap<String, String>,
    run_id: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    let app = app.clone();
    // 注册停止信号(归属本窗口,关窗时一并 abort 防 orphan)+ stop_script set flag → sleep 分段轮询退出。
    let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.script_runs.lock().unwrap().insert(
        run_id.clone(),
        ss_server::ScriptRun { abort: abort.clone(), owner: ss_server::ScriptOwner::Window(window.label().to_string()) },
    );
    let script_runs = state.script_runs.clone();
    let run_id_for_cleanup = run_id.clone();
    tokio::spawn(async move {
        // None 超时 = 无总时长上限(长跑复现);停止靠 abort + sleep 分段轮询。
        let result = ss_core::run_script_with_timeout(&port, &script.code, manager, None, args, &run_id, abort).await;
        script_runs.lock().unwrap().remove(&run_id_for_cleanup);
        let (success, message) = match result {
            Ok(()) => (true, "完成".to_string()),
            // Aborted 用 display_message(「已停止」)对齐 WS 路径;其它本地保留 Display 详情。
            Err(ss_core::ScriptError::Aborted) => (false, ss_core::ScriptError::Aborted.display_message()),
            Err(e) => (false, e.to_string()),
        };
        let _ = app.emit(
            "script-result",
            serde_json::json!({ "run_id": run_id, "name": name, "success": success, "message": message }),
        );
    });
    Ok(())
}

/// 停止运行中的脚本:set 对应 run_id 的 abort flag,脚本经 sleep 分段轮询退出(秒级)。
#[tauri::command]
async fn stop_script(state: tauri::State<'_, AppState>, run_id: String) -> Result<(), String> {
    let flag = state.script_runs.lock().unwrap().get(&run_id).map(|r| r.abort.clone());
    match flag {
        Some(f) => f.store(true, std::sync::atomic::Ordering::Relaxed),
        None => tracing::warn!("stop_script: run_id {} 未找到(已结束?)", run_id),
    }
    Ok(())
}

/// 停止运行中的宏:与 stop_script 同表(script_runs),set abort flag → 宏经 Delay 分段/Expect select! 退出。
#[tauri::command]
async fn stop_macro(state: tauri::State<'_, AppState>, run_id: String) -> Result<(), String> {
    let flag = state.script_runs.lock().unwrap().get(&run_id).map(|r| r.abort.clone());
    match flag {
        Some(f) => f.store(true, std::sync::atomic::Ordering::Relaxed),
        None => tracing::warn!("stop_macro: run_id {} 未找到(已结束?)", run_id),
    }
    Ok(())
}

/// 本地模式数据流：订阅 EventBus，把 SerialEvent 转成 Tauri event 推给前端。
/// 与 axum ws.rs 的事件转发是同一 EventBus 的两个出口（一个走 WS，一个走 IPC）。
/// 另订阅 meta_bus：别名等元数据变更时 emit "ports-meta-changed"，让本地 UI 刷新列表
/// （远程客户端改了别名，本地桌面 UI 也能及时同步，不必等下一个串口事件）。
fn spawn_event_emitter(
    app: tauri::AppHandle,
    event_bus: std::sync::Arc<ss_core::EventBus>,
    meta_bus: std::sync::Arc<tokio::sync::broadcast::Sender<()>>,
) {
    let app_meta = app.clone(); // 第二个 spawn 用；下面的 async move 会 move 掉 app
    let mut rx = event_bus.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match event {
                ss_core::SerialEvent::DataReceived { port, data } => {
                    // 本地字节直传：per-(window,port) channel 二进制快路径。
                    // 无 channel（端口仅 WS/telnet 持有）→ send 返回 0，静默丢弃。
                    if let Some(c) = app.try_state::<PortChannels>() {
                        c.send(&port, data);
                    }
                }
                ss_core::SerialEvent::PortOpened { port } => {
                    let _ = app.emit("serial-opened", &port);
                }
                ss_core::SerialEvent::PortClosed { port } => {
                    // 端口全局关闭：摘所有窗口该端口通道，防悬挂发送到已无效订阅
                    if let Some(c) = app.try_state::<PortChannels>() {
                        c.remove_port_all(&port);
                    }
                    let _ = app.emit("serial-closed", &port);
                }
                ss_core::SerialEvent::PortDisconnected { port } => {
                    // 设备断开:保留 per-(window,port) 通道(重连后字节流接回同一 tab 的 scrollback),
                    // 仅通知前端标"已断开"。区别于 PortClosed 的 remove_port_all(那是真删 tab)。
                    let _ = app.emit("serial-disconnected", &port);
                }
                ss_core::SerialEvent::HoldersChanged { port, holders } => {
                    let _ = app.emit(
                        "serial-holders",
                        serde_json::json!({ "port": port, "holders": holders }),
                    );
                }
                ss_core::SerialEvent::Error { port, message } => {
                    let _ = app.emit(
                        "serial-error",
                        serde_json::json!({ "message": format!("{}: {}", port, message) }),
                    );
                }
                ss_core::SerialEvent::ScriptLog { run_id, message, .. } => {
                    // 脚本 log() 输出:按 run_id 路由到对应运行实例的日志区(port 不转发)。
                    let _ = app.emit(
                        "script-log",
                        serde_json::json!({ "run_id": run_id, "message": message }),
                    );
                }
            }
        }
    });

    // 元数据（别名）变更 → 通知本地前端刷新端口列表
    let mut meta_rx = meta_bus.subscribe();
    tauri::async_runtime::spawn(async move {
        // 显式 match：Lagged 继续（积压时不退，否则一次 lag 就永久断本地 meta 通知），
        // 与 ws.rs 的 meta_task 一致。Closed 才退出。
        loop {
            match meta_rx.recv().await {
                Ok(()) => {
                    let _ = app_meta.emit("ports-meta-changed", ());
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Headless：Supervisor 启动 + 等 ctrl_c + 停止。
fn run_headless() -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let state = create_state();
        let supervisor = ServiceSupervisor::new(state);
        let settings = ss_server::settings::load();
        supervisor.start(&settings).await.map_err(anyhow::Error::msg)?;
        tracing::info!("headless 运行中，Ctrl+C 退出");
        shutdown_signal().await;
        supervisor.stop().await;
        tracing::info!("已关闭");
        Ok::<(), anyhow::Error>(())
    })
}

/// GUI：Tauri 窗口 + Supervisor 管理服务（支持热重启）。
fn run_gui() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let label = window.label().to_string();
                // 先摘本窗口通道，防后续 DataReceived 发到已销毁 webview
                if let Some(channels) = app.try_state::<PortChannels>() {
                    channels.remove_window(&label);
                }
                let mgr = app.try_state::<AppState>().map(|s| s.manager.clone());
                let session = app
                    .try_state::<SessionRegistry>()
                    .and_then(|s| s.take(&label));
                if let (Some(mgr), Some(session)) = (mgr, session) {
                    // 本窗口启动的脚本跟着停(防 orphan):同步 set AtomicBool(不需 await),在 spawn 前、
                    // app 还有效时做;spawn 只负责 release_all(异步)。
                    if let Some(st) = app.try_state::<AppState>() {
                        let orphan_aborts: Vec<std::sync::Arc<std::sync::atomic::AtomicBool>> = st
                            .script_runs
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|(_, r)| matches!(&r.owner, ss_server::ScriptOwner::Window(w) if w == &label))
                            .map(|(_, r)| r.abort.clone())
                            .collect();
                        for f in orphan_aborts {
                            f.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    tauri::async_runtime::spawn(async move {
                        let released = mgr.release_all(session).await;
                        if !released.is_empty() {
                            tracing::info!(
                                "窗口 {:?} 销毁，释放 {} 个持有端口",
                                session,
                                released.len()
                            );
                        }
                    });
                }
            }
        })
        .setup(|app| {
            let state = create_state();
            let supervisor = Arc::new(ServiceSupervisor::new(state.clone()));
            let settings = ss_server::settings::load();

            // 窗口级 state 必须在 spawn_event_emitter 之前 manage：
            // emitter 的 DataReceived 分支用 try_state::<PortChannels>()
            app.manage(SessionRegistry::default());
            app.manage(PortChannels::default());

            // 本地模式数据流：原始事件 → per-(window,port) channel 字节直传（A/B：跳过合批测延迟）
            spawn_event_emitter(app.handle().clone(), state.event_bus.clone(), state.meta_bus.clone());

            // 启动初始服务（异步，不阻塞 setup）。成功/失败都 emit 给前端，
            // 失败时（端口被占用等）界面出持久横幅，避免“服务没起来用户不知道”。
            let sup = supervisor.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match sup.start(&settings).await {
                    Ok(()) => {
                        let _ = app_handle.emit("service-status", serde_json::json!({ "running": true }));
                    }
                    Err(e) => {
                        tracing::error!("服务启动失败: {}", e);
                        let _ = app_handle.emit(
                            "service-status",
                            serde_json::json!({ "running": false, "error": e }),
                        );
                    }
                }
            });

            app.manage(state);
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            apply_settings,
            service_status,
            load_macros,
            save_macros,
            load_scripts,
            save_scripts,
            get_script_skill,
            list_ports,
            open_port_stream,
            close_port_stream,
            force_close_port,
            set_port_alias,
            write_port,
            run_macro,
            run_script,
            stop_script,
            stop_macro,
            save_json_file,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.unwrap();
    };
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .unwrap()
            .recv()
            .await;
    };
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.unwrap();
}

/// 在 windows_subsystem="windows" 下把 stdout/stderr 接回父进程的 console。
/// 双击启动时无父 console（AttachConsole 失败）→ 返回 false，程序继续无日志输出。
/// 从 cmd/PowerShell 启动 → attach 成功，日志正常显示。
#[cfg(target_os = "windows")]
fn attach_parent_console() -> bool {
    use std::ptr;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileA, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };

    unsafe {
        let existing = GetStdHandle(STD_OUTPUT_HANDLE);
        if !existing.is_null() && existing != INVALID_HANDLE_VALUE {
            return true;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return false;
        }
        let name = b"CONOUT$\0";
        let out = CreateFileA(
            name.as_ptr(),
            (GENERIC_READ | GENERIC_WRITE) as u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        );
        if out.is_null() || out == INVALID_HANDLE_VALUE {
            return false;
        }
        SetStdHandle(STD_OUTPUT_HANDLE, out);
        SetStdHandle(STD_ERROR_HANDLE, out);
        true
    }
}

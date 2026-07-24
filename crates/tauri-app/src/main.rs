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
use ss_server::AppState;
use tauri::{Emitter, Manager};
use ss_server::settings::Settings;
use ss_server::supervisor::{ServiceStatus, ServiceSupervisor};
use ss_server::create_state;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "ss-tauri", version, about = "Serial Studio 桌面应用")]
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
async fn save_settings(settings: Settings) -> Result<(), String> {
    ss_server::settings::save(&settings)
}

/// 应用配置：写 settings.json + 重启服务使新监听地址/端口生效。
/// 串口连接和宏保留（AppState 跨重启共享）。
#[tauri::command]
async fn apply_settings(
    settings: Settings,
    supervisor: tauri::State<'_, Arc<ServiceSupervisor>>,
) -> Result<(), String> {
    ss_server::settings::save(&settings)?;
    supervisor.restart(&settings).await
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

/// 打开远程窗口（VS Code 风）：新 WebviewWindow 连接指定远程服务。
/// URL 带 ?remote=host:port，新窗口前端据此切远程模式。同地址已开则聚焦。
#[tauri::command]
async fn open_remote_window(app: tauri::AppHandle, host: String, port: u16) -> Result<(), String> {
    // label 只允许字母数字 / - / : / _，host 的 "." 要替换掉
    let label = format!("remote-{}-{}", host.replace('.', "_"), port);
    if let Some(w) = app.get_webview_window(&label) {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("index.html?remote={}:{}", host, port);
    let title = format!("Serial Studio · 远程 {}:{}", host, port);
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 640.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== 数据面：Tauri command（本地模式 IPC，与 axum WS 是同一核心域的两个 adapter）=====

#[tauri::command]
async fn list_ports(state: tauri::State<'_, AppState>) -> Result<Vec<ss_core::PortInfo>, String> {
    Ok(state.manager.list_ports().await)
}

#[tauri::command]
async fn open_port(
    state: tauri::State<'_, AppState>,
    port: String,
    config: ss_core::SerialConfig,
) -> Result<(), String> {
    state.manager.open(port, config).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_port(state: tauri::State<'_, AppState>, port: String) -> Result<(), String> {
    state.manager.close(port).await.map_err(|e| e.to_string())
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
    state: tauri::State<'_, AppState>,
    name: String,
    port: String,
    r#macro: ss_core::Macro,
) -> Result<(), String> {
    let manager = state.manager.clone();
    let app = app.clone();
    tokio::spawn(async move {
        let result = ss_core::run_macro(&port, &r#macro, &manager).await;
        let (success, message) = match result {
            Ok(()) => (true, "完成".to_string()),
            Err(e) => (false, e.to_string()),
        };
        let _ = app.emit(
            "macro-result",
            serde_json::json!({ "name": name, "success": success, "message": message }),
        );
    });
    Ok(())
}

/// 本地模式数据流：订阅 EventBus，把 SerialEvent 转成 Tauri event 推给前端。
/// 与 axum ws.rs 的事件转发是同一 EventBus 的两个出口（一个走 WS，一个走 IPC）。
fn spawn_event_emitter(app: tauri::AppHandle, event_bus: std::sync::Arc<ss_core::EventBus>) {
    let mut rx = event_bus.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match event {
                ss_core::SerialEvent::DataReceived { port, data } => {
                    let _ = app.emit(
                        "serial-data",
                        serde_json::json!({ "port": port, "data": hex::encode(&data) }),
                    );
                }
                ss_core::SerialEvent::PortOpened { port } => {
                    let _ = app.emit("serial-opened", &port);
                }
                ss_core::SerialEvent::PortClosed { port } => {
                    let _ = app.emit("serial-closed", &port);
                }
                ss_core::SerialEvent::Error { port, message } => {
                    let _ = app.emit(
                        "serial-error",
                        serde_json::json!({ "message": format!("{}: {}", port, message) }),
                    );
                }
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
        .setup(|app| {
            let state = create_state();
            let supervisor = Arc::new(ServiceSupervisor::new(state.clone()));
            let settings = ss_server::settings::load();

            // 本地模式数据流：EventBus → Tauri event（推给前端 LocalTransport）
            spawn_event_emitter(app.handle().clone(), state.event_bus.clone());

            // 启动初始服务（异步，不阻塞 setup）
            let sup = supervisor.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sup.start(&settings).await {
                    tracing::error!("服务启动失败: {}", e);
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
            open_remote_window,
            list_ports,
            open_port,
            close_port,
            write_port,
            run_macro,
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

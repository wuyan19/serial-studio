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
use tauri::Manager;
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
            let supervisor = Arc::new(ServiceSupervisor::new(state));
            let settings = ss_server::settings::load();

            // 启动初始服务（异步，不阻塞 setup）
            let sup = supervisor.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sup.start(&settings).await {
                    tracing::error!("服务启动失败: {}", e);
                }
            });

            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            apply_settings,
            service_status,
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

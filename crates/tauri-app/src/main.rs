// release 模式 Windows 用 GUI 子系统：双击不弹 cmd 黑窗。
// debug 保留 console，方便看 tracing/panic。
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

//! Serial Studio Tauri 桌面应用。
//!
//! 双模式：
//! - 默认（GUI）：Tauri 窗口 + 后台 WS/MCP/Telnet 服务器（全部共享同一 state）
//! - --no-gui：纯后台（与 ss-server bin 等价）
//!
//! 方案 B：Tauri 是薄壳。WS/MCP/Telnet 共用 ss-server 的 create_router/run_telnet，
//! 前端（Web/Tauri 共用）通过 WS 接入。

use clap::Parser;
use ss_server::{create_router, create_state};

#[derive(Parser)]
#[command(name = "ss-tauri", version, about = "Serial Studio 桌面应用")]
struct Args {
    /// 禁用 GUI，以 headless 模式运行（仅后台服务）
    #[arg(long)]
    no_gui: bool,

    /// HTTP/WS/MCP 服务器监听地址。GUI 模式默认仅本机。
    #[arg(long, default_value = "127.0.0.1")]
    ws_host: String,

    /// HTTP/WS/MCP 服务器端口
    #[arg(long, default_value_t = 8080)]
    ws_port: u16,

    /// Telnet 服务器端口
    #[arg(long, default_value_t = 8766)]
    telnet_port: u16,
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
        run_headless(args).expect("headless 运行失败");
    } else {
        run_gui(args);
    }
}

/// Headless：WS/MCP + Telnet（共享 state）。
fn run_headless(args: Args) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let state = create_state();

        // Telnet（共享 state：与 WS/MCP 操作同一组串口）
        let telnet_addr = format!("{}:{}", args.ws_host, args.telnet_port);
        let telnet_state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = ss_server::telnet::run_telnet(telnet_addr, telnet_state).await {
                tracing::error!("Telnet 错误: {}", e);
            }
        });

        // HTTP/WS/MCP
        let app = create_router(state);
        let addr = format!("{}:{}", args.ws_host, args.ws_port);
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tracing::info!(
            "服务: ws://{}/ws · /mcp · http://{}/api/ports",
            addr,
            addr
        );
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await?;
        tracing::info!("已关闭");
        Ok::<(), anyhow::Error>(())
    })
}

/// GUI：Tauri 窗口 + 后台 WS/MCP/Telnet 服务器（全部共享同一 state）。
fn run_gui(args: Args) {
    let ws_addr = format!("{}:{}", args.ws_host, args.ws_port);
    let telnet_addr = format!("{}:{}", args.ws_host, args.telnet_port);

    tauri::Builder::default()
        .setup(move |_app| {
            // 共享 state：WS/MCP/Telnet 操作同一组串口
            let state = create_state();

            // HTTP/WS/MCP 服务器
            let ws_state = state.clone();
            let ws_addr = ws_addr.clone();
            tauri::async_runtime::spawn(async move {
                let app = create_router(ws_state);
                let listener = match tokio::net::TcpListener::bind(&ws_addr).await {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::error!("WS 绑定 {} 失败: {}", ws_addr, e);
                        return;
                    }
                };
                tracing::info!("服务: ws://{}/ws · /mcp · /api/ports", ws_addr);
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = tokio::signal::ctrl_c().await;
                    })
                    .await;
            });

            // Telnet 服务器
            let telnet_state = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ss_server::telnet::run_telnet(telnet_addr, telnet_state).await {
                    tracing::error!("Telnet 错误: {}", e);
                }
            });

            Ok(())
        })
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
        // 已有 stdout（debug 模式 console 子系统）→ 不需要 attach
        let existing = GetStdHandle(STD_OUTPUT_HANDLE);
        if !existing.is_null() && existing != INVALID_HANDLE_VALUE {
            return true;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return false; // 双击启动，无父 console
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

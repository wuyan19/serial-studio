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

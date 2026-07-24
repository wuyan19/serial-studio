//! Serial Studio Server (headless bin) —— 纯 WS/REST，无 GUI。
//!
//! GUI 模式由 ss-tauri 提供（它在 Tauri 窗口内启动同一套路由）。

use clap::Parser;
use ss_server::{create_router, create_state};

#[derive(Parser)]
#[command(name = "ss-server", version, about = "Serial Studio WebSocket 网关 (headless)")]
struct Args {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value_t = 18700)]
    port: u16,

    /// Telnet 服务器端口
    #[arg(long, default_value_t = 18701)]
    telnet_port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let state = create_state();

    // 启动 Telnet 服务器（独立 TCP，与 axum 并行）
    let telnet_addr = format!("{}:{}", args.host, args.telnet_port);
    let telnet_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = ss_server::telnet::run_telnet(telnet_addr, telnet_state).await {
            tracing::error!("Telnet 服务器错误: {}", e);
        }
    });

    let app = create_router(state);

    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Serial Studio server: ws://{}/ws · http://{}/api/ports", addr, addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("已关闭");
    Ok(())
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

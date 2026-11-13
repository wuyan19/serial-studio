//! Serial Studio Server (headless bin) —— 纯 WS/REST，无 GUI。
//!
//! GUI 模式由 ss-tauri 提供（它在 Tauri 窗口内启动同一套路由）。

use clap::Parser;
use ss_server::{create_state, settings, supervisor::ServiceSupervisor};

#[derive(Parser)]
#[command(
    name = "ss-server",
    version,
    about = "Serial Studio WebSocket 网关 (headless)"
)]
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
    let settings = settings::Settings {
        ws_host: args.host,
        ws_port: args.port,
        telnet_port: args.telnet_port,
        ..settings::load()
    };
    let supervisor = ServiceSupervisor::new(create_state());
    supervisor
        .start_headless(&settings)
        .await
        .map_err(anyhow::Error::msg)?;
    shutdown_signal().await;
    supervisor.stop().await;
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

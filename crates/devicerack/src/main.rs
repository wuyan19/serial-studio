//! devicerack 服务进程：组合 ss-server 数据面 + 设备/拓扑/租约域 + 控制台 SPA。

use clap::Parser;
use devicerack::{create_router, TopoState};

#[derive(Parser)]
#[command(name = "devicerack", version, about = "AI 设备调试的网络设备管理平台")]
struct Args {
    /// 监听地址；缺省读 settings.json（其缺省 0.0.0.0）
    #[arg(long)]
    host: Option<String>,
    /// 监听端口；缺省读 settings.json（其缺省 18800，错开 serial-studio 的 18700）
    #[arg(long)]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 配置目录默认独立于 serial-studio（devicerack/ 子目录）：settings.json 的实例
    // 身份、各 store 不与 serial-studio 进程互踩；显式 env 覆盖优先（测试/冒烟）。
    // 旧名 devicerack 目录存在而 devicerack 不存在时回退旧目录（老用户数据迁移零成本）。
    if std::env::var(ss_server::config::CONFIG_DIR_ENV).is_err() {
        if let Some(dir) = dirs::config_dir() {
            let name = if dir.join("devicerack").exists() && !dir.join("devicerack").exists() {
                "devicerack" // 老目录回退
            } else {
                "devicerack"
            };
            std::env::set_var(ss_server::config::CONFIG_DIR_ENV, dir.join(name));
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    // 监听解析须在 create_state 之前（instance_id 首启会以底座默认建
    // settings.json，先把 devicerack 默认定型进去）
    let (host, port) = devicerack::listen::resolve_listen(args.host, args.port, "0.0.0.0");
    let base = ss_server::create_state();
    base.devices.start();

    let state = TopoState::create(base);
    // 租约定时清扫：读路径已惰性清扫，这里是无人访问时的兜底（崩溃客户端的
    // 租约最多多活到下一个整分钟 tick）。
    {
        let leases = std::sync::Arc::clone(&state.leases);
        let base = std::sync::Arc::new(state.base.clone());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                leases.sweep(&base).await;
            }
        });
    }
    let app = create_router(state);

    let addr = format!("{}:{}", host, port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(
        "devicerack: http://{addr}/ · MCP http://{addr}/mcp · 配置目录 {}",
        ss_server::config::config_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| "(未定位)".into())
    );

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

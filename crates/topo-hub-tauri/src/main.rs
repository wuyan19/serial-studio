//! topo-hub 桌面壳：进程内起 topo-hub 服务（axum），Tauri 窗口加载本机 URL。
//!
//! 与 serial-studio 桌面壳（重 IPC 命令层：端口数据/命令/文件全走 invoke）不同，
//! topo-hub 前端是纯 Web 架构（WS/REST/SSE 同源直连本地服务）——桌面化=窗口壳，
//! 零 IPC：前端不加任何 isTauri 分支，Web/桌面同一份代码同一套数据面。
//!
//! 端口先同步 bind 再开窗：窗口加载时服务必然已在监听，无竞态白屏。

use clap::Parser;

#[derive(Parser)]
#[command(name = "topo-hub-desktop", version, about = "topo-hub 桌面壳")]
struct Args {
    /// HTTP 端口（REST/WS/MCP 同端口；与 headless bin 同默认）
    #[arg(long, default_value_t = 18800)]
    port: u16,
}

fn main() {
    // 配置目录默认与 headless bin 一致（%APPDATA%/topo-hub），两形态共用同一份数据
    if std::env::var(ss_server::config::CONFIG_DIR_ENV).is_err() {
        if let Some(dir) = dirs::config_dir() {
            std::env::set_var(ss_server::config::CONFIG_DIR_ENV, dir.join("topo-hub"));
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let port = args.port;

    tauri::Builder::default()
        .setup(move |app| {
            // 组装状态 + 租约定时清扫（与 headless bin 的 main 相同），服务
            // 跑在 tauri 自带的 tokio 运行时上；bind 同步完成——失败（端口
            // 被占用）直接弹窗退出，不开一个白屏窗口。
            let listener = tauri::async_runtime::block_on(async {
                let base = ss_server::create_state();
                base.devices.start();
                let state = topo_hub::TopoState::create(base);
                {
                    let leases = std::sync::Arc::clone(&state.leases);
                    let base = std::sync::Arc::new(state.base.clone());
                    tauri::async_runtime::spawn(async move {
                        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                        loop {
                            tick.tick().await;
                            leases.sweep(&base).await;
                        }
                    });
                }
                let router = topo_hub::create_router(state);
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
                listener.map(|l| (l, router))
            });
            let (listener, router) = match listener {
                Ok(pair) => pair,
                Err(e) => {
                    let msg = format!("端口 {port} 被占用或不可用：{e}\n\n用 --port 换一个端口重试。");
                    rfd::MessageDialog::new()
                        .set_title("topo-hub 启动失败")
                        .set_level(rfd::MessageLevel::Error)
                        .set_description(&msg)
                        .show();
                    return Err(Box::new(std::io::Error::other(msg)));
                }
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!("HTTP 服务异常退出: {e}");
                }
            });

            // 窗口加载本机服务 URL（同源直连，Web/桌面同一份前端）
            let url = format!("http://127.0.0.1:{port}/");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("本机 URL 解析失败")),
            )
            .title("topo-hub")
            .inner_size(1440.0, 900.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("topo-hub 桌面壳运行失败");
}

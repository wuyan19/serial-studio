//! 服务监管器：封装 WS/MCP/Telnet 的启动/停止/重启。
//!
//! 控制面深模块——接口小（start/stop/restart/status），实现深
//! （axum graceful shutdown + Telnet 可停 + 端口绑定/释放 + 并发保护）。
//!
//! 关键不变量：AppState 跨重启保留，只换 listener——串口连接和宏不丢。

use crate::settings::Settings;
use crate::telnet::TelnetHandle;
use crate::{create_router, AppState};
use serde::Serialize;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

/// 当前运行的服务实例（持有停掉它所需的一切）。
struct ServiceInstance {
    ws_addr: String,
    telnet_addr: String,
    ws_shutdown: oneshot::Sender<()>,
    ws_join: JoinHandle<()>,
    telnet: TelnetHandle,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub running: bool,
    pub ws_addr: Option<String>,
    pub telnet_addr: Option<String>,
}

pub struct ServiceSupervisor {
    state: AppState,
    current: Mutex<Option<ServiceInstance>>,
}

impl ServiceSupervisor {
    pub fn new(state: AppState) -> Self {
        Self {
            state,
            current: Mutex::new(None),
        }
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// 用 settings 启动 WS/MCP + Telnet。已运行则报错。
    pub async fn start(&self, settings: &Settings) -> Result<(), String> {
        let mut current = self.current.lock().await;
        if current.is_some() {
            return Err("服务已在运行".into());
        }

        let ws_addr = format!("{}:{}", settings.ws_host, settings.ws_port);
        let telnet_addr = format!("{}:{}", settings.ws_host, settings.telnet_port);

        // WS/MCP（axum）：graceful shutdown 由 oneshot 触发
        let listener = tokio::net::TcpListener::bind(&ws_addr)
            .await
            .map_err(|e| format!("WS 绑定 {} 失败: {}", ws_addr, e))?;
        let app = create_router(self.state.clone());
        let (ws_shutdown, ws_shutdown_rx) = oneshot::channel();
        let ws_addr_for_log = ws_addr.clone();
        let ws_join = tokio::spawn(async move {
            tracing::info!("WS/MCP: ws://{}/ws · /mcp · /api/ports", ws_addr_for_log);
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = ws_shutdown_rx.await;
                })
                .await;
        });

        // Telnet（失败则回滚 WS）
        let telnet = match crate::telnet::start_telnet(telnet_addr.clone(), self.state.clone()).await {
            Ok(h) => h,
            Err(e) => {
                let _ = ws_shutdown.send(());
                let _ = ws_join.await;
                return Err(format!("Telnet 绑定 {} 失败: {}", telnet_addr, e));
            }
        };

        *current = Some(ServiceInstance {
            ws_addr,
            telnet_addr,
            ws_shutdown,
            ws_join,
            telnet,
        });
        Ok(())
    }

    /// 停止当前服务（graceful：WS shutdown + Telnet stop，释放端口）。
    /// 已连接的串口/宏不受影响（AppState 保留）。
    pub async fn stop(&self) {
        let instance = self.current.lock().await.take();
        if let Some(inst) = instance {
            let _ = inst.ws_shutdown.send(());
            let _ = inst.ws_join.await;
            inst.telnet.stop().await;
            tracing::info!("服务已停止（WS {} / Telnet {}）", inst.ws_addr, inst.telnet_addr);
        }
    }

    /// 停止后用新 settings 启动。串口连接/宏保留（AppState 共享，只换 listener）。
    pub async fn restart(&self, settings: &Settings) -> Result<(), String> {
        self.stop().await;
        self.start(settings).await
    }

    pub async fn status(&self) -> ServiceStatus {
        match &*self.current.lock().await {
            Some(inst) => ServiceStatus {
                running: true,
                ws_addr: Some(inst.ws_addr.clone()),
                telnet_addr: Some(inst.telnet_addr.clone()),
            },
            None => ServiceStatus {
                running: false,
                ws_addr: None,
                telnet_addr: None,
            },
        }
    }
}

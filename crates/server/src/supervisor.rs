//! 服务监管器：封装 WS/MCP/Telnet 的启动/停止/重启。
//!
//! 控制面深模块——接口小（start/stop/restart/status），实现深
//! （axum graceful shutdown + Telnet 可停 + 端口绑定/释放 + 并发保护）。
//!
//! 关键不变量：AppState 跨重启保留，只换 listener——串口连接和宏不丢。

use crate::access::{AccessConfig, AccessScope};
use crate::settings::Settings;
use crate::telnet::TelnetHandle;
use crate::{create_router, create_secure_router, AppState};
use serde::Serialize;
use std::{net::SocketAddr, time::Duration};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

#[path = "tls.rs"]
mod tls;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

pub fn validate_tls(config: &AccessConfig) -> Result<(), String> {
    config.validate()?;
    if config.https_available() {
        tls::acceptor(config)?;
    }
    Ok(())
}

/// 当前运行的服务实例（持有停掉它所需的一切）。
struct ServiceInstance {
    host: String,
    ws_addr: String,
    telnet_addr: Option<String>,
    telnet_port: u16,
    ws: HttpHandle,
    https: Option<HttpsHandle>,
    telnet: Option<TelnetHandle>,
}

struct HttpsHandle {
    port: u16,
    acceptor: watch::Sender<TlsAcceptor>,
    server: HttpHandle,
}

struct HttpHandle {
    shutdown: oneshot::Sender<()>,
    join: JoinHandle<()>,
}

impl HttpHandle {
    async fn stop(mut self) {
        let _ = self.shutdown.send(());
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut self.join)
            .await
            .is_err()
        {
            self.join.abort();
            let _ = self.join.await;
        }
    }
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
        self.start_inner(settings, false).await
    }

    pub async fn start_headless(&self, settings: &Settings) -> Result<(), String> {
        self.start_inner(settings, true).await
    }

    async fn start_inner(&self, settings: &Settings, telnet_optional: bool) -> Result<(), String> {
        let mut current = self.current.lock().await;
        if current.is_some() {
            return Err("服务已在运行".into());
        }
        *current = Some(self.bind_services(settings, telnet_optional).await?);
        Ok(())
    }

    async fn bind_services(
        &self,
        settings: &Settings,
        telnet_optional: bool,
    ) -> Result<ServiceInstance, String> {
        let access = self.state.access.config();
        access.validate()?;
        let https = if access.https_available() {
            let acceptor = tls::acceptor(&access)?;
            let listener = bind_https(&settings.ws_host, access.tls_port).await?;
            Some((listener, acceptor))
        } else {
            None
        };

        // 远程设备连接池:惰性幂等启动(挂 AppState,热重启 restart 不重复 spawn,
        // 设备连接不重建——与"串口连接不丢"的既有不变量对齐)
        self.state.devices.start();

        let ws_addr = format!("{}:{}", settings.ws_host, settings.ws_port);
        let listener = TcpListener::bind(&ws_addr)
            .await
            .map_err(|e| format!("WS 绑定 {} 失败: {}", ws_addr, e))?;

        let (telnet_addr, telnet) = if access.enabled && access.scope == AccessScope::All {
            (None, None)
        } else {
            let addr = format!("{}:{}", settings.ws_host, settings.telnet_port);
            match crate::telnet::start_telnet(addr.clone(), self.state.clone()).await {
                Ok(handle) => (Some(addr), Some(handle)),
                Err(e) if telnet_optional => {
                    tracing::error!("Telnet 绑定 {addr} 失败：{e}");
                    (None, None)
                }
                Err(e) => return Err(format!("Telnet 绑定 {addr} 失败：{e}")),
            }
        };

        let app = create_router(self.state.clone());
        let (ws_shutdown, ws_shutdown_rx) = oneshot::channel();
        let ws_addr_for_log = ws_addr.clone();
        let ws_join = tokio::spawn(async move {
            tracing::info!("WS/MCP: ws://{}/ws · /mcp · /api/ports", ws_addr_for_log);
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = ws_shutdown_rx.await;
            })
            .await;
        });

        let https =
            https.map(|(listener, acceptor)| self.serve_https(listener, access.tls_port, acceptor));

        Ok(ServiceInstance {
            host: settings.ws_host.clone(),
            ws_addr,
            telnet_addr,
            telnet_port: settings.telnet_port,
            ws: HttpHandle {
                shutdown: ws_shutdown,
                join: ws_join,
            },
            https,
            telnet,
        })
    }

    fn serve_https(&self, listener: TcpListener, port: u16, acceptor: TlsAcceptor) -> HttpsHandle {
        let app = create_secure_router(self.state.clone());
        let (shutdown, receiver) = oneshot::channel();
        let (acceptor, acceptor_rx) = watch::channel(acceptor);
        tracing::info!("HTTPS/WSS listening on port {port}");
        let join = tokio::spawn(tls::serve(listener, acceptor_rx, app, receiver));
        HttpsHandle {
            port,
            acceptor,
            server: HttpHandle { shutdown, join },
        }
    }

    pub async fn configure_access(
        &self,
        config: AccessConfig,
        settings: &Settings,
    ) -> Result<(), String> {
        let mut current = self.current.lock().await;
        config.validate()?;
        let acceptor = config
            .https_available()
            .then(|| tls::acceptor(&config))
            .transpose()?;
        let Some(instance) = current.as_mut() else {
            self.state.access.configure(config)?;
            *current = Some(self.bind_services(settings, false).await?);
            return Ok(());
        };

        let https_port_changed =
            instance.https.as_ref().map(|https| https.port) != Some(config.tls_port);
        let https_listener = if acceptor.is_some() && https_port_changed {
            Some(bind_https(&instance.host, config.tls_port).await?)
        } else {
            None
        };

        let telnet_enabled = !config.enabled || config.scope != AccessScope::All;
        let new_telnet = if telnet_enabled && instance.telnet.is_none() {
            let addr = format!("{}:{}", instance.host, instance.telnet_port);
            let handle = crate::telnet::start_telnet(addr.clone(), self.state.clone())
                .await
                .map_err(|e| format!("Telnet 绑定 {addr} 失败：{e}"))?;
            Some((addr, handle))
        } else {
            None
        };

        let https_port = config.tls_port;
        if let Err(e) = self.state.access.configure(config) {
            if let Some((_, telnet)) = new_telnet {
                telnet.stop().await;
            }
            return Err(e);
        }

        if let Some((addr, handle)) = new_telnet {
            instance.telnet_addr = Some(addr);
            instance.telnet = Some(handle);
        } else if !telnet_enabled {
            instance.telnet_addr = None;
            if let Some(telnet) = instance.telnet.take() {
                telnet.stop().await;
            }
        }

        if let Some(acceptor) = acceptor {
            if let Some(listener) = https_listener {
                let old = instance
                    .https
                    .replace(self.serve_https(listener, https_port, acceptor));
                if let Some(https) = old {
                    https.server.stop().await;
                }
            } else if let Some(https) = &instance.https {
                https.acceptor.send_replace(acceptor);
            }
        } else if let Some(https) = instance.https.take() {
            https.server.stop().await;
        }
        Ok(())
    }

    /// 停止当前服务（graceful：WS shutdown + Telnet stop，释放端口）。
    /// 已连接的串口/宏不受影响（AppState 保留）。
    pub async fn stop(&self) {
        let mut current = self.current.lock().await;
        if let Some(instance) = current.take() {
            stop_instance(instance).await;
        }
    }

    /// 停止后用新 settings 启动。串口连接/宏保留（AppState 共享，只换 listener）。
    pub async fn restart(&self, settings: &Settings) -> Result<(), String> {
        let mut current = self.current.lock().await;
        if let Some(instance) = current.take() {
            stop_instance(instance).await;
        }
        *current = Some(self.bind_services(settings, false).await?);
        Ok(())
    }

    pub async fn status(&self) -> ServiceStatus {
        match &*self.current.lock().await {
            Some(inst) => ServiceStatus {
                running: true,
                ws_addr: Some(inst.ws_addr.clone()),
                telnet_addr: inst.telnet_addr.clone(),
            },
            None => ServiceStatus {
                running: false,
                ws_addr: None,
                telnet_addr: None,
            },
        }
    }
}

async fn stop_instance(instance: ServiceInstance) {
    let https = async {
        if let Some(handle) = instance.https {
            handle.server.stop().await;
        }
    };
    let telnet = async {
        if let Some(handle) = instance.telnet {
            handle.stop().await;
        }
    };
    tokio::join!(instance.ws.stop(), https, telnet);
    tracing::info!("服务已停止（WS {}）", instance.ws_addr);
}

async fn bind_https(host: &str, port: u16) -> Result<TcpListener, String> {
    TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("HTTPS 绑定 {host}:{port} 失败：{e}"))
}

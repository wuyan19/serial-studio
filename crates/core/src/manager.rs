//! 多串口管理器：HashMap<端口名, PortHandle>。
//!
//! 接入层（server/telnet/cli/tauri）面对的核心接口。
//! 除串口 open/close/write 外，还提供接收缓冲区方法（drain/grep/clear）供 MCP/宏使用。

use crate::error::SerialError;
use crate::event_bus::EventBus;
use crate::port_task::{self, PortCommand, PortHandle};
use crate::rx_buffer::RxBuffer;
use crate::serial;
use crate::types::{PortInfo, SerialConfig};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;

pub struct SerialManager {
    ports: Mutex<HashMap<String, PortHandle>>,
    event_bus: Arc<EventBus>,
}

impl SerialManager {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            ports: Mutex::new(HashMap::new()),
            event_bus,
        }
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    /// 列出系统串口，附加本管理器的 opened 状态。
    pub async fn list_ports(&self) -> Vec<PortInfo> {
        let names = serial::list_port_names();
        let ports = self.ports.lock().await;
        names
            .into_iter()
            .map(|name| {
                let opened = ports.contains_key(&name);
                PortInfo { name, opened }
            })
            .collect()
    }

    /// 当前已打开的端口名列表。
    pub async fn list_open_ports(&self) -> Vec<String> {
        self.ports.lock().await.keys().cloned().collect()
    }

    /// 打开串口。
    pub async fn open(&self, port: String, config: SerialConfig) -> Result<(), SerialError> {
        {
            let ports = self.ports.lock().await;
            if ports.contains_key(&port) {
                return Err(SerialError::AlreadyOpen(port));
            }
        }

        let port_name = port.clone();
        let config_for_open = config.clone();
        let opened = tokio::task::spawn_blocking(move || serial::open(&port_name, &config_for_open))
            .await
            .map_err(|e| SerialError::OpenFailed {
                port: port.clone(),
                message: format!("join 错误: {}", e),
            })??;

        let rx_buffer = Arc::new(RxBuffer::new());
        let (command_tx, command_rx) = mpsc::channel(32);
        let event_bus = Arc::clone(&self.event_bus);
        let rx_buf_clone = Arc::clone(&rx_buffer);
        let task_name = port.clone();
        let join_handle = tokio::spawn(async move {
            port_task::run(task_name.clone(), opened, command_rx, event_bus, rx_buf_clone).await;
        });
        let abort_handle = join_handle.abort_handle();

        let mut ports = self.ports.lock().await;
        ports.insert(
            port.clone(),
            PortHandle {
                join_handle,
                abort_handle,
                command_tx,
                rx_buffer,
                config,
            },
        );

        Ok(())
    }

    /// 关闭串口。
    pub async fn close(&self, port: String) -> Result<(), SerialError> {
        let handle = {
            let mut ports = self.ports.lock().await;
            ports
                .remove(&port)
                .ok_or_else(|| SerialError::NotOpen(port.clone()))?
        };

        let (tx, rx) = oneshot::channel();
        let _ = handle.command_tx.send(PortCommand::Close(tx)).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;

        handle.abort_handle.abort();
        let _ = tokio::time::timeout(Duration::from_secs(5), handle.join_handle).await;

        Ok(())
    }

    /// 写入数据。
    pub async fn write(&self, port: String, data: Bytes) -> Result<usize, SerialError> {
        let command_tx = {
            let ports = self.ports.lock().await;
            ports
                .get(&port)
                .ok_or_else(|| SerialError::NotOpen(port.clone()))?
                .command_tx
                .clone()
        };

        let (tx, rx) = oneshot::channel();
        command_tx
            .send(PortCommand::Write(data, tx))
            .await
            .map_err(|_| SerialError::NotOpen(port.clone()))?;

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SerialError::WriteFailed("写响应通道关闭".into())),
            Err(_) => Err(SerialError::WriteFailed("写超时".into())),
        }
    }

    /// 端口是否已打开。
    pub async fn is_open(&self, port: &str) -> bool {
        self.ports.lock().await.contains_key(port)
    }

    // ===== 接收缓冲区方法（MCP / 宏用）=====

    async fn get_rx_buffer(&self, port: &str) -> Result<Arc<RxBuffer>, SerialError> {
        let ports = self.ports.lock().await;
        ports
            .get(port)
            .map(|h| Arc::clone(&h.rx_buffer))
            .ok_or_else(|| SerialError::NotOpen(port.to_string()))
    }

    /// 返回端口配置（status 用）。
    pub async fn status(&self, port: &str) -> Option<SerialConfig> {
        self.ports.lock().await.get(port).map(|h| h.config.clone())
    }

    /// 破坏性读取缓冲区（空时按 timeout 等待）。
    pub async fn drain_buffer(&self, port: &str, timeout_ms: u64) -> Result<Vec<u8>, SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        Ok(tokio::task::spawn_blocking(move || buf.drain(timeout_ms))
            .await
            .unwrap_or_default())
    }

    /// 清空缓冲区。
    pub async fn clear_buffer(&self, port: &str) -> Result<(), SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        let _ = tokio::task::spawn_blocking(move || buf.clear()).await;
        Ok(())
    }

    /// 正则匹配缓冲区文本行（非破坏）。
    pub async fn grep_buffer(
        &self,
        port: &str,
        pattern: &str,
        timeout_ms: u64,
    ) -> Result<Vec<String>, SerialError> {
        let re = regex::Regex::new(pattern).map_err(|e| SerialError::InvalidConfig(e.to_string()))?;
        let buf = self.get_rx_buffer(port).await?;
        Ok(tokio::task::spawn_blocking(move || buf.grep_text(&re, timeout_ms))
            .await
            .unwrap_or_default())
    }

    /// 字节序列匹配缓冲区（非破坏）。
    pub async fn grep_buffer_bytes(
        &self,
        port: &str,
        pattern: Vec<u8>,
        timeout_ms: u64,
    ) -> Result<Vec<(usize, Vec<u8>)>, SerialError> {
        let buf = self.get_rx_buffer(port).await?;
        Ok(
            tokio::task::spawn_blocking(move || buf.grep_bytes(&pattern, timeout_ms))
                .await
                .unwrap_or_default(),
        )
    }
}

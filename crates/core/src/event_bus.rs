//! 事件总线：基于 tokio broadcast 的多消费者广播。
//!
//! 一个串口数据源 → 多个订阅者（WS 客户端、Tauri 前端、日志）各取所需。

use serde::Serialize;
use tokio::sync::broadcast;

/// 串口事件。
///
/// broadcast 要求 T: Clone；DataReceived 的 data 会 clone 给每个订阅者。
/// 终端数据包通常很小，可接受。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SerialEvent {
    /// 从串口收到数据
    DataReceived { port: String, data: Vec<u8> },
    /// 串口已打开
    PortOpened { port: String },
    /// 串口已关闭
    PortClosed { port: String },
    /// 持有者数量变化（有人加入/退出，但端口未关闭）
    HoldersChanged { port: String, holders: usize },
    /// 串口错误
    Error { port: String, message: String },
}

pub struct EventBus {
    sender: broadcast::Sender<SerialEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// 订阅事件流。每个订阅者独立接收（broadcast：晚加入的收不到历史）。
    pub fn subscribe(&self) -> broadcast::Receiver<SerialEvent> {
        self.sender.subscribe()
    }

    /// 发布事件给所有订阅者。无订阅者时静默丢弃。
    pub fn publish(&self, event: SerialEvent) {
        let _ = self.sender.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_subscribe() {
        let bus = EventBus::new(8);
        let mut rx = bus.subscribe();
        bus.publish(SerialEvent::PortOpened { port: "COM1".into() });
        let evt = rx.recv().await.unwrap();
        assert!(matches!(evt, SerialEvent::PortOpened { .. }));
    }

    #[tokio::test]
    async fn no_subscriber_no_panic() {
        let bus = EventBus::new(8);
        // 无订阅者 publish 不应 panic
        bus.publish(SerialEvent::PortClosed { port: "X".into() });
    }
}

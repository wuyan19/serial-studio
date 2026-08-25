//! Serial Studio 核心库
//!
//! 多串口管理引擎：每个串口一个独立异步任务（port_task），通过 EventBus 广播数据。
//!
//! 设计要点（参考 D:\Dev serial-gateway 验证过的 Actor 模式）：
//! - **每端口一 task**：故障隔离、无需锁、生命周期清晰
//! - **命令模式**：所有写操作经 command_rx 串行处理，同一端口天然单写者
//! - **同步串口 + spawn_blocking**：serialport 是阻塞的，用 spawn_blocking 融入 tokio
//! - **EventBus 多消费者**：一个数据源 → WS/Tauri/日志各取所需
//!
//! core 不依赖 axum/clap/tauri，保持可测试性。

pub mod error;
pub mod event_bus;
pub mod macros;
pub mod manager;
pub mod opener;
pub mod port_io;
pub mod port_task;
pub mod rx_buffer;
pub mod script;
pub mod serial;
pub mod types;

pub use error::SerialError;
pub use event_bus::{EventBus, SerialEvent};
pub use macros::{run_macro, Macro, MacroError, MacroStep};
pub use manager::{KeyResolver, SerialManager};
pub use opener::{PortOpener, RealPortOpener};
pub use port_io::{PortIo, SerialPortIo};
pub use port_task::{PortCommand, PortHandle};
pub use rx_buffer::RxBuffer;
pub use script::{run_script, run_script_with_timeout, Script, ScriptError, ScriptParam};
pub use types::*;

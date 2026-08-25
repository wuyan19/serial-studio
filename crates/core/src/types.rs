//! 串口配置与端口信息类型。
//!
//! 这些类型可从 JSON 反序列化，供 WS / REST / MCP 各接入层共用。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// 串口配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: DataBits,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: StopBits,
    #[serde(default = "default_parity")]
    pub parity: Parity,
    #[serde(default = "default_flow_control")]
    pub flow_control: FlowControl,
    /// 行结束符：text 模式 auto_newline 追加的换行。连 Linux shell 选 LF，
    /// Windows/AT 设备选 CRLF。仅作用于程序发送（宏/MCP），交互输入透传不受影响。
    #[serde(default = "default_line_ending")]
    pub line_ending: LineEnding,
    /// 读取超时（毫秒）。影响命令响应延迟——越小越快但 CPU 占用越高。
    /// 默认 100ms：port_task 的读循环靠它定期返回，让 select 能处理命令。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_data_bits() -> DataBits {
    DataBits::Eight
}
fn default_stop_bits() -> StopBits {
    StopBits::One
}

fn default_parity() -> Parity {
    Parity::None
}

fn default_flow_control() -> FlowControl {
    FlowControl::None
}
fn default_line_ending() -> LineEnding {
    LineEnding::LF
}
fn default_timeout_ms() -> u64 {
    100
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            baud_rate: 115200,
            data_bits: DataBits::Eight,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            line_ending: LineEnding::LF,
            timeout_ms: 100,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

/// 行结束符。LF（Unix）/ CR / CRLF（Windows、多数串口设备）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    LF,
    CR,
    CRLF,
}

/// 遗留本机标记:`local::` 前缀只作为**旧版输入**被剥除(兼容老客户端/混版本组网),
/// 不再由任何出口产生——本地端口的规范键就是裸名。split 对裸名返回此标记作路由语义。
pub const LOCAL_DEVICE_ID: &str = "local";

/// 端口复合键分隔符:`${devId}::${portName}`。串口名不含 `::`,分隔安全。
pub const PORT_KEY_SEP: &str = "::";

/// 组装端口复合键:`${devId}::${portName}`。仅用于远端键;本机口直接用裸名。
pub fn compose_port_key(dev_id: &str, port_name: &str) -> String {
    format!("{}{}{}", dev_id, PORT_KEY_SEP, port_name)
}

/// 解析端口复合键:按首个 `::` 切分,只剥第一段,**后缀整体透传**——
/// 多级级联(A 注册 B、B 注册 C)时 `uuidB::uuidC::COM3` 剥出 (uuidB, "uuidC::COM3"),
/// 逐层路由无特判。无分隔符视为本机端口(裸名即本机,返回 LOCAL_DEVICE_ID 作语义标记)。
pub fn split_port_key(key: &str) -> (&str, &str) {
    match key.split_once(PORT_KEY_SEP) {
        Some((dev, rest)) => (dev, rest),
        None => (LOCAL_DEVICE_ID, key),
    }
}

/// 规范化端口键:**剥一层遗留 `local::` 前缀**(老客户端输入/混版本互操作),
/// 裸名保持裸名(= 本机端口),远端复合键原样返回。
/// manager 所有端口入口都经此规范化,保证 map 键单一形态:
/// `COM5`、`local::COM5` 与裸名指向同一条目,占有权不因写法分裂。
pub fn normalize_port_key(key: &str) -> String {
    match key.strip_prefix(LOCAL_DEVICE_ID).and_then(|r| r.strip_prefix(PORT_KEY_SEP)) {
        Some(rest) => rest.to_string(),
        None => key.to_string(),
    }
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// 会话标识：一条 WS 连接或一个 Tauri 窗口的唯一身份，进程内全局单调递增。
/// 仅需进程内唯一，故用自增计数器而非 uuid。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct SessionId(u64);

impl SessionId {
    /// 分配一个新的会话标识。
    pub fn next() -> Self {
        Self(NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed))
    }
}

/// acquire 的结果：区分"真正打开"与"附加到已开端口"。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcquireResult {
    /// 本次真正打开或重连(reopen)了端口。holders 为当前持有者数(open=1,reopen=保留的 N)。
    Opened {
        config: SerialConfig,
        holders: usize,
    },
    /// 端口已开，本次为附加（持有者 +1）。config 为端口当前实际配置
    /// （请求的配置被忽略），调用方应据此告知用户。
    Attached {
        config: SerialConfig,
        holders: usize,
    },
}

/// release 的结果：本会话退出持有的实际效果。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReleaseOutcome {
    /// 本会话是末位持有者，端口已拆毁。
    Closed,
    /// 仍有其它持有者，端口保持打开。
    Released { remaining: usize },
    /// 本会话未持有此端口（幂等，非错误）。
    NotHeld,
}

/// 端口信息（含是否已由本管理器打开及当前持有者数）。纯运行时事实；
/// 用户元数据（别名等）由 server 层的 PortView 组合，不在 core。
/// Deserialize 供 server 层设备客户端解析远端上报的端口表(PortView flatten);
/// PartialEq 供设备客户端做缓存 diff(自连时防 MetaChanged 回授环——
/// 未变化的 Ports 重复到达不得再扇出本地通知)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortInfo {
    pub name: String,
    pub opened: bool,
    /// 当前持有该端口的会话数（多端共享时 >1）。
    pub holders: usize,
    /// 设备已断开(USB 拔出等)但占有权(holder)仍保留——前端据此显断开态、可重连。
    /// 区别于 opened=false(从未打开)。
    #[serde(default)]
    pub disconnected: bool,
}

/// 已知远程设备（桌面端持久化于 remotes.json；Web/远程窗口由 connConfig 派生单设备，不持久化）。
/// id 即 devId，用于端口复合键。字段与前端 TS `RemoteDevice` 对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteDevice {
    /// 稳定主键（UUID），作为 devId 用于端口复合键。
    pub id: String,
    pub host: String,
    pub port: u16,
    /// 可选昵称；空则 UI 回退 host:port。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_key_roundtrip() {
        let key = compose_port_key("local", "COM3");
        assert_eq!(key, "local::COM3");
        assert_eq!(split_port_key(&key), ("local", "COM3"));
    }

    #[test]
    fn port_key_bare_name_is_canonical_local() {
        // 新形态:本地端口键 = 裸名;遗留 `local::` 前缀输入剥除后与裸名同一条目
        assert_eq!(split_port_key("COM7"), ("local", "COM7"));
        assert_eq!(normalize_port_key("COM7"), "COM7");
        assert_eq!(normalize_port_key("local::COM7"), "COM7");
        assert_eq!(
            normalize_port_key(&compose_port_key("uuid1", "COM3")),
            "uuid1::COM3"
        );
    }

    #[test]
    fn port_key_multihop_cascade_splits_first_segment_only() {
        // 级联:A 注册 B(uuid1)、B 注册 C(uuid2)——首段路由,后缀整体透传
        let key = compose_port_key("uuid1", "uuid2::COM3");
        assert_eq!(split_port_key(&key), ("uuid1", "uuid2::COM3"));
        // 遗留级联线名(旧版远端上报 uuid2::local::COM3)只剥本机这层的 local::
        assert_eq!(normalize_port_key("local::uuid2::COM3"), "uuid2::COM3");
        assert_eq!(normalize_port_key("uuid1::uuid2::COM3"), "uuid1::uuid2::COM3");
    }

    #[test]
    fn config_default_values() {
        let c = SerialConfig::default();
        assert_eq!(c.baud_rate, 115200);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.line_ending, LineEnding::LF);
        assert_eq!(c.timeout_ms, 100);
    }

    #[test]
    fn config_serde_uses_defaults() {
        // 只给 baud_rate，其余走 serde default
        let c: SerialConfig = serde_json::from_str(r#"{"baud_rate":9600}"#).unwrap();
        assert_eq!(c.baud_rate, 9600);
        assert_eq!(c.parity, Parity::None);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.line_ending, LineEnding::LF);
    }

    #[test]
    fn config_full_roundtrip() {
        let json = r#"{"baud_rate":4800,"data_bits":"seven","stop_bits":"two","parity":"even","flow_control":"hardware","timeout_ms":50}"#;
        let c: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.data_bits, DataBits::Seven);
        assert_eq!(c.stop_bits, StopBits::Two);
        assert_eq!(c.parity, Parity::Even);
        assert_eq!(c.flow_control, FlowControl::Hardware);
    }
}

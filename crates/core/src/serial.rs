//! serialport 适配层：配置枚举 → serialport 类型，打开/列举。
//!
//! 这一层是 core 与 serialport 库的唯一接触点。换串口后端只改这里。

use crate::error::SerialError;
use crate::types::{DataBits, FlowControl, Parity, SerialConfig, StopBits};

/// 打开串口（同步阻塞，调用方应在 spawn_blocking 中调用）。
pub fn open(name: &str, config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, SerialError> {
    serialport::new(name, config.baud_rate)
        .data_bits(to_data_bits(config.data_bits))
        .stop_bits(to_stop_bits(config.stop_bits))
        .parity(to_parity(config.parity))
        .flow_control(to_flow_control(config.flow_control))
        .timeout(std::time::Duration::from_millis(config.timeout_ms))
        .open()
        .map_err(|e| convert_open_error(name, e))
}

/// 列出系统可用串口名。
pub fn list_port_names() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

fn to_data_bits(d: DataBits) -> serialport::DataBits {
    match d {
        DataBits::Five => serialport::DataBits::Five,
        DataBits::Six => serialport::DataBits::Six,
        DataBits::Seven => serialport::DataBits::Seven,
        DataBits::Eight => serialport::DataBits::Eight,
    }
}

fn to_stop_bits(s: StopBits) -> serialport::StopBits {
    match s {
        StopBits::One => serialport::StopBits::One,
        StopBits::Two => serialport::StopBits::Two,
    }
}

fn to_parity(p: Parity) -> serialport::Parity {
    match p {
        Parity::None => serialport::Parity::None,
        Parity::Odd => serialport::Parity::Odd,
        Parity::Even => serialport::Parity::Even,
    }
}

fn to_flow_control(f: FlowControl) -> serialport::FlowControl {
    match f {
        FlowControl::None => serialport::FlowControl::None,
        FlowControl::Software => serialport::FlowControl::Software,
        FlowControl::Hardware => serialport::FlowControl::Hardware,
    }
}

fn convert_open_error(port: &str, e: serialport::Error) -> SerialError {
    use serialport::ErrorKind;
    let msg = e.to_string();

    // Windows：serialport 把 ERROR_ACCESS_DENIED（占用）也归为 NoDevice，
    // sharing violation 则落 Io(Other)。NoDevice 不能直接当"不存在"——
    // 端口在册（系统能枚举到）却打不开，才是占用。用枚举结果 + 文案来区分。
    let listed = serialport::available_ports()
        .ok()
        .map(|ps| ps.iter().any(|p| p.port_name == port));

    let looks_busy = matches!(
        e.kind(),
        ErrorKind::NoDevice
            | ErrorKind::Io(std::io::ErrorKind::NotFound)
            | ErrorKind::Io(std::io::ErrorKind::PermissionDenied)
    ) || is_busy_hint(&msg);

    if listed == Some(true) && looks_busy {
        return SerialError::Busy(port.to_string());
    }

    match e.kind() {
        ErrorKind::NoDevice | ErrorKind::Io(std::io::ErrorKind::NotFound) => SerialError::NotFound(port.to_string()),
        ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => SerialError::Busy(port.to_string()),
        _ => SerialError::OpenFailed {
            port: port.to_string(),
            message: msg,
        },
    }
}

/// 错误消息是否暗示"被占用"（兼容 Windows 中/英文系统文案）。
fn is_busy_hint(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("拒绝访问")
        || m.contains("另一个进程")
        || m.contains("被占用")
        || m.contains("access is denied")
        || m.contains("being used by another process")
        || m.contains("sharing violation")
}

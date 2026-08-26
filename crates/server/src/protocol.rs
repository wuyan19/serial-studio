//! WS 线协议单一定义:server 侧出口(ws.rs)与设备客户端(DeviceClient)共用。
//!
//! 消息词典、编解码全部在此;`ui/src/transport.ts` 是 JS 对侧——两处同步的
//! 既有纪律不变(改这里必须看那边)。
//!
//! 数据帧(Binary,仅 server→client 方向):`[port_len:u8][port UTF-8][data]`;
//! client→server 的写必须走 JSON write action。

use serde::{Deserialize, Serialize};
use ss_core::SerialConfig;

/// 服务器 → 客户端 消息(全 owned,避免生命周期纠缠)。
/// Serialize 给 ws.rs 出口;Deserialize 给 DeviceClient 收远端消息。
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Ports {
        ports: Vec<crate::PortView>,
    },
    Opened {
        port: String,
    },
    Closed {
        port: String,
    },
    /// 设备意外断开(USB 拔出/网络断):前端保留 tab 可重连(区别于 Closed 的删 tab)。
    Disconnected {
        port: String,
    },
    /// open 的直接回复:opened=true 首开,false 附加(config 为实际配置,holders 为当前持有数)。
    /// `resolved` = 服务端实际打开的 map 键(别名解析后)。缺省 = 旧版服务端
    /// (无别名解析,port 即真名)——设备客户端据此以真名登记 IO,
    /// 否则数据帧(map 键口径)与登记键(请求串)分裂,RX 静默断流。
    /// `req` = 请求关联 id(回带客户端 Open 的 req):新↔新按 req 精确配对回执,
    /// 防同端口 close/write 回执误配在途 open;缺省 = 旧版服务端(按端口路由兜底)。
    Acquired {
        port: String,
        opened: bool,
        config: SerialConfig,
        holders: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    /// 持有者数量变化(有人加入/退出,端口未关)。
    Holders {
        port: String,
        holders: usize,
    },
    /// 端口元数据(别名等)变更——客户端应重新拉取端口列表。
    MetaChanged,
    /// 脚本库(scripts.json)变更——客户端应重新拉取脚本列表。
    ScriptsChanged,
    /// 错误。port 可选:open/write/set_alias 等命令的失败回复带上端口名,
    /// 设备客户端据此路由在途回执;旧客户端忽略该字段(线向后兼容)。
    /// `req` = 请求关联 id(回带);缺省 = 旧版服务端,客户端按端口/FIFO 兜底路由。
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    /// 命令成功回复(close/write/set_alias)。port 可选,作用同 Error。
    /// `req` = 请求关联 id(回带);缺省 = 旧版服务端(其写回执无 port,
    /// 客户端按 FIFO 兜底配对最老在途回执)。
    Ok {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    MacroResult {
        run_id: String,
        name: String,
        success: bool,
        message: String,
    },
    /// run_script 的结果(与 MacroResult 同构)。run_id 供前端按运行实例路由(停止/并发区分)。
    ScriptResult {
        run_id: String,
        name: String,
        success: bool,
        message: String,
    },
    /// 脚本 log() 输出(实时)。前端按 run_id 路由到对应运行实例的日志区。port 不转发(前端按 run_id 路由)。
    ScriptLog {
        run_id: String,
        message: String,
    },
    /// version 的直接回复:服务端编译版本 + 是否启用远程脚本执行(前端据此显隐脚本 UI)。
    /// instance_id = 服务端实例身份(段名=实例 id 的身份交换;旧版服务端无此字段,
    /// 客户端 None = 对端不支持,保持占位段名)。
    Version {
        version: String,
        enable_scripting: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instance_id: Option<String>,
    },
    /// get_script_skill 的直接回复:脚本编写 SKILL 全文(前端展示 / 复制给外部 Agent 用)。
    ScriptSkill {
        text: String,
    },
    /// 已注册远程设备的在线状态快照(幂等)。连接建立时推一次,设备上下线时重推。
    Devices {
        devices: Vec<DeviceStateView>,
    },
    /// 心跳回复:客户端应用层 ping 的应答(浏览器 WS 不能发协议层 ping,由前端自备探活)。
    Pong,
}

/// 远程设备在线状态(Devices 快照的条目)。host/port 供前端把"学习到的
/// 实例 id"对齐回 remotes 条目(按地址匹配替换占位 id);旧版服务端无此二字段,
/// 前端 undefined 时跳过对齐。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceStateView {
    pub id: String,
    pub online: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
}

/// 客户端 → 服务器 消息。
/// Deserialize 给 ws.rs 入口;Serialize 给 DeviceClient 发远端。
/// Open/Close/Write/SetAlias 的 `req` = 请求关联 id(DeviceClient 赋值,服务端
/// 原样回带到 Acquired/Ok/Error)——新↔新精确配对回执,防同端口回执误配;
/// 旧版服务端忽略未知字段不回带,客户端自动落回端口路由兜底。浏览器前端不带 req。
#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ClientMsg {
    List,
    Open {
        port: String,
        #[serde(default)]
        config: SerialConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    Close {
        port: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    Write {
        port: String,
        data: String,
        #[serde(default = "default_encoding")]
        encoding: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    RunMacro {
        name: String,
        port: String,
        r#macro: ss_core::Macro,
        /// 运行实例 id(前端生成 uuid),用于停止与结果路由(对齐 RunScript)。
        run_id: String,
    },
    /// 运行 JS 脚本(远端受 settings.enable_scripting 限制)。
    RunScript {
        name: String,
        port: String,
        script: ss_core::Script,
        #[serde(default)]
        args: std::collections::HashMap<String, String>,
        /// 运行实例 id(前端生成 uuid),用于停止与结果路由。
        run_id: String,
    },
    /// 停止运行中的脚本(按 run_id):set 对应 abort flag,脚本经 sleep 轮询退出。
    StopScript {
        run_id: String,
    },
    /// 停止运行中的宏(按 run_id):复用 script_runs 表,set abort flag 退出。
    StopMacro {
        run_id: String,
    },
    /// 设置端口别名("" /null = 清除)。别名写入 ports.json,跟随端口所在机器。
    SetAlias {
        port: String,
        #[serde(default)]
        alias: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        req: Option<u64>,
    },
    /// 查询服务版本;instance_id = 客户端实例自报身份(设备客户端握手用,
    /// 浏览器前端不带)。旧版客户端形态 `{"action":"version"}` 反序列化为 None;
    /// 旧版服务端对本消息的额外字段宽容(internally-tagged 单元变体忽略未知键)。
    Version {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instance_id: Option<String>,
    },
    /// 拉取脚本编写 SKILL 全文(展示 / 复制给外部 Agent 用)。
    GetScriptSkill,
    /// 应用层心跳(浏览器 WS 不暴露协议层 ping,由前端定时发,服务端即时回 Pong)。
    Ping,
}

fn default_encoding() -> String {
    "text".into()
}

/// 输出帧:控制消息走 Text(JSON),串口数据走 Binary(帧头+原始字节)。
pub enum OutFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// 构造数据 Binary 帧:`[port_len:u8][port UTF-8][data]`。
/// port_len 用 u8:串口设备名(COMn、/dev/ttyUSBn)远小于 255;复合键(含级联)两级
/// 也 ≈84 字节。超长(u8 放不下)是异常状态——运行时守卫截断到最小合法帧并留痕,
/// 防 release 下线格式损坏(debug_assert 在 release 无效)。
pub fn data_frame(port: &str, data: &[u8]) -> Vec<u8> {
    if port.len() > 255 {
        tracing::error!(
            "端口键超长({} 字节),Binary 帧无法携带,丢弃本帧数据: {}",
            port.len(),
            port
        );
        return vec![0]; // 最小合法空帧(port_len=0),不发送非法 0 字节帧
    }
    let port_bytes = port.as_bytes();
    let mut frame = Vec::with_capacity(1 + port_bytes.len() + data.len());
    frame.push(port_bytes.len() as u8);
    frame.extend_from_slice(port_bytes);
    frame.extend_from_slice(data);
    frame
}

/// 解析数据 Binary 帧(与 [`data_frame`] 对偶,DeviceClient 收远端数据帧用)。
/// 返回 (port, data);帧损坏(空/长度越界)返回 None 并留痕。
pub fn parse_data_frame(frame: &[u8]) -> Option<(&str, &[u8])> {
    if frame.is_empty() {
        return None;
    }
    let port_len = frame[0] as usize;
    let rest = frame.get(1..)?;
    if rest.len() < port_len {
        tracing::error!(
            "数据帧损坏:声明端口名 {} 字节,实际载荷仅 {} 字节",
            port_len,
            rest.len()
        );
        return None;
    }
    let port = std::str::from_utf8(&rest[..port_len]).ok()?;
    let data = &rest[port_len..];
    Some((port, data))
}

pub fn to_json(msg: ServerMsg) -> OutFrame {
    OutFrame::Text(serde_json::to_string(&msg).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_frame_layout() {
        let f = data_frame("COM3", &[0x41, 0x42, 0x43]);
        // [port_len=4][C O M 3][data...]
        assert_eq!(f, vec![4, b'C', b'O', b'M', b'3', 0x41, 0x42, 0x43]);
    }

    #[test]
    fn data_frame_empty_data() {
        let f = data_frame("COM7", &[]);
        assert_eq!(f, vec![4, b'C', b'O', b'M', b'7']);
    }

    #[test]
    fn data_frame_multibyte_port() {
        // 多字节端口名（UTF-8）：port_len 是字节长度，不是字符数
        let port = "串口1";
        let f = data_frame(port, &[0xff]);
        assert_eq!(f[0] as usize, port.len());
        assert_eq!(&f[1..1 + port.len()], port.as_bytes());
        assert_eq!(&f[1 + port.len()..], &[0xff]);
    }

    /// parse 与 data_frame 对偶:正常帧往返一致(DeviceClient 解析远端帧的契约)。
    /// 端口名样例覆盖 新形态复合键 与 遗留 local:: 前缀(旧版线名,入站归一剥除)。
    #[test]
    fn parse_roundtrip() {
        let f = data_frame("dev-b::COM3", b"ping");
        let (port, data) = parse_data_frame(&f).expect("正常帧应解析");
        assert_eq!(port, "dev-b::COM3");
        assert_eq!(data, b"ping");
        // 遗留形态:旧版远端的线名带 local:: 中缀,帧层原样承载(归一在 DeviceClient 入站)
        let legacy = data_frame("dev-b::local::COM3", b"ping");
        let (port, _) = parse_data_frame(&legacy).unwrap();
        assert_eq!(port, "dev-b::local::COM3");
        // 空数据帧:仍可解析(port 头独立于 data)
        let f = data_frame("COM7", b"");
        let (port, data) = parse_data_frame(&f).unwrap();
        assert_eq!(port, "COM7");
        assert!(data.is_empty());
    }

    /// 损坏帧(不可信网络输入):空帧/声明长度越界/非 UTF-8 端口名一律 None,不 panic。
    #[test]
    fn parse_rejects_corrupt_frames() {
        assert!(parse_data_frame(&[]).is_none(), "空帧");
        // 零端口名帧(data_frame 超长守卫的最小输出):解析为空端口名 + 无数据
        assert!(parse_data_frame(&[0]).is_some(), "最小合法空帧可解析");
        // 声明 5 字节端口名,载荷只有 2 字节
        assert!(parse_data_frame(&[5, b'C', b'O']).is_none(), "长度越界");
        // 非 UTF-8 端口名
        assert!(
            parse_data_frame(&[2, 0xff, 0xfe, b'x']).is_none(),
            "非 UTF-8 端口名"
        );
    }

    /// req 线格式契约:None 时字段整体省略(旧版对端/浏览器流量零变化);
    /// Some 时序列化进 JSON 且能原样往返(DeviceClient 请求级回执配对依赖)。
    #[test]
    fn req_field_wire_contract() {
        let ok_none = to_json(ServerMsg::Ok {
            message: "m".into(),
            port: Some("COM7".into()),
            req: None,
        });
        match ok_none {
            OutFrame::Text(s) => {
                assert!(!s.contains("req"), "req=None 不得出现在线格式: {s}");
                let back: ServerMsg = serde_json::from_str(&s).unwrap();
                assert!(matches!(back, ServerMsg::Ok { req: None, .. }));
            }
            _ => panic!("Ok 应是 Text"),
        }
        let ok_some = to_json(ServerMsg::Ok {
            message: "m".into(),
            port: Some("COM7".into()),
            req: Some(42),
        });
        match ok_some {
            OutFrame::Text(s) => {
                assert!(s.contains(r#""req":42"#), "req=Some 应回带: {s}");
                let back: ServerMsg = serde_json::from_str(&s).unwrap();
                assert!(matches!(back, ServerMsg::Ok { req: Some(42), .. }));
            }
            _ => panic!("Ok 应是 Text"),
        }
        // 客户端→服务端方向同规则;未知字段(旧版服务端)反序列化不报错(向后兼容)
        let open: ClientMsg =
            serde_json::from_str(r#"{"action":"open","port":"COM7","req":7}"#).unwrap();
        assert!(matches!(open, ClientMsg::Open { req: Some(7), .. }));
        let legacy: ClientMsg = serde_json::from_str(r#"{"action":"close","port":"COM7"}"#).unwrap();
        assert!(matches!(legacy, ClientMsg::Close { req: None, .. }));
    }

    /// instance_id 线格式契约(段名=实例 id 的身份交换):
    /// - None 时字段整体省略(浏览器前端/旧版对端零变化),Some 时上线且可往返;
    /// - **旧版服务端宽容性**:新客户端发出的 `{"action":"version","instance_id":…}`
    ///   对旧版(Version 为单元变体)不报错——internally-tagged 单元变体忽略额外
    ///   字段,旧 hub 照常回无 id 的 Version,客户端快速落回占位段名。
    #[test]
    fn version_instance_id_wire_contract() {
        // None 省略 / Some 上线(ServerMsg 方向)
        let none = to_json(ServerMsg::Version {
            version: "0.10.4".into(),
            enable_scripting: false,
            instance_id: None,
        });
        match none {
            OutFrame::Text(s) => {
                assert!(!s.contains("instance_id"), "None 不得出现在线格式: {s}");
                // 旧版服务端的应答形态(无此字段)→ 反序列化为 None
                let back: ServerMsg = serde_json::from_str(&s).unwrap();
                assert!(matches!(back, ServerMsg::Version { instance_id: None, .. }));
            }
            _ => panic!("Version 应是 Text"),
        }
        let some = to_json(ServerMsg::Version {
            version: "0.10.4".into(),
            enable_scripting: false,
            instance_id: Some("inst-x".into()),
        });
        match some {
            OutFrame::Text(s) => {
                assert!(s.contains(r#""instance_id":"inst-x""#), "Some 应回带: {s}");
                let back: ServerMsg = serde_json::from_str(&s).unwrap();
                assert!(matches!(
                    back,
                    ServerMsg::Version { instance_id: Some(ref id), .. } if id == "inst-x"
                ));
            }
            _ => panic!("Version 应是 Text"),
        }
        // ClientMsg 方向:旧版客户端形态(无字段)→ None;新形态 → Some
        let legacy: ClientMsg = serde_json::from_str(r#"{"action":"version"}"#).unwrap();
        assert!(matches!(legacy, ClientMsg::Version { instance_id: None }));
        let modern: ClientMsg =
            serde_json::from_str(r#"{"action":"version","instance_id":"inst-y"}"#).unwrap();
        assert!(matches!(
            modern,
            ClientMsg::Version { instance_id: Some(ref id) } if id == "inst-y"
        ));

        // 旧版服务端(Version 为单元变体)对新形态的宽容性:忽略额外字段不报错。
        // 这决定了旧 hub 能否照常应答(而非解析失败丢弃)。
        #[derive(Deserialize)]
        #[serde(tag = "action", rename_all = "snake_case")]
        enum LegacyClientMsg {
            Version,
            #[serde(other)]
            Other,
        }
        let parsed: Result<LegacyClientMsg, _> =
            serde_json::from_str(r#"{"action":"version","instance_id":"inst-y"}"#);
        assert!(
            matches!(parsed, Ok(LegacyClientMsg::Version)),
            "旧版单元变体应对 instance_id 额外字段宽容(serde internally-tagged 行为)"
        );
    }

    /// DeviceStateView 线格式:host/port 供前端 id 对齐(按地址匹配替换占位 id);
    /// 旧版服务端无此二字段 → 反序列化走 default,新前端读空跳过对齐。
    #[test]
    fn device_state_view_wire_contract() {
        let v = DeviceStateView {
            id: "inst-b".into(),
            online: true,
            host: "192.168.1.20".into(),
            port: 18700,
        };
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["host"], "192.168.1.20");
        assert_eq!(json["port"], 18700);
        // 旧版形态(仅 id/online)→ default 兜底
        let legacy: DeviceStateView =
            serde_json::from_str(r#"{"id":"x","online":false}"#).unwrap();
        assert_eq!(legacy.host, "");
        assert_eq!(legacy.port, 0);
    }
}

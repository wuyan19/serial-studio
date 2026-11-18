//! 设备通道会话管理（I/O 工具面的引擎胶水层）。
//!
//! 设备本体论寻址（设备+通道 → 端口键）落到 manager 端口持有上：open 即
//! manager.acquire（挂 token 的 MCP 会话，与强释放收口同机制），I/O 走
//! manager.send + 破坏性 drain，**同时把读到的字节 append 进会话影子缓冲**——
//! agent 侧读是非破坏游标读（读后可再读），缓冲滚动丢弃用 dropped 诚实标注。
//!
//! 租约即写权：I/O 入口先查设备租约（gate 语义同 lease.rs，按设备直接判定），
//! 无租约报错引导 acquire_lease。租约释放/到期连带收会话连接（按持有者
//! release，与 lease.rs 强释放同机制）。
//!
//! 连接复用：会话按 (token, 端口键) 唯一——同一 agent 对同一通道的 exec_command
//! 与 open_session 共用一条连接、一个影子缓冲（串口单线天然满足；console
//! 状态由调用序列自然保持）。SSH 亦复用同条 PTY（同租约单写者，无并发竞争）。

use crate::device::{self, Channel};
use crate::lease::LeaseManager;
use ss_server::AppState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 影子缓冲上限（字节）。超出滚动丢弃最旧，读侧用 dropped 标注缺口。
const SHADOW_MAX: usize = 256 * 1024;

/// 单条会话的影子缓冲：append-only 环形，游标 = 逻辑字节偏移。
#[derive(Default)]
struct Shadow {
    buf: Vec<u8>,
    /// 逻辑流中 buf[0] 的起始偏移（滚动丢弃后前进）。
    start: usize,
    /// 已写入总字节数（= 下一个游标值）。
    written: usize,
}

impl Shadow {
    fn append(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        if self.buf.len() > SHADOW_MAX {
            let drop = self.buf.len() - SHADOW_MAX;
            self.buf.drain(..drop);
            self.start += drop;
        }
        self.written += data.len();
    }

    /// 游标 → 缓冲内下标；None = 越界（早于滚动窗口或晚于末尾）。
    fn pos(&self, cursor: usize) -> Option<usize> {
        if cursor < self.start || cursor > self.written {
            return None;
        }
        Some(cursor - self.start)
    }
}

/// (token, 端口键) → 影子缓冲。连接本体是 manager 的端口持有，这里只挂读侧状态。
#[derive(Default)]
struct DeviceSession {
    shadow: Shadow,
}

/// MCP 设备会话注册表（进程级：会话是 MCP 层概念，与 mcp.rs 的 MCP_SESSIONS
/// 同生命周期理由）。
pub struct SessionManager {
    leases: Arc<LeaseManager>,
    /// Arc<Mutex>：随 TopoState Clone（State 提取器要求），注册表本体进程唯一。
    sessions: Arc<Mutex<HashMap<(String, String), DeviceSession>>>,
}

/// 通道解析结果：端口键 + 打开配置 + 展示标签。
#[derive(Debug)]
pub struct ResolvedChannel {
    pub port_key: String,
    pub serial: bool,
    pub config: ss_core::SerialConfig,
    pub label: String,
}

impl SessionManager {
    pub fn new(leases: Arc<LeaseManager>) -> Arc<Self> {
        Arc::new(Self {
            leases,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 设备+通道寻址 → 端口键与打开配置。
    /// channel 省略：取首个串口（串口 console 是调试主通道），无串口取首个 SSH；
    /// 多通道场景 agent 可从 get_device 拿到通道清单后显式指定。
    /// channel 匹配：序号（"0"/"1"，get_device 输出顺序）或标签子串（"console"）。
    pub fn resolve(device_ref: &str, channel: Option<&str>) -> Result<ResolvedChannel, String> {
        let Some(dev) = device::find(device_ref) else {
            return Err(format!(
                "设备不存在: {device_ref}（get_device 不传参可列出全部设备）"
            ));
        };
        let chans = &dev.channels;
        if chans.is_empty() {
            return Err(format!(
                "设备「{}」无通道。device_create 注册时需带通道（串口或 SSH）",
                dev.name
            ));
        }
        let ch = match channel.map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => {
                if let Ok(idx) = c.parse::<usize>() {
                    chans.get(idx).ok_or_else(|| {
                        format!(
                            "通道序号 {idx} 超出范围（设备「{}」共 {} 条通道，0 起）",
                            dev.name,
                            chans.len()
                        )
                    })?
                } else {
                    // 匹配面：展示标签（含 nickname）+ SSH username（admin/support 场景常用用户名指代）
                    chans
                        .iter()
                        .find(|ch| match ch {
                            Channel::Ssh(s) => ch.label().contains(c) || s.username.contains(c),
                            _ => ch.label().contains(c),
                        })
                        .ok_or_else(|| {
                            let opts: Vec<String> = chans.iter().map(|ch| ch.label()).collect();
                            format!(
                                "设备「{}」无匹配通道「{c}」，可选: {}",
                                dev.name,
                                opts.join("、")
                            )
                        })?
                }
            }
            None => chans
                .iter()
                .find(|ch| matches!(ch, Channel::Serial { .. }))
                .or_else(|| chans.first())
                .expect("chans 非空已保证"),
        };
        match ch {
            Channel::Serial { port, config } => Ok(ResolvedChannel {
                port_key: port.clone(),
                serial: true,
                config: config.clone(),
                label: ch.label(),
            }),
            Channel::Ssh(s) => Ok(ResolvedChannel {
                // SSH 端点键 = 凭据 id::shell（P2.6 定型）
                port_key: format!("{}::shell", s.id),
                serial: false,
                config: ss_core::SerialConfig::default(),
                label: ch.label(),
            }),
        }
    }

    /// I/O 入口：会话标识 + 设备租约检查 + 通道解析。
    /// 失败文案可直接返回 agent（引导下一步动作）。
    pub fn io_gate(
        &self,
        principal: Option<&str>,
        device_ref: &str,
        channel: Option<&str>,
    ) -> Result<ResolvedChannel, String> {
        let Some(token) = principal else {
            return Err(
                "须会话标识（initialize 取 token，标准客户端自动带头），先 acquire_lease 再执行 I/O"
                    .into(),
            );
        };
        let Some(dev) = device::find(device_ref) else {
            return Err(format!(
                "设备不存在: {device_ref}（get_device 不传参可列出全部设备）"
            ));
        };
        // 租约即写权（语义同 lease.rs gate，按设备直接判定，省端口键中转）
        let leases = self.leases.list();
        if !leases
            .iter()
            .any(|l| l.token == token && l.grants.iter().any(|g| g.device == dev.id))
        {
            let holder = self.leases.lease_of_device(&dev.id);
            let holder_info = match &holder {
                Some(l) => format!("当前持有: {}（至 {}）", l.label, l.expires_at),
                None => "当前无人持有".into(),
            };
            return Err(format!(
                "未持设备「{}」的租约（{holder_info}）。先 acquire_lease（topology 或 devices 指定范围）",
                dev.name
            ));
        }
        Self::resolve(device_ref, channel)
    }

    /// 取（或建）会话：端口持有经 manager（已开则附加 = 连接复用），影子缓冲
    /// 按 (token, port_key) 粘住——重开同键不清零，游标跨 I/O 稳定。
    pub async fn open(
        &self,
        token: &str,
        port_key: &str,
        config: ss_core::SerialConfig,
        state: &AppState,
    ) -> Result<(), String> {
        let sid = ss_server::mcp::session_for(token);
        state
            .manager
            .acquire(port_key.to_string(), config, sid)
            .await
            .map_err(|e| format!("打开通道失败: {e}"))?;
        let mut g = self.sessions.lock().expect("session lock poisoned");
        g.entry((token.to_string(), port_key.to_string()))
            .or_default();
        Ok(())
    }

    /// 发送 + 等待响应（一次调用拿结果）。读到的字节进影子缓冲。
    /// 返回 (新增输出, 新游标, 截断标志, 超时标志)。
    pub async fn send_and_collect(
        &self,
        token: &str,
        port_key: &str,
        data: &str,
        append_newline: bool,
        wait_ms: u64,
        idle_ms: u64,
        max_bytes: usize,
        state: &AppState,
    ) -> Result<(String, usize, bool, bool), String> {
        let n = state
            .manager
            .send(port_key, data, "text", append_newline)
            .await
            .map_err(|e| format!("发送失败: {e}"))?;
        if n == 0 {
            return Err("无数据可发".into());
        }
        if wait_ms == 0 {
            return Ok((
                String::new(),
                self.shadow_len(token, port_key),
                false,
                false,
            ));
        }
        let bytes = state
            .manager
            .drain_buffer_quiet(port_key, wait_ms, idle_ms.max(50))
            .await
            .map_err(|e| format!("读取失败: {e}"))?;
        self.append_shadow(token, port_key, &bytes);
        let cursor = self.shadow_len(token, port_key);
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let timed_out = bytes.is_empty();
        let (out, truncated) = truncate_chars(&text, max_bytes);
        Ok((out, cursor, truncated, timed_out))
    }

    /// 游标读影子缓冲（非破坏）。since=None → 只等新数据（以进入时末尾为基线）。
    /// 返回 (数据, 新游标, 缺口字节数, 截断标志)。timeout_ms=0 立即返回。
    /// 等待轮询顺带把端口 rx_buffer 非阻塞 drain 进影子缓冲——wait_ms=0 的
    /// fire-and-forget 发送（send_input wait_ms=0）的设备响应靠这里入影。
    pub async fn read_since(
        &self,
        token: &str,
        port_key: &str,
        since: Option<usize>,
        timeout_ms: u64,
        max_bytes: usize,
        state: &AppState,
    ) -> Result<(String, usize, usize, bool), String> {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.min(120_000));
        // since=None：以进入时的末尾为基线，只返回此后到达的新数据（等待路径）
        let baseline = match since {
            Some(_) => 0usize,
            None => {
                let g = self.sessions.lock().expect("session lock poisoned");
                g.get(&(token.to_string(), port_key.to_string()))
                    .map(|s| s.shadow.written)
                    .ok_or_else(|| {
                        "会话不存在（先 exec_command / open_session 建立通道）".to_string()
                    })?
            }
        };
        loop {
            let snap = {
                let g = self.sessions.lock().expect("session lock poisoned");
                let Some(s) = g.get(&(token.to_string(), port_key.to_string())) else {
                    return Err("会话不存在（先 exec_command / open_session 建立通道）".into());
                };
                let sh = &s.shadow;
                match since {
                    Some(c) => {
                        // 缺口 = 窗口起点 - 游标（游标早于窗口 → 丢了数据）；游标晚于
                        // written（不该出现的超前游标）无缺口
                        let dropped = if c < sh.start { sh.start - c } else { 0 };
                        let pos = sh.pos(c);
                        let (start, end): (usize, usize) = match pos {
                            Some(p) => {
                                let avail_end = sh.buf.len();
                                (p.min(avail_end), avail_end)
                            }
                            None => {
                                // 游标早于滚动窗口（有缺口）从窗口头读；晚于末尾视为无新数据
                                if c > sh.written {
                                    (sh.buf.len(), sh.buf.len())
                                } else {
                                    (0, sh.buf.len())
                                }
                            }
                        };
                        let take = end.saturating_sub(start).min(max_bytes);
                        let data = sh.buf[start..start + take].to_vec();
                        (
                            data,
                            sh.start + start + take,
                            dropped,
                            take == max_bytes && start + take < end,
                        )
                    }
                    None => {
                        // 只读新数据：与进入时的基线比对，等待期间 append 的部分
                        let from = sh.pos(baseline).unwrap_or(sh.buf.len()).min(sh.buf.len());
                        let take = (sh.buf.len() - from).min(max_bytes);
                        let data = sh.buf[from..from + take].to_vec();
                        (
                            data,
                            sh.start + from + take,
                            0,
                            take == max_bytes && from + take < sh.buf.len(),
                        )
                    }
                }
            };
            let (data, cursor, dropped, truncated) = snap;
            let has_new = match since {
                Some(c) => cursor > c,
                None => cursor > baseline,
            };
            if has_new || timeout_ms == 0 {
                return Ok((
                    String::from_utf8_lossy(&data).into_owned(),
                    cursor,
                    dropped,
                    truncated,
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Ok((String::new(), since.unwrap_or(baseline), 0, false));
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            // 顺带收割端口 rx_buffer（非阻塞 drain 进影子缓冲）——覆盖
            // send_input(wait_ms=0) 后设备迟到的响应/异步 debug 输出
            if let Ok(bytes) = state.manager.drain_buffer_quiet(port_key, 0, 0).await {
                if !bytes.is_empty() {
                    self.append_shadow(token, port_key, &bytes);
                }
            }
        }
    }

    /// 关闭会话：释放端口持有（末位持有者才真正关物理连接）+ 移除影子缓冲。
    pub async fn close(
        &self,
        token: &str,
        port_key: &str,
        state: &AppState,
    ) -> Result<bool, String> {
        {
            let mut g = self.sessions.lock().expect("session lock poisoned");
            g.remove(&(token.to_string(), port_key.to_string()));
        }
        let Some(sid) = ss_server::mcp::mcp_session_of(token) else {
            return Ok(false);
        };
        state
            .manager
            .release(port_key, sid)
            .await
            .map(|_| true)
            .map_err(|e| format!("关闭失败: {e}"))
    }

    /// 租约释放/到期联动：收回该 token 在指定设备集上的会话连接与影子缓冲。
    /// （release/sweep/force 路径调用；与 lease.rs 强释放收口同机制。）
    pub async fn reclaim_for_devices(
        &self,
        token: &str,
        device_ids: &[String],
        state: &AppState,
    ) -> Vec<String> {
        let mut targets: Vec<String> = Vec::new();
        let mut missing = false;
        for id in device_ids {
            match device::find(id) {
                Some(dev) => {
                    for ch in &dev.channels {
                        match ch {
                            Channel::Serial { port, .. } => targets.push(port.clone()),
                            Channel::Ssh(s) => targets.push(format!("{}::shell", s.id)),
                        }
                    }
                }
                None => missing = true,
            }
        }
        // 设备已删除（grant 指向幽灵设备）→ 通道反查失效。兜底：该 token 的
        // 全部会话一并收回（租约本来就只授权这些设备，宁可多收不漏收）。
        if missing {
            let keys: Vec<String> = {
                let g = self.sessions.lock().expect("session lock poisoned");
                g.keys()
                    .filter(|(t, _)| t == token)
                    .map(|(_, p)| p.clone())
                    .collect()
            };
            targets.extend(keys);
        }
        let mut closed = Vec::new();
        for port in targets {
            match self.close(token, &port, state).await {
                Ok(true) => closed.push(port),
                _ => {}
            }
        }
        closed
    }

    fn append_shadow(&self, token: &str, port_key: &str, bytes: &[u8]) {
        let mut g = self.sessions.lock().expect("session lock poisoned");
        g.entry((token.to_string(), port_key.to_string()))
            .or_default()
            .shadow
            .append(bytes);
    }

    fn shadow_len(&self, token: &str, port_key: &str) -> usize {
        let g = self.sessions.lock().expect("session lock poisoned");
        g.get(&(token.to_string(), port_key.to_string()))
            .map(|s| s.shadow.written)
            .unwrap_or(0)
    }
}

/// 按字符数截断（UTF-8 安全），返回 (截断后文本, 是否截断)。
fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((idx, _)) => (text[..idx].to_string(), true),
        None => (text.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{Channel, DeviceInput};
    use crate::lease::{LeaseConfig, LeaseManager};
    use crate::test_support::{ensure_test_config_dir, make_state, unique_name, STORE_LOCK};

    /// 影子缓冲：append → 游标读 → 增量读 → 滚动缺口标注。
    #[test]
    fn shadow_cursor_and_rollover() {
        let mut sh = Shadow::default();
        sh.append(b"hello");
        assert_eq!(sh.pos(0), Some(0));
        assert_eq!(sh.pos(5), Some(5));
        assert_eq!(sh.pos(6), None, "晚于末尾");
        sh.append(b" world");
        assert_eq!(sh.written, 11);
        // 滚动：写超上限（测试中直接构造大写入走 SHADOW_MAX 上限）
        let big = vec![b'x'; SHADOW_MAX];
        sh.append(&big);
        assert!(sh.start > 0, "应丢弃最旧: start={}", sh.start);
        assert_eq!(sh.buf.len(), SHADOW_MAX);
        // 早于窗口的游标 → pos None（读侧标 dropped）
        assert_eq!(sh.pos(0), None);
        assert_eq!(sh.pos(sh.start), Some(0));
    }

    /// 截断按字符（UTF-8 安全）。
    #[test]
    fn truncate_chars_utf8_safe() {
        let s = "你好世界";
        let (out, truncated) = truncate_chars(s, 2);
        assert_eq!(out, "你好");
        assert!(truncated);
        let (out, truncated) = truncate_chars(s, 10);
        assert_eq!(out, s);
        assert!(!truncated);
    }

    /// resolve：缺省通道规则（首个串口；无串口取首个 SSH）+ 序号 + 越界。
    #[test]
    fn resolve_channel_rules() {
        let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let _ = state;
        // 造设备：串口 + 两条 SSH（串口在前测缺省=串口）
        let name = unique_name("解析设备");
        let dev = crate::device::create(
            &DeviceInput {
                name: name.clone(),
                model: String::new(),
                location: String::new(),
                channels: vec![
                    Channel::Ssh(crate::device::SshChannelConfig::ssh_fixture("ssh-admin-id")),
                    Channel::Serial {
                        port: "COM99".into(),
                        config: Default::default(),
                    },
                ],
            },
            &state,
        )
        .unwrap();
        assert_eq!(dev.channels.len(), 2);

        // 缺省 = 首个串口（不是首个通道）
        let rc = SessionManager::resolve(&name, None).unwrap();
        assert!(rc.serial);
        assert_eq!(rc.port_key, "COM99");
        // 序号 0 = SSH 通道
        let rc = SessionManager::resolve(&name, Some("0")).unwrap();
        assert!(!rc.serial);
        assert_eq!(rc.port_key, "ssh-admin-id::shell");
        // 越界
        assert!(SessionManager::resolve(&name, Some("2").into())
            .unwrap_err()
            .contains("超出范围"));
        // 标签子串：label（含 username）
        let rc = SessionManager::resolve(&name, Some("root@")).unwrap();
        assert!(!rc.serial);
        // 无匹配
        assert!(SessionManager::resolve(&name, Some("不存在的通道"))
            .unwrap_err()
            .contains("无匹配通道"));
        // 设备不存在
        assert!(SessionManager::resolve("幽灵设备-xyz", None)
            .unwrap_err()
            .contains("设备不存在"));
    }

    /// io_gate：租约即写权（无租约拒绝并引导；持租约放行）。
    #[tokio::test]
    async fn io_gate_requires_lease() {
        let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        ensure_test_config_dir();
        crate::test_support::reset_stores();
        let state = make_state();
        let (tx, _) = tokio::sync::broadcast::channel(16);
        let leases = LeaseManager::new(LeaseConfig::default(), tx);
        let sm = SessionManager::new(std::sync::Arc::clone(&leases));

        let name = unique_name("闸设备");
        crate::device::create(
            &DeviceInput {
                name: name.clone(),
                model: String::new(),
                location: String::new(),
                channels: vec![Channel::Serial {
                    port: "COM99".into(),
                    config: Default::default(),
                }],
            },
            &state,
        )
        .unwrap();

        // 匿名 → 引导会话标识
        let e = sm.io_gate(None, &name, None).unwrap_err();
        assert!(e.contains("会话标识"));
        // 有会话无租约 → 引导 acquire_lease
        let e = sm.io_gate(Some("tok-1"), &name, None).unwrap_err();
        assert!(e.contains("acquire_lease"));
        // 持租约 → 放行（解析出端口键）
        leases
            .acquire(
                "tok-1",
                "测试",
                &crate::lease::Scope {
                    topology: None,
                    devices: vec![name.clone()],
                    endpoints: vec![],
                },
                None,
            )
            .unwrap();
        let rc = sm.io_gate(Some("tok-1"), &name, None).unwrap();
        assert_eq!(rc.port_key, "COM99");
        // 他会话 → 拒绝并报持有者
        let e = sm.io_gate(Some("tok-2"), &name, None).unwrap_err();
        assert!(e.contains("测试") && e.contains("acquire_lease"));
    }

    /// send_and_collect + read_since：影子缓冲游标（模拟端口不可用，走纯缓冲逻辑
    /// 需要 open 端口——此测试锁定 wait_ms=0 的纯游标行为 + read_since 的等待路径）。
    #[tokio::test]
    async fn read_since_waits_and_cursors() {
        let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        ensure_test_config_dir();
        let state = make_state();
        let (tx, _) = tokio::sync::broadcast::channel(16);
        let leases = LeaseManager::new(LeaseConfig::default(), tx);
        let sm = SessionManager::new(leases);
        // 直接注入影子缓冲（绕过 open——open 需要真实端口）
        sm.append_shadow("tok", "PORT", b"first\n");
        let (data, cursor, dropped, truncated) = sm
            .read_since("tok", "PORT", Some(0), 0, 1024, &state)
            .await
            .unwrap();
        assert_eq!(data, "first\n");
        assert_eq!(cursor, 6);
        assert_eq!(dropped, 0);
        assert!(!truncated);
        // since=cursor 读增量（暂无新数据 → timeout 0 立即空返回；dropped 必须为 0——
        // 游标追平时报缺口是 read_output 最高频路径的误报源）
        let (data, c2, dropped2, _) = sm
            .read_since("tok", "PORT", Some(6), 0, 1024, &state)
            .await
            .unwrap();
        assert_eq!(data, "");
        assert_eq!(c2, 6);
        assert_eq!(dropped2, 0, "游标追平不应报缺口");
        // 追加后增量可见
        sm.append_shadow("tok", "PORT", b"second");
        let (data, c3, ..) = sm
            .read_since("tok", "PORT", Some(6), 0, 1024, &state)
            .await
            .unwrap();
        assert_eq!(data, "second");
        assert_eq!(c3, 12);

        // 滚动缺口：写超 SHADOW_MAX 丢最旧，早于窗口的游标报 dropped=窗口起点-游标
        {
            let mut g = sm.sessions.lock().unwrap();
            let sh = &mut g
                .get_mut(&("tok".to_string(), "PORT".to_string()))
                .unwrap()
                .shadow;
            let big = vec![b'x'; SHADOW_MAX];
            sh.append(&big);
            assert!(sh.start > 0);
            let start = sh.start;
            drop(g);
            let (data, _, dropped, _) = sm
                .read_since("tok", "PORT", Some(0), 0, 1024, &state)
                .await
                .unwrap();
            assert_eq!(dropped, start, "缺口=窗口起点-游标");
            assert!(
                data.chars().all(|c| c == 'x') || data.is_empty(),
                "从窗口头读"
            );
        }

        // since=None + timeout_ms：基线之后无新数据 → 等满超时返回空（而非立即返回）
        {
            let sm2 = {
                let (tx, _) = tokio::sync::broadcast::channel(16);
                SessionManager::new(LeaseManager::new(LeaseConfig::default(), tx))
            };
            sm2.append_shadow("tok2", "PORT", "历史输出".as_bytes());
            let t0 = std::time::Instant::now();
            let (data, _, _, _) = sm2
                .read_since("tok2", "PORT", None, 300, 1024, &state)
                .await
                .unwrap();
            assert!(
                t0.elapsed() >= std::time::Duration::from_millis(280),
                "应等满超时"
            );
            assert_eq!(data, "", "基线后无新数据不应返回历史");
            // 有新数据则提前返回
            let sm3 = sm2.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                sm3.append_shadow("tok2", "PORT", "新数据".as_bytes());
            });
            let (data, ..) = sm2
                .read_since("tok2", "PORT", None, 3000, 1024, &state)
                .await
                .unwrap();
            assert_eq!(data, "新数据");
        }

        // 无会话 → 引导建立
        assert!(sm
            .read_since("tok", "NO-SUCH-PORT", None, 0, 1024, &state)
            .await
            .unwrap_err()
            .contains("会话不存在"));
    }
}

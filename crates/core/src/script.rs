//! 脚本执行:嵌入 QuickJS(rquickjs),JS 脚本 await 驱动串口 IO。
//!
//! rquickjs 的 future **非 `Send`**(QuickJS 用裸指针,非线程安全),不能直接进 axum
//! handler 或 `tokio::spawn`(都要求 `Send`)。故 [`run_script_with_timeout`] 在**独立 OS
//! 线程**的 current_thread runtime 内执行脚本(线程内 future 无需 `Send`),经 `oneshot`
//! 回结果——对外暴露的 future 只含 `oneshot`(`Send`),可安全用于 axum / spawn。
//!
//! 死循环/超时保护双层:
//! - 内层:[`run_script_inner`] 的 `tokio::time::timeout` + QuickJS interrupt handler(在脚本线程)。
//! - 外层:[`run_script_with_timeout`] 的 `oneshot` 超时(主线程,兜底防脚本线程卡死)。
//!
//! 暴露的全局 async 函数:send / expect / clear / sleep(以及同步函数 log,输出脚本日志)。send/expect/clear 尾参为可选 `port`(缺省=脚本绑定的端口,可传其它已打开端口以跨多串口)。脚本被包成 `(async () => { ... })()` 求值。
//!
//! 同步文件函数:read_file(全量文本,上限 64MiB)/ read_b64_chunk(按块 base64 随机访问,块须
//! ≥3、3 的倍数且 ≤1MiB,越界返空串)/ file_stat(exists/size JSON)/ file_md5(流式 hex)。
//!
//! v1 限制(后续完善):
//! - 串口原语失败用 tracing 记录、不抛 JS 异常(rquickjs `Async` 闭包的 `Ctx<'js>` 生命周期短于
//!   返回 future,无法 move 进 async 块抛异常)。用户脚本自己的 `throw` 经 `into_future` 正常传播。
//!   注意:`sleep`/`expect` 的**停止**走另一条路——主动返 `Err(rquickjs::Error)`(无需 Ctx)→ await
//!   reject → 抛异常中断脚本。这与「原语失败吞错」不冲突(失败是 Ok 路径吞,停止是主动 Err)。
//! - API 暂为全局函数,后续收敛为 `serial` 对象。
//! - 脚本 `log(msg)` 输出经 EventBus(`SerialEvent::ScriptLog`)流到前端(WS/Tauri 两出口),按 run_id 路由;
//!   MCP 路径不订阅 EventBus,但 MCP 入口 [`run_script`] 内建 [`ScriptLogSink`] 收集 log() 输出,
//!   随 [`ScriptRunOutcome`] 返回给调用方拼进 JSON-RPC 响应——两条路径都能看到日志。

use crate::event_bus::SerialEvent;
use crate::manager::SerialManager;
use rquickjs::prelude::{Async, Func};
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Ctx, Promise};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    #[error("脚本引擎错误: {0}")]
    Engine(String),
    #[error("脚本执行超时")]
    Timeout,
    #[error("脚本异常: {0}")]
    Script(String),
    /// 外部请求停止(停止按钮 / abort flag)。
    #[error("脚本已停止")]
    Aborted,
}

impl ScriptError {
    /// 面向用户/远程的消息:Engine 类不回显内部文本(避免把 rquickjs/OS 错误细节泄漏给远程
    /// WS/MCP 客户端),Script 透传用户 throw 的消息,Timeout/Aborted 给固定文本。
    /// WS/MCP 回显用此而非 `Display`(后者对 Engine 会带内部字符串)。
    pub fn display_message(&self) -> String {
        match self {
            ScriptError::Engine(_) => "脚本引擎错误".into(),
            ScriptError::Timeout => "脚本执行超时".into(),
            ScriptError::Script(s) => s.clone(),
            ScriptError::Aborted => "已停止".into(),
        }
    }
}

/// MCP 路径(`serial_debug_script`/`serial_run_script`)的执行超时兜底。WS/UI 路径传 None(无限制),不走这里。
/// MCP 脚本当前无手动停止手段(无 stop 工具 + abort 不外露),此超时是其唯一退出兜底,
/// 故不可去掉——否则死循环脚本永久占用并发槽。后续加 serial_stop_script 后可重评。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
/// 外层 oneshot 兜底超时相对内层的额外宽限(内层 timeout 先生效;此处仅兜底脚本线程卡死)。
const OUTER_TIMEOUT_GRACE: Duration = Duration::from_secs(2);
/// None 超时路径(WS/Tauri,长跑)的极大兜底:防 rquickjs C-level hang 时调用方永挂、注册表/permit
/// 永久泄漏。远大于正常复现时长(数天),正常脚本不应触达;命中按 Timeout(线程仍泄漏,v1 限制)。
const NONE_FALLBACK_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 3600);
/// ScriptLogSink 单条消息上限:脚本可能 dump 整段接收缓冲区,超长单条截断,否则总量上限形同虚设。
const MAX_LOG_ENTRY_BYTES: usize = 4 * 1024;
/// ScriptLogSink 收集上限:最多 200 条 / 总量 16 KiB(日志整段进 MCP 响应 → AI 上下文,须防膨胀)。
/// 超限丢最旧保最新——失败点附近的最新日志对调试价值最高。
const MAX_LOG_ENTRIES: usize = 200;
const MAX_LOG_TOTAL_BYTES: usize = 16 * 1024;

/// 脚本 `log()` 输出的收集器(MCP 路径用)。
///
/// `push` 在脚本线程的 QuickJS 同步闭包里调用(短临界区、无 await),`std::sync::Mutex` 即可;
/// 读取发生在脚本结束后(调用方持有 Clone 的 Arc,脚本线程 panic/超时也不影响可读)。
/// 容量上限见上方 const:单条截断 + 总量丢最旧,`dropped_count` 记丢弃条数,`logs()` 返回时
/// 自动在头部拼 `(前 N 条日志已丢弃)`——调用方零感知、不会漏拼。
#[derive(Clone, Default)]
pub struct ScriptLogSink {
    inner: Arc<Mutex<ScriptLogSinkInner>>,
}

#[derive(Default)]
struct ScriptLogSinkInner {
    entries: VecDeque<String>,
    total_bytes: usize,
    dropped_count: usize,
}

impl ScriptLogSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加一条日志(单条超长截断;总量/条数超限丢最旧)。
    pub fn push(&self, message: String) {
        // 中毒也继续:数据是纯 append 日志,持锁 panic 后恢复读取无害(勿让 MCP handler 二次 panic)。
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let message = if message.len() > MAX_LOG_ENTRY_BYTES {
            let mut cut = String::new();
            // 按字节边界截断(中文多字节,截到 char 边界)。
            for (i, c) in message.char_indices() {
                if i + c.len_utf8() > MAX_LOG_ENTRY_BYTES {
                    break;
                }
                cut.push(c);
            }
            cut.push_str("…(截断)");
            cut
        } else {
            message
        };
        // 先逐字节数计(粗略,UTF-8 前缀 char_indices 截断后的 cut 长度 ≤ 上限)。
        inner.total_bytes += message.len();
        inner.entries.push_back(message);
        while inner.entries.len() > MAX_LOG_ENTRIES
            || (inner.total_bytes > MAX_LOG_TOTAL_BYTES && inner.entries.len() > 1)
        {
            let dropped = inner.entries.pop_front();
            match dropped {
                Some(d) => {
                    inner.total_bytes -= d.len();
                    inner.dropped_count += 1;
                }
                None => break,
            }
        }
    }

    /// 读取已收集日志(克隆;≤16 KiB 成本可忽略)。若有丢弃,首条为 `(前 N 条日志已丢弃)`。
    pub fn logs(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::with_capacity(inner.entries.len() + 1);
        if inner.dropped_count > 0 {
            out.push(format!("(前 {} 条日志已丢弃)", inner.dropped_count));
        }
        out.extend(inner.entries.iter().cloned());
        out
    }
}

/// MCP 入口 [`run_script`] 的执行结果:成败 + 脚本 `log()` 收集的日志。
///
/// MCP 是同步请求/响应,无法中途推日志;日志缓冲随结果一次性返回(成功/失败/超时均带)。
pub struct ScriptRunOutcome {
    pub result: Result<(), ScriptError>,
    /// 脚本 log() 输出(可能为空;超限已截断,见 [`ScriptLogSink`])。
    pub logs: Vec<String>,
}

/// 一个脚本参数定义(string / select / file)。运行时收集值注入 QuickJS 的 `args.<name>`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScriptParam {
    /// 脚本里 `args.<name>` 取值的键名。
    pub name: String,
    /// UI 显示标签;缺省用 name。
    #[serde(default)]
    pub label: Option<String>,
    /// "string" | "select" | "file"(`#[serde(rename)]` 因 type 是 Rust 关键字)。
    /// file:值为文件路径 string,UI 采集时带文件选择按钮;select 用 options 下拉。
    #[serde(rename = "type")]
    pub kind: String,
    /// 缺省值(运行收集时预填)。
    #[serde(default)]
    pub default: Option<String>,
    /// select 的可选项;string/file 类型留空。
    #[serde(default)]
    pub options: Vec<String>,
}

/// 一个脚本定义(对齐 [`crate::Macro`])。
///
/// `code` 为 JS 源码,被包成 `(async () => { ... })()` 求值,顶层可直接 `await`。
/// `params` 为声明的运行时参数(持久化进 scripts.json);运行收集的值经 `run_script` 的
/// `args` 参数注入,不入库。超时由执行入口默认 300s 或显式传入(见 [`run_script_with_timeout`]),
/// 不入库——与宏不在 `Macro` 顶层存 timeout 一致。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Script {
    #[serde(default)]
    pub description: Option<String>,
    /// 分组名(侧栏按组折叠);空 = 未分组。
    #[serde(default)]
    pub group: Option<String>,
    /// 声明的运行时参数(string/select/file),持久化进 scripts.json。旧脚本缺省为空。
    #[serde(default)]
    pub params: Vec<ScriptParam>,
    pub code: String,
}

/// 文件函数上限。`read_b64_chunk` 的块即单次内存峰值,封顶防脚本传超大值在 Rust 侧
/// 直接分配(QuickJS 的 64MiB 堆限制管不到这里,极端值触发 alloc_error 会 abort 全进程);
/// `read_file` 全量进内存,与 SKILL.md "小文件" 契约一致设 64MiB。
const FILE_CHUNK_MAX: u64 = 1024 * 1024;
const FILE_READ_MAX: u64 = 64 * 1024 * 1024;

/// 读类文件函数的常规文件预检:目录/命名管道/设备等非常规路径直接 throw——
/// 对它们做阻塞读会卡死脚本线程(中断机制打不穿陷入 syscall 的线程)并泄漏句柄。
/// 返回 Metadata 供大小上限检查复用(file_stat 的 exists 语义同款)。
fn regular_file_meta(
    ctx: &Ctx<'_>,
    fn_name: &str,
    path: &str,
) -> rquickjs::Result<std::fs::Metadata> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(m),
        Ok(_) => Err(rquickjs::Exception::throw_message(
            ctx,
            &format!("{fn_name} {path}: 不是常规文件(目录/设备/管道不支持)"),
        )),
        Err(e) => Err(rquickjs::Exception::throw_message(
            ctx,
            &format!("{fn_name} {path}: {e}"),
        )),
    }
}

/// 执行一段 JS 脚本(MCP 路径:默认 300s 超时,不暴露停止)。`args` 为运行时参数值,注入 `args.<name>`。
///
/// MCP 是同步请求/响应,客户端无法中途喊停,且无限 JSON-RPC 调用有 DoS 风险,故保留超时兜底;
/// 内部建一个永不 set 的 abort flag。WS/Tauri 路径请直接调 [`run_script_with_timeout`]
/// 传 `None` 超时 + 外部 abort(支持长跑 + 停止按钮)。
pub async fn run_script(
    port: &str,
    script: &Script,
    manager: Arc<SerialManager>,
    args: HashMap<String, String>,
) -> ScriptRunOutcome {
    let abort = Arc::new(AtomicBool::new(false));
    // MCP 是同步 JSON-RPC,无实时日志出口;run_id="" → publish 的 ScriptLog 无订阅者被丢(见 event_to_msg 不转发)。
    // 故内建 sink 收集 log() 输出,随 ScriptRunOutcome 一次性返回给 MCP 调用方拼进响应。
    let sink = ScriptLogSink::new();
    let result = run_script_with_timeout(
        port,
        &script.code,
        manager,
        Some(DEFAULT_TIMEOUT),
        args,
        "",
        abort,
        Some(sink.clone()),
    )
    .await;
    // 读取时序:Ok/失败/panic 路径经 oneshot happens-before,所有 push 已完成,快照完备;
    // 外层兜底超时(脚本线程卡死)路径线程可能仍在 push——Mutex 下读取安全,只是快照可能
    // 不完整,晚到的 push 写进没人再读的 sink,无副作用。
    ScriptRunOutcome {
        result,
        logs: sink.logs(),
    }
}

/// 执行一段 JS 脚本,注入串口原语。
///
/// 在独立 OS 线程的 current_thread runtime 跑脚本(隔离 rquickjs 非 Send future),主线程经
/// oneshot 收结果——对外 future 是 `Send`。
///
/// - `timeout`:总执行上限。`Some` 时内层 tokio timeout + interrupt deadline + 外层 oneshot 兜底
///   (防线程 C-level hang);`None` 时无总超时(长跑),靠 `abort` + interrupt(字节码边界触发)
///   + 64MiB/4MiB 内存栈上限兜底。停止经 interrupt 让线程干净退出(不泄漏)。
/// - `abort`:外部停止信号,set 后 interrupt 在下个字节码边界抛异常,脚本退出。调用方持有克隆
///   以便注册到停止注册表(ws.rs / main.rs 的 `script_runs`)。
#[allow(clippy::too_many_arguments)] // 参数组随功能演进增长;收敛成 config struct 的收益暂不抵改动面
pub async fn run_script_with_timeout(
    port: &str,
    code: &str,
    manager: Arc<SerialManager>,
    timeout: Option<Duration>,
    args: HashMap<String, String>,
    run_id: &str, // 本次运行标识:脚本 log() 输出按此路由到前端(WS/Tauri);MCP 入口传 ""
    abort: Arc<AtomicBool>,
    log_sink: Option<ScriptLogSink>, // Some 时 log() 双写:publish(前端)+ sink(MCP 随结果返回);None = 仅现状
) -> Result<(), ScriptError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), ScriptError>>();
    let port = port.to_string();
    let code = code.to_string();
    let run_id = run_id.to_string();
    // 独立 OS 线程 + current_thread runtime:内部 future(含 rquickjs 非 Send)无需跨线程。
    // abort 克隆一份进线程(interrupt handler 用);原 abort 留给尾部 map_aborted 判停止。
    let abort_for_thread = abort.clone();
    std::thread::spawn(move || {
        // catch_unwind:rt.block_on 若 panic(rquickjs 在畸形输入下可能),转成 Engine 错误,
        // 否则 panic 会让 tx drop → 主线程只收到误导性的"通道关闭"。
        let run = std::panic::AssertUnwindSafe(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| ScriptError::Engine(format!("创建脚本线程 runtime 失败: {e}")))?;
            rt.block_on(run_script_inner(
                port,
                code,
                manager,
                timeout,
                args,
                run_id,
                abort_for_thread,
                log_sink,
            ))
        });
        let result = match std::panic::catch_unwind(run) {
            Ok(r) => r,
            Err(payload) => Err(ScriptError::Engine(format!("脚本线程 panic: {payload:?}"))),
        };
        let _ = tx.send(result);
    });
    // 外层兜底:仅在有总超时(MCP)时启用——脚本线程异常卡死(rquickjs C-level hang)时给调用方
    // 返回 Timeout,否则线程泄漏(持 AsyncRuntime 到进程退出)。WS/Tauri 路径 timeout=None,纯
    // await:停止经 interrupt 让线程干净退出,不 detach、不泄漏。结果统一过 map_aborted 把中断
    // (abort 已 set)映射为 Aborted,前端显「已停止」。
    match timeout {
        Some(t) => match tokio::time::timeout(t + OUTER_TIMEOUT_GRACE, rx).await {
            Ok(Ok(result)) => map_aborted(result, &abort),
            Ok(Err(_)) => Err(ScriptError::Script("脚本执行通道关闭".into())),
            Err(_) => Err(ScriptError::Timeout),
        },
        None => match tokio::time::timeout(NONE_FALLBACK_TIMEOUT, rx).await {
            Ok(Ok(result)) => map_aborted(result, &abort),
            Ok(Err(_)) => Err(ScriptError::Script("脚本执行通道关闭".into())),
            // 极大兜底命中:C-level hang(极罕见),返回 Timeout 让调用方脱困(线程泄漏不可避免)
            Err(_) => Err(ScriptError::Timeout),
        },
    }
}

/// 停止(abort 已 set)覆盖结果:中断经 interrupt 抛 JS 异常,本是 `Script(msg)`;若 abort 已置位,
/// 统一映射为 `Aborted`。脚本正常完成与停止的竞态(abort 恰在结束后 set)不覆盖——仅在 Err 时生效。
fn map_aborted(result: Result<(), ScriptError>, abort: &AtomicBool) -> Result<(), ScriptError> {
    match result {
        Err(_) if abort.load(Ordering::Relaxed) => Err(ScriptError::Aborted),
        other => other,
    }
}

/// 轮询 abort flag(≤50ms 响应)——供 expect 的 `select!` 用:grep_buffer 是一次性长 await,
/// 此 future 让 expect 也能被停止信号打断(返 Err 抛 JS 异常)。sleep 原语自己分段轮询,不用这个。
async fn await_abort(abort: Arc<AtomicBool>) {
    while !abort.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 脚本实际执行(在独立线程的 current_thread runtime 内,future 无需 `Send`)。
#[allow(clippy::too_many_arguments)] // 同 run_script_with_timeout,内部穿透传参
async fn run_script_inner(
    port: String,
    code: String,
    manager: Arc<SerialManager>,
    timeout: Option<Duration>,
    args: HashMap<String, String>,
    run_id: String, // 脚本 log() 按此路由到前端(WS/Tauri);MCP 传 ""
    abort: Arc<AtomicBool>,
    log_sink: Option<ScriptLogSink>,
) -> Result<(), ScriptError> {
    let deadline = timeout.as_ref().map(|t| Instant::now() + *t);

    // 绑定端口经 canon_key 规范化+别名解析(裸名/端口别名/设备昵称作用域 → map 键)。
    // 原语的显式 port 参数无需在此处理——它们直连 manager 方法,方法入口自带 canon。
    let port = manager.canon_key(&port);

    // exec 在 tokio timeout 包裹下跑:到点未完成即 drop(中止 JS),返回 Timeout。
    let exec = async move {
        let rt = AsyncRuntime::new().map_err(|e| ScriptError::Engine(e.to_string()))?;
        let ctx = AsyncContext::full(&rt)
            .await
            .map_err(|e| ScriptError::Engine(e.to_string()))?;

        // 中断 JS 的两道闸(任一命中 → QuickJS 抛 JS 异常):
        // ① interrupt handler(字节码边界调用)——拦纯 CPU 循环,但 await 密集时不及时;
        // ② sleep 分段轮询 abort 返 Err——await 循环(采集脚本主形态)靠这道,秒级停止。
        let abort_irq = abort.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            abort_irq.load(Ordering::Relaxed)
                || deadline.map(|d| Instant::now() >= d).unwrap_or(false)
        })))
        .await;
        // 资源上限:interrupt 只在字节码之间触发,拦不住单条字节码内的分配/递归(无限数组、
        // 深递归会 OOM/爆栈)。用 QuickJS 内存/栈上限兜底,命中即抛 JS 异常,被 catch 提取。
        rt.set_memory_limit(64 * 1024 * 1024).await; // 64 MiB
        rt.set_max_stack_size(4 * 1024 * 1024).await; // 4 MiB

        let outcome: Result<(), String> = ctx
            .async_with(async |ctx| {
                let globals = ctx.globals();

                // send(data, [port]):text + 按端口 line_ending 自动追加换行。port 缺省=脚本绑定端口。
                // 失败返 Some(msg) 而非吞错:JS 包装层(见下)据此 throw 干净消息——绕过 rquickjs
                // async future 内无法抛带消息异常的限制(spike 验证,见文件头注释)。
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    globals.set(
                        "send",
                        Func::from(Async(move |data: String, port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            async move {
                                match mgr.send(&p, &data, "text", true).await {
                                    Ok(_) => Ok::<Option<String>, rquickjs::Error>(None),
                                    Err(e) => {
                                        tracing::error!("脚本 send 失败: {}", e);
                                        let where_ = if p.is_empty() { "未指定端口".to_string() } else { format!("端口 {}", p) };
                                        Ok(Some(format!("send 失败({}): {e}", where_)))
                                    }
                                }
                            }
                        })),
                    ).map_err(|e| e.to_string())?;
                }

                // expect(pattern, timeout_ms, [port]):返回首条正则匹配行(无匹配返回空串)。port 缺省=脚本绑定端口。
                // select! 包 grep_buffer vs await_abort:停止信号能打断长 expect(否则要等满 timeout_ms)。
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    let abort_exp = abort.clone();
                    globals.set(
                        "expect",
                        Func::from(Async(move |pattern: String, timeout_ms: u64, port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            let abort_exp = abort_exp.clone();
                            async move {
                                tokio::select! {
                                    res = mgr.grep_buffer(&p, &pattern, timeout_ms) => match res {
                                        Ok(lines) => Ok::<_, rquickjs::Error>(
                                            lines.into_iter().next().unwrap_or_default(),
                                        ),
                                        Err(e) => {
                                            tracing::error!("脚本 expect 失败: {}", e);
                                            Ok(String::new())
                                        }
                                    },
                                    _ = await_abort(abort_exp) => Err(rquickjs::Error::Unknown),
                                }
                            }
                        })),
                    ).map_err(|e| e.to_string())?;
                }

                // clear([port]):清空接收缓冲区。port 缺省=脚本绑定端口。
                // 失败返 Some(msg) → JS 包装层 throw(同 send 模式,绕过 rquickjs 异步异常限制)。
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    globals.set(
                        "clear",
                        Func::from(Async(move |port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            async move {
                                match mgr.clear_buffer(&p).await {
                                    Ok(_) => Ok::<Option<String>, rquickjs::Error>(None),
                                    Err(e) => {
                                        tracing::error!("脚本 clear 失败: {}", e);
                                        let where_ = if p.is_empty() { "未指定端口".to_string() } else { format!("端口 {}", p) };
                                        Ok(Some(format!("clear 失败({}): {e}", where_)))
                                    }
                                }
                            }
                        })),
                    ).map_err(|e| e.to_string())?;
                }

                // sleep(ms):tokio 原语在 native async function 内可用。
                // 分段(≤50ms)轮询 abort:命中即返 Err → rquickjs 抛 JS 异常 → 脚本及时停止。
                // 采集脚本(while { send; expect; sleep })主 await 在此,故停止 ≤ expect_timeout + 50ms。
                {
                    let abort_sleep = abort.clone();
                    globals.set(
                        "sleep",
                        Func::from(Async(move |ms: u64| {
                            let abort_sleep = abort_sleep.clone();
                            async move {
                                let mut remaining = Duration::from_millis(ms);
                                let chunk = Duration::from_millis(50);
                                loop {
                                    // 循环顶检查:保证 sleep(0)(remaining=0)也响应停止,不被跳过
                                    if abort_sleep.load(Ordering::Relaxed) {
                                        return Err(rquickjs::Error::Unknown);
                                    }
                                    if remaining == Duration::ZERO {
                                        break;
                                    }
                                    let step = remaining.min(chunk);
                                    tokio::time::sleep(step).await;
                                    remaining = remaining.saturating_sub(step);
                                }
                                Ok::<_, rquickjs::Error>(())
                            }
                        })),
                    ).map_err(|e| e.to_string())?;
                }

                // log(message):脚本日志输出(不中断脚本,区别 throw)。同步 publish ScriptLog →
                // EventBus → 前端(按 run_id 路由)。必须同步:若用 Async 包装,JS 不 await 则 future 不执行→丢失。
                // MCP 路径 run_id="" 且 server 不订阅 EventBus → 额外双写 sink(先 sink 后 publish,
                // 两把锁无嵌套),随 ScriptRunOutcome 返回。
                {
                    let mgr = manager.clone();
                    let rid = run_id.clone();
                    let dp = port.clone();
                    let sink = log_sink.clone();
                    globals.set(
                        "log",
                        Func::from(move |message: String| {
                            if let Some(s) = sink.as_ref() {
                                s.push(message.clone());
                            }
                            mgr.event_bus().publish(SerialEvent::ScriptLog {
                                run_id: rid.clone(),
                                port: dp.clone(),
                                message,
                            });
                        }),
                    ).map_err(|e| e.to_string())?;
                }

                // 文件函数(同步,本地 IO 快且阻塞仅影响本脚本线程):read_file 全量读(小文件;
                // 大文件用 read_b64_chunk 流式)、read_b64_chunk 按块随机访问(块对齐 3 字节
                // 保证拼接后 base64 -d 正确,支撑串口上传等 MB 级场景,内存峰值一块)、
                // file_stat/file_md5 元信息与校验(md5 流式,内存常数级)。
                // 失败直接 throw(Exception::throw_message),消息经 exc_to_msg 提取。
                {
                    globals.set(
                        "file_stat",
                        Func::from(|_ctx: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                            // 仅常规文件算 exists(目录/设备文件对"读文件上传"无意义)
                            match std::fs::metadata(&path) {
                                Ok(m) if m.is_file() => {
                                    Ok(serde_json::json!({"exists": true, "size": m.len()}).to_string())
                                }
                                _ => Ok(serde_json::json!({"exists": false}).to_string()),
                            }
                        }),
                    )
                    .map_err(|e| e.to_string())?;

                    globals.set(
                        "file_md5",
                        Func::from(|ctx: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                            let io_err =
                                |e: std::io::Error| {
                                    rquickjs::Exception::throw_message(
                                        &ctx,
                                        &format!("file_md5 {path}: {e}"),
                                    )
                                };
                            regular_file_meta(&ctx, "file_md5", &path)?;
                            let f = std::fs::File::open(&path).map_err(io_err)?;
                            let mut reader = std::io::BufReader::new(f);
                            use md5::Digest as _;
                            let mut hasher = md5::Md5::new();
                            std::io::copy(&mut reader, &mut hasher).map_err(io_err)?;
                            Ok(format!("{:x}", hasher.finalize()))
                        }),
                    )
                    .map_err(|e| e.to_string())?;

                    globals.set(
                        "read_file",
                        Func::from(|ctx: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                            let meta = regular_file_meta(&ctx, "read_file", &path)?;
                            // 全量进内存:超限直接报错,大文件走 read_b64_chunk 分块
                            if meta.len() > FILE_READ_MAX {
                                return Err(rquickjs::Exception::throw_message(
                                    &ctx,
                                    &format!(
                                        "read_file {path}: 文件 {} 字节超过 {} 字节上限,请用 read_b64_chunk 分块",
                                        meta.len(),
                                        FILE_READ_MAX
                                    ),
                                ));
                            }
                            let data = std::fs::read(&path).map_err(|e| {
                                rquickjs::Exception::throw_message(
                                    &ctx,
                                    &format!("read_file {path}: {e}"),
                                )
                            })?;
                            Ok(String::from_utf8_lossy(&data).into_owned())
                        }),
                    )
                    .map_err(|e| e.to_string())?;

                    globals.set(
                        "read_b64_chunk",
                        Func::from(
                            |ctx: Ctx<'_>,
                             path: String,
                             index: u64,
                             chunk_bytes: u64|
                             -> rquickjs::Result<String> {
                                // 契约:chunk_bytes 须为 ≥3 的 3 的倍数且 ≤1MiB——调用方按同一值
                                // 算总块数,静默对齐会造成块数错位;除末块外无 padding,
                                // 全部块拼接后 base64 -d 才正确。上限见 FILE_CHUNK_MAX。
                                if chunk_bytes < 3
                                    || !chunk_bytes.is_multiple_of(3)
                                    || chunk_bytes > FILE_CHUNK_MAX
                                {
                                    return Err(rquickjs::Exception::throw_message(
                                        &ctx,
                                        &format!(
                                            "read_b64_chunk {path}: chunk_bytes 须为 ≥3 的 3 的倍数且 ≤{FILE_CHUNK_MAX} 字节,传了 {chunk_bytes}"
                                        ),
                                    ));
                                }
                                regular_file_meta(&ctx, "read_b64_chunk", &path)?;
                                let offset = match index.checked_mul(chunk_bytes) {
                                    Some(o) => o,
                                    None => return Ok(String::new()),
                                };
                                let io_err =
                                    |e: std::io::Error| {
                                        rquickjs::Exception::throw_message(
                                            &ctx,
                                            &format!("read_b64_chunk {path}: {e}"),
                                        )
                                    };
                                use std::io::{Read, Seek, SeekFrom};
                                let mut f = std::fs::File::open(&path).map_err(io_err)?;
                                f.seek(SeekFrom::Start(offset)).map_err(io_err)?;
                                let mut buf = vec![0u8; chunk_bytes as usize];
                                let mut total = 0usize;
                                while total < buf.len() {
                                    match f.read(&mut buf[total..]) {
                                        Ok(0) => break,
                                        Ok(n) => total += n,
                                        Err(e) => return Err(io_err(e)),
                                    }
                                }
                                if total == 0 {
                                    return Ok(String::new()); // 越界(EOF):空串
                                }
                                buf.truncate(total);
                                use base64::Engine as _;
                                Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
                            },
                        ),
                    )
                    .map_err(|e| e.to_string())?;
                }

                // 注入运行时参数 args(运行收集的值):globalThis.args = { name: value, ... }。
                // 脚本里 args.<name> 直接读。Object::new 取 ctx,后续 ctx.eval 还要用,故 clone。
                {
                    let args_obj = rquickjs::Object::new(ctx.clone())
                        .map_err(|e| e.to_string())?;
                    for (k, v) in &args {
                        args_obj.set(k.as_str(), v.as_str()).map_err(|e| e.to_string())?;
                    }
                    globals.set("args", args_obj).map_err(|e| e.to_string())?;
                }

                // 可选 port 的 JS 适配:rquickjs 元组 arity 严格——JS 调 send("x") 少传参数时报
                // "1 argument(s) while 2 where expected",不会把缺失参数填 undefined→None。
                // 故在 JS 层把缺省 port 补成 null(Rust Option<String> 把 null→None),
                // 让 send/expect/clear 支持缺省 port。sleep 无 port 参数,不包装。
                ctx.eval::<(), _>(r#"const __send=globalThis.send;globalThis.send=async(d,p)=>{const r=await __send(d,typeof p==="undefined"?null:p);if(r!==undefined) throw new Error(r);};
const __expect=globalThis.expect;globalThis.expect=async(t,m,p)=>__expect(t,m,typeof p==="undefined"?null:p);
const __clear=globalThis.clear;globalThis.clear=async(p)=>{const r=await __clear(typeof p==="undefined"?null:p);if(r!==undefined) throw new Error(r);};"#)
                    .map_err(|e| e.to_string())?;

                // JS 异常 → 可读消息:必须在 ctx 还活着时用 .catch(&ctx) 捕获并提取 message。
                // 否则异常对象跨 async_with 边界带不出,e.to_string() 只剩 "Exception generated
                // by QuickJS"(丢 message,如 throw new Error("test 123") 看不到 test 123)。
                let exc_to_msg = |caught: CaughtError| -> String {
                    match caught {
                        // throw new Error("msg") 主路径,提取 message。
                        CaughtError::Exception(exc) => exc.message().unwrap_or_default(),
                        // throw 非 Error 值(throw "abc"/42,边缘):rquickjs Value 无 Display,
                        // 用 Debug 表示。主路径不受影响;后续可用 ctx.json_stringify 优化。
                        CaughtError::Value(v) => format!("{:?}", v),
                        CaughtError::Error(e) => e.to_string(),
                    }
                };
                // 包成 async IIFE 求值,返回 Promise 并 await。
                let wrapped = format!("(async () => {{\n{}\n}})()", code);
                let promise: Promise = match ctx.eval(wrapped.as_str()).catch(&ctx) {
                    Ok(p) => p,
                    Err(caught) => return Err(exc_to_msg(caught)),
                };
                if let Err(caught) = promise.into_future::<()>().await.catch(&ctx) {
                    return Err(exc_to_msg(caught));
                }
                Ok::<_, String>(())
            })
            .await;

        outcome.map_err(ScriptError::Script)
    };

    match timeout {
        Some(t) => match tokio::time::timeout(t, exec).await {
            Ok(res) => res,
            Err(_) => Err(ScriptError::Timeout),
        },
        None => exec.await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::EventBus;
    use crate::manager::SerialManager;
    use crate::opener::RealPortOpener;
    use std::time::Instant;

    /// 不 open 任何真实端口:测 (a)/(b) 只依赖注入的 sleep/控制流,send 即使 NotOpen 也被 tracing 吞掉。
    fn mgr() -> Arc<SerialManager> {
        Arc::new(SerialManager::new(
            Arc::new(EventBus::new(16)),
            Arc::new(RealPortOpener),
        ))
    }

    /// 测试用 abort flag(永不 set,除非测试主动 store)。
    fn abort_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    /// (a) JS 的 await 能驱动 tokio 原语(tokio::time::sleep)且控制流正常、不挂死。
    #[tokio::test]
    async fn await_chain_drives_tokio_primitives() {
        let code = r#"
            await sleep(20);
            let x = 0;
            await sleep(20);
            x = 1;
            await sleep(20);
            if (x !== 1) { throw new Error("控制流失败"); }
        "#;
        let start = Instant::now();
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(result.is_ok(), "脚本应正常完成: {:?}", result);
        // 三个 sleep(20) 真的 await 过(累计 ~60ms);若同步阻塞则不可能达成。
        assert!(
            start.elapsed() >= Duration::from_millis(55),
            "三个 sleep(20) 应累计 ~60ms,实际 {:?}",
            start.elapsed()
        );
    }

    /// (b) 死循环被内层 tokio timeout 在 wall-clock 超时后中止,返回 Timeout 且不挂死。
    #[tokio::test]
    async fn infinite_loop_is_interrupted() {
        let code = r#"while (true) { await sleep(10); }"#;
        let start = Instant::now();
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            Some(Duration::from_millis(200)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(result, Err(ScriptError::Timeout)),
            "死循环应被超时中断: {:?}",
            result
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "应在超时附近返回而非挂死,实际 {:?}",
            start.elapsed()
        );
    }

    /// Script 的 serde 往返(镜像 macros::serde_macro_roundtrip)。
    #[test]
    fn serde_script_roundtrip() {
        let json = r#"{"description":"示例","code":"await send(\"AT\");"}"#;
        let s: Script = serde_json::from_str(json).unwrap();
        assert_eq!(s.description.as_deref(), Some("示例"));
        assert_eq!(s.code, "await send(\"AT\");");

        // 缺省 description:serde default 生效
        let s2: Script = serde_json::from_str(r#"{"code":"x"}"#).unwrap();
        assert!(s2.description.is_none());

        // params 往返(type→kind rename);旧脚本无 params → default 空
        assert!(s.params.is_empty());
        let json3 = r#"{"params":[{"name":"mac","type":"string","default":"AA"},{"name":"tgt","type":"select","options":["COM5","COM7"]}],"code":"c"}"#;
        let s3: Script = serde_json::from_str(json3).unwrap();
        assert_eq!(s3.params.len(), 2);
        assert_eq!(s3.params[0].name, "mac");
        assert_eq!(s3.params[0].kind, "string");
        assert_eq!(s3.params[0].default.as_deref(), Some("AA"));
        assert_eq!(s3.params[1].kind, "select");
        assert_eq!(
            s3.params[1].options,
            vec!["COM5".to_string(), "COM7".to_string()]
        );
    }

    /// throw new Error("msg") 的 message 必须被提取(不能只剩 "Exception generated by QuickJS")。
    #[tokio::test]
    async fn thrown_error_message_is_extracted() {
        let code = r#"throw new Error("test 123");"#;
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        match result {
            Err(ScriptError::Script(msg)) => assert_eq!(msg, "test 123"),
            other => panic!("期望 Script(\"test 123\"),得到 {:?}", other),
        }
    }

    /// 可选 port 尾参:rquickjs 对 `Option<String>` 缺省/显式均不抛 arity 异常(防行为回退)。
    /// 端口未开时 send/expect 失败被 tracing 吞、不影响 Ok,故仅断言脚本正常完成。
    #[tokio::test]
    async fn optional_port_param_arity() {
        // send 缺省 port(默认=绑定端口 COM0,未开 → send 返 Some(fail) → JS 包装 throw,脚本中断回明确错误)
        let r = run_script_with_timeout(
            "COM0",
            r#"await send("x")"#,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(r, Err(ScriptError::Script(ref m)) if m.contains("send 失败")),
            "send(data) 未开端口应 throw 'send 失败': {:?}",
            r
        );
        // send 显式 port(未开同样 throw)
        let r2 = run_script_with_timeout(
            "COM0",
            r#"await send("x", "COM5")"#,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(r2, Err(ScriptError::Script(ref m)) if m.contains("send 失败")),
            "send(data, port) 未开应 throw: {:?}",
            r2
        );
        // expect 三参(端口未开 → grep_buffer 报错被吞 → 返回空串 → 不 throw)
        let code = r#"const v = await expect("OK", 50, "COM9"); if (v !== "") throw new Error("未开端口应返回空串,得到: " + v);"#;
        let r3 = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(r3.is_ok(), "expect(pattern, ms, port) 三参应 Ok: {:?}", r3);
        // clear 显式 port(未开 → clear 返 Some(fail) → JS 包装 throw)
        let r4 = run_script_with_timeout(
            "COM0",
            r#"await clear("COM5")"#,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(r4, Err(ScriptError::Script(ref m)) if m.contains("clear 失败")),
            "clear(port) 未开应 throw 'clear 失败': {:?}",
            r4
        );
    }

    /// 运行时参数 args 注入:脚本读 args.<name> 拿到传入值(验证 Object 注入 + ctx 所有权写法)。
    #[tokio::test]
    async fn args_injected_readable() {
        let code = r#"throw new Error("mac=" + args.mac + " tgt=" + args.tgt);"#;
        let mut args = HashMap::new();
        args.insert("mac".to_string(), "AA:BB:CC".to_string());
        args.insert("tgt".to_string(), "COM7".to_string());
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            Some(Duration::from_secs(5)),
            args,
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        match result {
            Err(ScriptError::Script(msg)) => assert_eq!(msg, "mac=AA:BB:CC tgt=COM7"),
            other => panic!("期望 Script(\"mac=AA:BB:CC tgt=COM7\"),得到 {:?}", other),
        }
    }

    /// 停止信号(abort flag)set 后,interrupt 在下个字节码边界抛异常 → 脚本退出 → 返回 Aborted。
    /// None 超时路径(WS/Tauri 长跑)+ abort 触发停止的核心保证。
    #[tokio::test]
    async fn abort_stops_script() {
        let code = r#"while (true) { await sleep(20); }"#;
        let abort = abort_flag();
        let abort_clone = abort.clone();
        // 另起任务:100ms 后触发停止(模拟用户点停止按钮)
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            abort_clone.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            None,
            HashMap::new(),
            "log-rid",
            abort,
            None,
        )
        .await;
        stopper.await.unwrap();
        assert!(
            matches!(result, Err(ScriptError::Aborted)),
            "停止应返回 Aborted: {:?}",
            result
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "应在触发停止后及时返回而非挂死,实际 {:?}",
            start.elapsed()
        );
    }

    /// 纯 CPU 死循环(无 await)的停止:靠 interrupt handler 在字节码边界触发(区别 await 循环走 sleep 分段)。
    #[tokio::test]
    async fn abort_pure_cpu_loop() {
        let code = r#"while (true) {}"#;
        let abort = abort_flag();
        let abort_clone = abort.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            abort_clone.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        let result = run_script_with_timeout(
            "COM0",
            code,
            mgr(),
            None,
            HashMap::new(),
            "log-rid",
            abort,
            None,
        )
        .await;
        stopper.await.unwrap();
        assert!(
            matches!(result, Err(ScriptError::Aborted)),
            "纯 CPU 死循环应被 interrupt 停止: {:?}",
            result
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "interrupt 应及时(纯 CPU 循环字节码密集),实际 {:?}",
            start.elapsed()
        );
    }

    /// 并发多脚本:停 B 不影响 A(验证 abort flag 按脚本隔离,注册表不串扰)。
    #[tokio::test]
    async fn concurrent_stop_one_other_keeps_running() {
        let code_a = r#"
            for (let i = 0; i < 40; i++) { await sleep(50); }
            throw new Error("A 完成");
        "#;
        let code_b = r#"while (true) { await sleep(20); }"#;
        let abort_a = abort_flag();
        let abort_b = abort_flag();
        let abort_b_stop = abort_b.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            abort_b_stop.store(true, Ordering::Relaxed);
        });
        let (ra, rb) = tokio::join!(
            run_script_with_timeout(
                "COM0",
                code_a,
                mgr(),
                None,
                HashMap::new(),
                "log-rid",
                abort_a,
                None,
            ),
            run_script_with_timeout(
                "COM0",
                code_b,
                mgr(),
                None,
                HashMap::new(),
                "log-rid",
                abort_b,
                None,
            ),
        );
        stopper.await.unwrap();
        assert!(
            matches!(ra, Err(ScriptError::Script(ref msg)) if msg.contains("A 完成")),
            "A 未被停,应正常完成: {:?}",
            ra
        );
        assert!(
            matches!(rb, Err(ScriptError::Aborted)),
            "B 应被停止: {:?}",
            rb
        );
    }

    /// log(msg) 经 EventBus 发 ScriptLog(按 run_id/port 路由);脚本正常完成不中断(区别 throw)。
    #[tokio::test]
    async fn log_publishes_event() {
        let m = mgr();
        let mut rx = m.event_bus().subscribe();
        let code = r#"log("hello"); await sleep(5); log("world");"#;
        let result = run_script_with_timeout(
            "COM0",
            code,
            m,
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "rid-xyz",
            abort_flag(),
            None,
        )
        .await;
        assert!(result.is_ok(), "log 不应中断脚本: {:?}", result);
        // 脚本完成时 log 已同步 publish 进 broadcast buffer;try_recv 收全(本测试无其它事件)。
        let mut logs = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if let crate::event_bus::SerialEvent::ScriptLog {
                run_id,
                port,
                message,
            } = evt
            {
                logs.push((run_id, port, message));
            }
        }
        assert_eq!(
            logs,
            vec![
                (
                    "rid-xyz".to_string(),
                    "COM0".to_string(),
                    "hello".to_string()
                ),
                (
                    "rid-xyz".to_string(),
                    "COM0".to_string(),
                    "world".to_string()
                ),
            ],
            "应收到两条 ScriptLog,run_id/port 正确"
        );
    }

    /// MCP 入口 run_script(run_id="")不 panic:EventBus 无订阅者静默丢弃,但 sink 收集到日志。
    #[tokio::test]
    async fn mcp_entry_log_silent() {
        let m = mgr();
        let script = Script {
            description: None,
            group: None,
            params: vec![],
            code: r#"log("x"); log("y")"#.to_string(),
        };
        let outcome = run_script("COM0", &script, m, HashMap::new()).await;
        assert!(
            outcome.result.is_ok(),
            "MCP 入口 log 不应 panic/中断: {:?}",
            outcome.result
        );
        assert_eq!(outcome.logs, vec!["x".to_string(), "y".to_string()]);
    }

    /// MCP 入口失败路径:脚本 throw 后 sink 已收集的日志仍随 outcome 返回(失败响应也要带日志)。
    #[tokio::test]
    async fn mcp_entry_logs_returned_on_failure() {
        let m = mgr();
        let script = Script {
            description: None,
            group: None,
            params: vec![],
            code: r#"log("before"); throw new Error("boom")"#.to_string(),
        };
        let outcome = run_script("COM0", &script, m, HashMap::new()).await;
        assert!(
            matches!(&outcome.result, Err(ScriptError::Script(msg)) if msg == "boom"),
            "应失败且消息正确: {:?}",
            outcome.result
        );
        assert_eq!(outcome.logs, vec!["before".to_string()]);
    }

    /// 超时路径:sink 已收集的日志在 Timeout 后仍可读——exec 被 timeout drop,
    /// push 与读取间经 oneshot happens-before。AI 调试死循环脚本的日志不丢。
    /// 经 run_script_with_timeout + 短超时覆盖(直跑 run_script 入口要等满 300s)。
    #[tokio::test]
    async fn log_sink_survives_timeout() {
        let sink = ScriptLogSink::new();
        let result = run_script_with_timeout(
            "COM0",
            r#"log("started"); while (true) { await sleep(20); }"#,
            mgr(),
            Some(Duration::from_millis(200)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            Some(sink.clone()),
        )
        .await;
        assert!(
            matches!(result, Err(ScriptError::Timeout)),
            "死循环应超时: {:?}",
            result
        );
        assert_eq!(sink.logs(), vec!["started".to_string()]);
    }

    /// sink 截断:条数超限丢最旧保最新,logs() 首条拼丢弃计数;单条超长截断。
    #[test]
    fn log_sink_truncation() {
        let sink = ScriptLogSink::new();
        for i in 0..(MAX_LOG_ENTRIES + 10) {
            sink.push(format!("msg-{i}"));
        }
        let logs = sink.logs();
        assert_eq!(logs[0], "(前 10 条日志已丢弃)", "超限条数应记录丢弃计数");
        assert_eq!(
            logs.len(),
            MAX_LOG_ENTRIES + 1,
            "应保留最新 200 条 + 1 条标记"
        );
        assert_eq!(logs[1], "msg-10".to_string());
        assert_eq!(
            logs.last().unwrap(),
            &format!("msg-{}", MAX_LOG_ENTRIES + 9)
        );

        // 单条超长:截断到 ≤4 KiB(含截断标记),不突破条目上限。
        let sink2 = ScriptLogSink::new();
        sink2.push("x".repeat(100_000));
        let logs2 = sink2.logs();
        assert_eq!(logs2.len(), 1);
        assert!(logs2[0].len() <= MAX_LOG_ENTRY_BYTES + "…(截断)".len());
        assert!(logs2[0].ends_with("…(截断)"));

        // 多字节字符在 char 边界截断,不出破碎 UTF-8。
        let sink3 = ScriptLogSink::new();
        sink3.push("中".repeat(10_000));
        assert!(sink3.logs()[0].ends_with("…(截断)"));

        // 总字节超限(条数未超):同样丢最旧。
        let sink4 = ScriptLogSink::new();
        for i in 0..8 {
            sink4.push(format!("m{i}-").to_string() + &"y".repeat(3 * 1024));
        }
        let logs4 = sink4.logs();
        assert!(
            logs4.len() < 8,
            "总量超 16KiB 应丢最旧: 剩 {} 条",
            logs4.len()
        );
        assert!(logs4[0].starts_with("(前 "));
    }

    /// 测试临时文件:唯一名 + 用完自动删。
    struct TempFile(String);
    impl TempFile {
        fn new(content: &[u8]) -> Self {
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ss-script-test-{}-{}.bin",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&path, content).unwrap();
            Self(path.to_string_lossy().into_owned())
        }
        fn path(&self) -> &str {
            &self.0
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// file_stat/file_md5:存在时 exists/size 正确、md5 对已知向量;缺失时 stat 返
    /// exists:false 不抛、md5 抛错;目录不算 exists。
    #[tokio::test]
    async fn file_stat_md5() {
        let f = TempFile::new(b"abc");
        let dir = std::env::temp_dir();
        let code = format!(
            r#"const s = JSON.parse(file_stat({p}));
const d = JSON.parse(file_stat({dir}));
const out = [s.exists, s.size, d.exists, file_md5({p})];
throw new Error(JSON.stringify(out));"#,
            p = json_str(f.path()),
            dir = json_str(&dir.to_string_lossy()),
        );
        let r = run_script_with_timeout(
            "COM0",
            &code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(&r, Err(ScriptError::Script(m)) if m.contains(r#"[true,3,false,"900150983cd24fb0d6963f7d28e17f72"]"#)),
            "stat/md5 应为 [true,3,false,md5(abc)]: {:?}",
            r
        );

        // 缺失文件:file_stat 不抛(exists:false),file_md5 抛
        let missing = std::env::temp_dir().join("ss-script-test-no-such-file");
        let code = format!(
            r#"const s = JSON.parse(file_stat({p}));
if (!s.exists) {{ file_md5({p}); }}"#,
            p = json_str(&missing.to_string_lossy()),
        );
        let r2 = run_script_with_timeout(
            "COM0",
            &code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(&r2, Err(ScriptError::Script(m)) if m.contains("file_md5")),
            "缺失文件 file_md5 应 throw 含函数名: {:?}",
            r2
        );
    }

    /// read_file:全量 UTF-8(lossy)往返。
    #[tokio::test]
    async fn read_file_roundtrip() {
        let f = TempFile::new("你好 serial-studio €".as_bytes());
        let code = format!(
            r#"throw new Error(read_file({p}));"#,
            p = json_str(f.path())
        );
        let r = run_script_with_timeout(
            "COM0",
            &code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(&r, Err(ScriptError::Script(m)) if m == "你好 serial-studio €"),
            "read_file 内容往返: {:?}",
            r
        );
    }

    /// read_b64_chunk:整除/余数/越界/对齐契约/拼接还原;缺失文件与非法 chunk_bytes 抛错。
    #[tokio::test]
    async fn read_b64_chunk_boundaries() {
        // 10 字节 = 3 块整 + 1 字节余:块拼接应等于整文件 base64
        let data: Vec<u8> = (0u8..10).collect();
        let f = TempFile::new(&data);
        use base64::Engine as _;
        let expected = base64::engine::general_purpose::STANDARD.encode(&data);
        let code = format!(
            r#"let acc = "";
for (let i = 0; ; i++) {{
  const c = read_b64_chunk({p}, i, 3);
  if (c === "") break;
  acc += c;
}}
if (acc !== {expected}) throw new Error("块拼接不符: " + acc);
if (read_b64_chunk({p}, 99, 3) !== "") throw new Error("越界应空串");"#,
            p = json_str(f.path()),
            expected = json_str(&expected),
        );
        let r = run_script_with_timeout(
            "COM0",
            &code,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(r.is_ok(), "块拼接应还原整文件 b64: {:?}", r);

        // 大块(192)跨多块 + 末块 padding;非 3 倍数抛;缺失文件抛
        let big: Vec<u8> = (0u16..400).map(|i| i as u8).collect();
        let fb = TempFile::new(&big);
        let expected_big = base64::engine::general_purpose::STANDARD.encode(&big);
        let code2 = format!(
            r#"let acc = "";
for (let i = 0; ; i++) {{
  const c = read_b64_chunk({p}, i, 192);
  if (c === "") break;
  acc += c;
}}
if (acc !== {expected}) throw new Error("192 块拼接不符");
read_b64_chunk({p}, 0, 4);"#,
            p = json_str(fb.path()),
            expected = json_str(&expected_big),
        );
        let r2 = run_script_with_timeout(
            "COM0",
            &code2,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(&r2, Err(ScriptError::Script(m)) if m.contains("3 的倍数")),
            "chunk_bytes=4 应抛 '3 的倍数': {:?}",
            r2
        );

        let missing = std::env::temp_dir().join("ss-script-test-no-such-file-b64");
        let code3 = format!(
            r#"read_b64_chunk({p}, 0, 3);"#,
            p = json_str(&missing.to_string_lossy())
        );
        let r3 = run_script_with_timeout(
            "COM0",
            &code3,
            mgr(),
            Some(Duration::from_secs(5)),
            HashMap::new(),
            "log-rid",
            abort_flag(),
            None,
        )
        .await;
        assert!(
            matches!(&r3, Err(ScriptError::Script(m)) if m.contains("read_b64_chunk")),
            "缺失文件应 throw 含函数名: {:?}",
            r3
        );
    }

    /// 文件函数防护:目录被三个读函数拒绝(非常规文件防线程卡死);
    /// read_file 超 64MiB、read_b64_chunk 超 1MiB 块上限均 throw。
    #[tokio::test]
    async fn file_fn_guards() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        let run = |code: String| async move {
            run_script_with_timeout(
                "COM0",
                &code,
                mgr(),
                Some(Duration::from_secs(5)),
                HashMap::new(),
                "log-rid",
                abort_flag(),
                None,
            )
            .await
        };
        // 目录(非常规文件):三个读函数都应 throw「不是常规文件」
        for code in [
            format!(r#"read_file({d});"#, d = json_str(&dir)),
            format!(r#"file_md5({d});"#, d = json_str(&dir)),
            format!(r#"read_b64_chunk({d}, 0, 3);"#, d = json_str(&dir)),
        ] {
            let r = run(code).await;
            assert!(
                matches!(&r, Err(ScriptError::Script(m)) if m.contains("不是常规文件")),
                "目录应被文件函数拒绝: {:?}",
                r
            );
        }

        // read_file 大小上限:set_len 稀疏扩展到 64MiB+1(不实际写满)
        let big = TempFile::new(b"x");
        std::fs::OpenOptions::new()
            .write(true)
            .open(big.path())
            .unwrap()
            .set_len(FILE_READ_MAX + 1)
            .unwrap();
        let r = run(format!(r#"read_file({p});"#, p = json_str(big.path()))).await;
        assert!(
            matches!(&r, Err(ScriptError::Script(m)) if m.contains("read_b64_chunk")),
            "超限应提示改用分块: {:?}",
            r
        );

        // read_b64_chunk 块上限:cap 之上最近的 3 倍数
        let cap_str = FILE_CHUNK_MAX.to_string();
        let f = TempFile::new(b"abc");
        let oversize = (FILE_CHUNK_MAX / 3 + 1) * 3;
        let r = run(format!(
            r#"read_b64_chunk({p}, 0, {n});"#,
            p = json_str(f.path()),
            n = oversize
        ))
        .await;
        assert!(
            matches!(&r, Err(ScriptError::Script(m)) if m.contains(&cap_str)),
            "超 1MiB 块应 throw 含上限值: {:?}",
            r
        );
    }

    /// JS 字符串字面量(路径等含反斜杠/引号时安全嵌入 code)。
    fn json_str(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }
}

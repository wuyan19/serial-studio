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
//! v1 限制(后续完善):
//! - 串口原语失败用 tracing 记录、不抛 JS 异常(rquickjs `Async` 闭包的 `Ctx<'js>` 生命周期短于
//!   返回 future,无法 move 进 async 块抛异常)。用户脚本自己的 `throw` 经 `into_future` 正常传播。
//!   注意:`sleep`/`expect` 的**停止**走另一条路——主动返 `Err(rquickjs::Error)`(无需 Ctx)→ await
//!   reject → 抛异常中断脚本。这与「原语失败吞错」不冲突(失败是 Ok 路径吞,停止是主动 Err)。
//! - API 暂为全局函数,后续收敛为 `serial` 对象。
//! - 脚本 `log(msg)` 输出经 EventBus(`SerialEvent::ScriptLog`)流到前端(WS/Tauri 两出口),按 run_id 路由;
//!   MCP 路径不订阅 EventBus,日志静默丢弃。`ScriptResult` 仍与 `MacroResult` 同构。

use crate::event_bus::SerialEvent;
use crate::manager::SerialManager;
use rquickjs::prelude::{Async, Func};
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Promise};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// 默认执行超时。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 外层 oneshot 兜底超时相对内层的额外宽限(内层 timeout 先生效;此处仅兜底脚本线程卡死)。
const OUTER_TIMEOUT_GRACE: Duration = Duration::from_secs(2);
/// None 超时路径(WS/Tauri,长跑)的极大兜底:防 rquickjs C-level hang 时调用方永挂、注册表/permit
/// 永久泄漏。远大于正常复现时长(数天),正常脚本不应触达;命中按 Timeout(线程仍泄漏,v1 限制)。
const NONE_FALLBACK_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 3600);

/// 一个脚本参数定义(string / select)。运行时收集值注入 QuickJS 的 `args.<name>`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScriptParam {
    /// 脚本里 `args.<name>` 取值的键名。
    pub name: String,
    /// UI 显示标签;缺省用 name。
    #[serde(default)]
    pub label: Option<String>,
    /// "string" | "select"(`#[serde(rename)]` 因 type 是 Rust 关键字)。
    #[serde(rename = "type")]
    pub kind: String,
    /// 缺省值(运行收集时预填)。
    #[serde(default)]
    pub default: Option<String>,
    /// select 的可选项;string 类型留空。
    #[serde(default)]
    pub options: Vec<String>,
}

/// 一个脚本定义(对齐 [`crate::Macro`])。
///
/// `code` 为 JS 源码,被包成 `(async () => { ... })()` 求值,顶层可直接 `await`。
/// `params` 为声明的运行时参数(持久化进 scripts.json);运行收集的值经 `run_script` 的
/// `args` 参数注入,不入库。超时由执行入口默认 30s 或显式传入(见 [`run_script_with_timeout`]),
/// 不入库——与宏不在 `Macro` 顶层存 timeout 一致。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Script {
    #[serde(default)]
    pub description: Option<String>,
    /// 分组名(侧栏按组折叠);空 = 未分组。
    #[serde(default)]
    pub group: Option<String>,
    /// 声明的运行时参数(string/select),持久化进 scripts.json。旧脚本缺省为空。
    #[serde(default)]
    pub params: Vec<ScriptParam>,
    pub code: String,
}

/// 执行一段 JS 脚本(MCP 路径:默认 30s 超时,不暴露停止)。`args` 为运行时参数值,注入 `args.<name>`。
///
/// MCP 是同步请求/响应,客户端无法中途喊停,且无限 JSON-RPC 调用有 DoS 风险,故保留 30s 兜底;
/// 内部建一个永不 set 的 abort flag。WS/Tauri 路径请直接调 [`run_script_with_timeout`]
/// 传 `None` 超时 + 外部 abort(支持长跑 + 停止按钮)。
pub async fn run_script(
    port: &str,
    script: &Script,
    manager: Arc<SerialManager>,
    args: HashMap<String, String>,
) -> Result<(), ScriptError> {
    let abort = Arc::new(AtomicBool::new(false));
    // MCP 是同步 JSON-RPC,无实时日志出口;run_id="" → publish 的 ScriptLog 无订阅者被丢(见 event_to_msg 不转发)。
    run_script_with_timeout(port, &script.code, manager, Some(DEFAULT_TIMEOUT), args, "", abort).await
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
pub async fn run_script_with_timeout(
    port: &str,
    code: &str,
    manager: Arc<SerialManager>,
    timeout: Option<Duration>,
    args: HashMap<String, String>,
    run_id: &str, // 本次运行标识:脚本 log() 输出按此路由到前端(WS/Tauri);MCP 入口传 ""
    abort: Arc<AtomicBool>,
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
            rt.block_on(run_script_inner(port, code, manager, timeout, args, run_id, abort_for_thread))
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
async fn run_script_inner(
    port: String,
    code: String,
    manager: Arc<SerialManager>,
    timeout: Option<Duration>,
    args: HashMap<String, String>,
    run_id: String, // 脚本 log() 按此路由到前端(WS/Tauri);MCP 传 ""
    abort: Arc<AtomicBool>,
) -> Result<(), ScriptError> {
    let deadline = timeout.as_ref().map(|t| Instant::now() + *t);

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
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    globals.set(
                        "clear",
                        Func::from(Async(move |port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            async move {
                                if let Err(e) = mgr.clear_buffer(&p).await {
                                    tracing::error!("脚本 clear 失败: {}", e);
                                }
                                Ok::<_, rquickjs::Error>(())
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
                // MCP 路径 run_id="" 且 server 不订阅 EventBus,日志静默丢弃。
                {
                    let mgr = manager.clone();
                    let rid = run_id.clone();
                    let dp = port.clone();
                    globals.set(
                        "log",
                        Func::from(move |message: String| {
                            mgr.event_bus().publish(SerialEvent::ScriptLog {
                                run_id: rid.clone(),
                                port: dp.clone(),
                                message,
                            });
                        }),
                    ).map_err(|e| e.to_string())?;
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
const __clear=globalThis.clear;globalThis.clear=async(p)=>__clear(typeof p==="undefined"?null:p);"#)
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
        let result = run_script_with_timeout("COM0", code, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
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
        let result =
            run_script_with_timeout("COM0", code, mgr(), Some(Duration::from_millis(200)), HashMap::new(), "log-rid", abort_flag()).await;
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
        assert_eq!(s3.params[1].options, vec!["COM5".to_string(), "COM7".to_string()]);
    }

    /// throw new Error("msg") 的 message 必须被提取(不能只剩 "Exception generated by QuickJS")。
    #[tokio::test]
    async fn thrown_error_message_is_extracted() {
        let code = r#"throw new Error("test 123");"#;
        let result = run_script_with_timeout("COM0", code, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
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
        let r = run_script_with_timeout("COM0", r#"await send("x")"#, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
        assert!(matches!(r, Err(ScriptError::Script(ref m)) if m.contains("send 失败")), "send(data) 未开端口应 throw 'send 失败': {:?}", r);
        // send 显式 port(未开同样 throw)
        let r2 = run_script_with_timeout("COM0", r#"await send("x", "COM5")"#, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
        assert!(matches!(r2, Err(ScriptError::Script(ref m)) if m.contains("send 失败")), "send(data, port) 未开应 throw: {:?}", r2);
        // expect 三参(端口未开 → grep_buffer 报错被吞 → 返回空串 → 不 throw)
        let code = r#"const v = await expect("OK", 50, "COM9"); if (v !== "") throw new Error("未开端口应返回空串,得到: " + v);"#;
        let r3 = run_script_with_timeout("COM0", code, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
        assert!(r3.is_ok(), "expect(pattern, ms, port) 三参应 Ok: {:?}", r3);
        // clear 显式 port
        let r4 = run_script_with_timeout("COM0", r#"await clear("COM5")"#, mgr(), Some(Duration::from_secs(5)), HashMap::new(), "log-rid", abort_flag()).await;
        assert!(r4.is_ok(), "clear(port) 应 Ok: {:?}", r4);
    }

    /// 运行时参数 args 注入:脚本读 args.<name> 拿到传入值(验证 Object 注入 + ctx 所有权写法)。
    #[tokio::test]
    async fn args_injected_readable() {
        let code = r#"throw new Error("mac=" + args.mac + " tgt=" + args.tgt);"#;
        let mut args = HashMap::new();
        args.insert("mac".to_string(), "AA:BB:CC".to_string());
        args.insert("tgt".to_string(), "COM7".to_string());
        let result = run_script_with_timeout("COM0", code, mgr(), Some(Duration::from_secs(5)), args, "log-rid", abort_flag()).await;
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
        let result =
            run_script_with_timeout("COM0", code, mgr(), None, HashMap::new(), "log-rid", abort).await;
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
        let result = run_script_with_timeout("COM0", code, mgr(), None, HashMap::new(), "log-rid", abort).await;
        stopper.await.unwrap();
        assert!(
            matches!(result, Err(ScriptError::Aborted)),
            "纯 CPU 死循环应被 interrupt 停止: {:?}", result
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "interrupt 应及时(纯 CPU 循环字节码密集),实际 {:?}", start.elapsed()
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
            run_script_with_timeout("COM0", code_a, mgr(), None, HashMap::new(), "log-rid", abort_a),
            run_script_with_timeout("COM0", code_b, mgr(), None, HashMap::new(), "log-rid", abort_b),
        );
        stopper.await.unwrap();
        assert!(
            matches!(ra, Err(ScriptError::Script(ref msg)) if msg.contains("A 完成")),
            "A 未被停,应正常完成: {:?}", ra
        );
        assert!(
            matches!(rb, Err(ScriptError::Aborted)),
            "B 应被停止: {:?}", rb
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
        )
        .await;
        assert!(result.is_ok(), "log 不应中断脚本: {:?}", result);
        // 脚本完成时 log 已同步 publish 进 broadcast buffer;try_recv 收全(本测试无其它事件)。
        let mut logs = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if let crate::event_bus::SerialEvent::ScriptLog { run_id, port, message } = evt {
                logs.push((run_id, port, message));
            }
        }
        assert_eq!(
            logs,
            vec![
                ("rid-xyz".to_string(), "COM0".to_string(), "hello".to_string()),
                ("rid-xyz".to_string(), "COM0".to_string(), "world".to_string()),
            ],
            "应收到两条 ScriptLog,run_id/port 正确"
        );
    }

    /// MCP 入口 run_script(run_id="")不 panic:log 的 ScriptLog 无订阅者静默丢弃。
    #[tokio::test]
    async fn mcp_entry_log_silent() {
        let m = mgr();
        let script = Script {
            description: None,
            group: None,
            params: vec![],
            code: r#"log("x")"#.to_string(),
        };
        let result = run_script("COM0", &script, m, HashMap::new()).await;
        assert!(result.is_ok(), "MCP 入口 log 不应 panic/中断: {:?}", result);
    }
}

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
//! 暴露的全局 async 函数:send / expect / clear / sleep。send/expect/clear 尾参为可选 `port`(缺省=脚本绑定的端口,可传其它已打开端口以跨多串口)。脚本被包成 `(async () => { ... })()` 求值。
//!
//! v1 限制(后续完善):
//! - 串口原语失败用 tracing 记录、不抛 JS 异常(rquickjs `Async` 闭包的 `Ctx<'js>` 生命周期短于
//!   返回 future,无法 move 进 async 块抛异常)。用户脚本自己的 `throw` 经 `into_future` 正常传播。
//! - API 暂为全局函数,后续收敛为 `serial` 对象。
//! - 不捕获脚本输出,`ScriptResult` 与 `MacroResult` 同构。

use crate::manager::SerialManager;
use rquickjs::prelude::{Async, Func};
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Promise};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    #[error("脚本引擎错误: {0}")]
    Engine(String),
    #[error("脚本执行超时")]
    Timeout,
    #[error("脚本异常: {0}")]
    Script(String),
}

impl ScriptError {
    /// 面向用户/远程的消息:Engine 类不回显内部文本(避免把 rquickjs/OS 错误细节泄漏给远程
    /// WS/MCP 客户端),Script 透传用户 throw 的消息,Timeout 给固定文本。
    /// WS/MCP 回显用此而非 `Display`(后者对 Engine 会带内部字符串)。
    pub fn display_message(&self) -> String {
        match self {
            ScriptError::Engine(_) => "脚本引擎错误".into(),
            ScriptError::Timeout => "脚本执行超时".into(),
            ScriptError::Script(s) => s.clone(),
        }
    }
}

/// 默认执行超时。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 外层 oneshot 兜底超时相对内层的额外宽限(内层 timeout 先生效;此处仅兜底脚本线程卡死)。
const OUTER_TIMEOUT_GRACE: Duration = Duration::from_secs(2);

/// 一个脚本定义(对齐 [`crate::Macro`])。
///
/// `code` 为 JS 源码,被包成 `(async () => { ... })()` 求值,顶层可直接 `await`。
/// 超时由执行入口默认 30s 或显式传入(见 [`run_script_with_timeout`]),不入库——
/// 与宏不在 `Macro` 顶层存 timeout 一致。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Script {
    #[serde(default)]
    pub description: Option<String>,
    pub code: String,
}

/// 执行一段 JS 脚本(默认超时)。
pub async fn run_script(
    port: &str,
    script: &Script,
    manager: Arc<SerialManager>,
) -> Result<(), ScriptError> {
    run_script_with_timeout(port, &script.code, manager, DEFAULT_TIMEOUT).await
}

/// 执行一段 JS 脚本,注入串口原语,带显式超时。
///
/// 在独立 OS 线程的 current_thread runtime 跑脚本(隔离 rquickjs 非 Send future),
/// 主线程经 oneshot 收结果并用 wall-clock 超时兜底——对外 future 是 `Send`。
pub async fn run_script_with_timeout(
    port: &str,
    code: &str,
    manager: Arc<SerialManager>,
    timeout: Duration,
) -> Result<(), ScriptError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), ScriptError>>();
    let port = port.to_string();
    let code = code.to_string();
    // 独立 OS 线程 + current_thread runtime:内部 future(含 rquickjs 非 Send)无需跨线程。
    std::thread::spawn(move || {
        // catch_unwind:rt.block_on 若 panic(rquickjs 在畸形输入下可能),转成 Engine 错误,
        // 否则 panic 会让 tx drop → 主线程只收到误导性的"通道关闭"。
        let run = std::panic::AssertUnwindSafe(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| ScriptError::Engine(format!("创建脚本线程 runtime 失败: {e}")))?;
            rt.block_on(run_script_inner(port, code, manager, timeout))
        });
        let result = match std::panic::catch_unwind(run) {
            Ok(r) => r,
            Err(payload) => Err(ScriptError::Engine(format!("脚本线程 panic: {payload:?}"))),
        };
        let _ = tx.send(result);
    });
    // 外层超时:脚本线程的正常超时由内层 tokio timeout 先返回 Timeout。此处仅在脚本线程
    // 异常卡死(rquickjs C-level hang 等)时给调用方返回 Timeout——注意线程本身无法被中止、
    // 会泄漏(持有 AsyncRuntime 直到进程退出)。v1 已知限制,靠并发上限(server 层)控制影响面。
    match tokio::time::timeout(timeout + OUTER_TIMEOUT_GRACE, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(ScriptError::Script("脚本执行通道关闭".into())),
        Err(_) => Err(ScriptError::Timeout),
    }
}

/// 脚本实际执行(在独立线程的 current_thread runtime 内,future 无需 `Send`)。
async fn run_script_inner(
    port: String,
    code: String,
    manager: Arc<SerialManager>,
    timeout: Duration,
) -> Result<(), ScriptError> {
    let deadline = Instant::now() + timeout;

    // exec 在 tokio timeout 包裹下跑:到点未完成即 drop(中止 JS),返回 Timeout。
    let exec = async move {
        let rt = AsyncRuntime::new().map_err(|e| ScriptError::Engine(e.to_string()))?;
        let ctx = AsyncContext::full(&rt)
            .await
            .map_err(|e| ScriptError::Engine(e.to_string()))?;

        // 尽力快速中断 JS(interrupt handler 在 await 密集的 async 循环下不及时,见外层兜底)。
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)))
            .await;
        // 资源上限:interrupt 只在字节码之间触发,拦不住单条字节码内的分配/递归(无限数组、
        // 深递归会 OOM/爆栈)。用 QuickJS 内存/栈上限兜底,命中即抛 JS 异常,被 catch 提取。
        rt.set_memory_limit(64 * 1024 * 1024).await; // 64 MiB
        rt.set_max_stack_size(4 * 1024 * 1024).await; // 4 MiB

        let outcome: Result<(), String> = ctx
            .async_with(async |ctx| {
                let globals = ctx.globals();

                // send(data, [port]):text + 按端口 line_ending 自动追加换行。port 缺省=脚本绑定端口。
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    globals.set(
                        "send",
                        Func::from(Async(move |data: String, port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            async move {
                                if let Err(e) = mgr.send(&p, &data, "text", true).await {
                                    tracing::error!("脚本 send 失败: {}", e);
                                }
                                Ok::<_, rquickjs::Error>(())
                            }
                        })),
                    ).map_err(|e| e.to_string())?;
                }

                // expect(pattern, timeout_ms, [port]):返回首条正则匹配行(无匹配返回空串)。port 缺省=脚本绑定端口。
                {
                    let mgr = manager.clone();
                    let dp = port.clone();
                    globals.set(
                        "expect",
                        Func::from(Async(move |pattern: String, timeout_ms: u64, port: Option<String>| {
                            let mgr = mgr.clone();
                            let p = port.unwrap_or_else(|| dp.clone());
                            async move {
                                match mgr.grep_buffer(&p, &pattern, timeout_ms).await {
                                    Ok(lines) => Ok::<_, rquickjs::Error>(
                                        lines.into_iter().next().unwrap_or_default(),
                                    ),
                                    Err(e) => {
                                        tracing::error!("脚本 expect 失败: {}", e);
                                        Ok(String::new())
                                    }
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

                // sleep(ms):tokio 原语在 native async function 内可用
                globals.set(
                    "sleep",
                    Func::from(Async(|ms: u64| async move {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                        Ok::<_, rquickjs::Error>(())
                    })),
                ).map_err(|e| e.to_string())?;

                // 可选 port 的 JS 适配:rquickjs 元组 arity 严格——JS 调 send("x") 少传参数时报
                // "1 argument(s) while 2 where expected",不会把缺失参数填 undefined→None。
                // 故在 JS 层把缺省 port 补成 null(Rust Option<String> 把 null→None),
                // 让 send/expect/clear 支持缺省 port。sleep 无 port 参数,不包装。
                ctx.eval::<(), _>(r#"const __send=globalThis.send;globalThis.send=async(d,p)=>__send(d,typeof p==="undefined"?null:p);
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

    match tokio::time::timeout(timeout, exec).await {
        Ok(res) => res,
        Err(_) => Err(ScriptError::Timeout),
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
        let result = run_script_with_timeout("COM0", code, mgr(), Duration::from_secs(5)).await;
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
            run_script_with_timeout("COM0", code, mgr(), Duration::from_millis(200)).await;
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
    }

    /// throw new Error("msg") 的 message 必须被提取(不能只剩 "Exception generated by QuickJS")。
    #[tokio::test]
    async fn thrown_error_message_is_extracted() {
        let code = r#"throw new Error("test 123");"#;
        let result = run_script_with_timeout("COM0", code, mgr(), Duration::from_secs(5)).await;
        match result {
            Err(ScriptError::Script(msg)) => assert_eq!(msg, "test 123"),
            other => panic!("期望 Script(\"test 123\"),得到 {:?}", other),
        }
    }

    /// 可选 port 尾参:rquickjs 对 `Option<String>` 缺省/显式均不抛 arity 异常(防行为回退)。
    /// 端口未开时 send/expect 失败被 tracing 吞、不影响 Ok,故仅断言脚本正常完成。
    #[tokio::test]
    async fn optional_port_param_arity() {
        // send 缺省 port(默认=绑定端口 COM0,未开则 send 失败被吞,仍 Ok)
        let r = run_script_with_timeout("COM0", r#"await send("x")"#, mgr(), Duration::from_secs(5)).await;
        assert!(r.is_ok(), "send(data) 缺省 port 应 Ok: {:?}", r);
        // send 显式 port
        let r2 = run_script_with_timeout("COM0", r#"await send("x", "COM5")"#, mgr(), Duration::from_secs(5)).await;
        assert!(r2.is_ok(), "send(data, port) 显式 port 应 Ok: {:?}", r2);
        // expect 三参(端口未开 → grep_buffer 报错被吞 → 返回空串 → 不 throw)
        let code = r#"const v = await expect("OK", 50, "COM9"); if (v !== "") throw new Error("未开端口应返回空串,得到: " + v);"#;
        let r3 = run_script_with_timeout("COM0", code, mgr(), Duration::from_secs(5)).await;
        assert!(r3.is_ok(), "expect(pattern, ms, port) 三参应 Ok: {:?}", r3);
        // clear 显式 port
        let r4 = run_script_with_timeout("COM0", r#"await clear("COM5")"#, mgr(), Duration::from_secs(5)).await;
        assert!(r4.is_ok(), "clear(port) 应 Ok: {:?}", r4);
    }
}

//! 脚本执行 spike:嵌入 QuickJS(rquickjs),验证 JS 脚本能 await 驱动串口 IO(async×tokio 桥接)。
//!
//! 暴露的全局 async 函数:send / expect / clear / sleep。用户脚本被包成
//! `(async () => { ... })()` 求值,`Promise::into_future().await` 驱动。
//!
//! 死循环/超时保护用**双层**:
//! - `set_interrupt_handler`:尽力在 JS 字节码执行间隙快速中止(spike 实测在 await 密集的
//!   async 循环下触发极不及时,不可单独依赖——见 infinite_loop_is_interrupted 的来由)。
//! - 外层 `tokio::time::timeout`:wall-clock 硬兜底,保证不挂死。生产版需评估 drop
//!   AsyncRuntime 的阻塞成本(必要时把 exec spawn 到独立 task + abort)。
//!
//! spike 限制(验证通过后,生产版再完善):
//! - 错误传播简化:串口错误用 tracing 记录、不抛 JS 异常(`rquickjs::Error` 无简单 String 构造)。
//! - API 暂为全局函数,生产版应收敛为 `serial` 对象。
//! - run_script 收 `Arc<SerialManager>`:native async function 返回的 future 需 'static。

use crate::manager::SerialManager;
use rquickjs::prelude::{Async, Func};
use rquickjs::{AsyncContext, AsyncRuntime, Promise};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    #[error("脚本引擎错误: {0}")]
    Engine(#[from] rquickjs::Error),
    #[error("脚本执行超时")]
    Timeout,
    #[error("脚本异常: {0}")]
    Script(String),
}

/// 默认执行超时。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 执行一段 JS 脚本(默认超时)。
pub async fn run_script(
    port: &str,
    code: &str,
    manager: Arc<SerialManager>,
) -> Result<(), ScriptError> {
    run_script_with_timeout(port, code, manager, DEFAULT_TIMEOUT).await
}

/// 执行一段 JS 脚本,注入串口原语,带显式超时。
///
/// 验证三问对应:
/// - (a) await 驱动:native async function 的 future 由 `Promise::into_future` 驱动,
///   在外层 tokio task 上 poll,故其内的 `tokio::time::sleep` / `manager.send` 等 tokio 原语可用。
/// - (b) 死循环中断:外层 `tokio::time::timeout` 硬兜底(interrupt handler 在 async 模型下不及时)。
/// - (c) 编译:见 `cargo build -p ss-core`。
pub async fn run_script_with_timeout(
    port: &str,
    code: &str,
    manager: Arc<SerialManager>,
    timeout: Duration,
) -> Result<(), ScriptError> {
    let deadline = Instant::now() + timeout;
    let port = port.to_string();

    // exec 在 tokio timeout 包裹下跑:到点未完成即 drop(中止 JS),返回 Timeout。
    let exec = async move {
        let rt = AsyncRuntime::new()?;
        let ctx = AsyncContext::full(&rt).await?;

        // 尽力快速中断 JS(不可单独依赖,见模块文档)。
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)))
            .await;

        let outcome: Result<(), rquickjs::Error> = ctx
            .async_with(async |ctx| {
                let globals = ctx.globals();

                // send(data):text + 按端口 line_ending 自动追加换行
                {
                    let mgr = manager.clone();
                    let p = port.clone();
                    globals.set(
                        "send",
                        Func::from(Async(move |data: String| {
                            let mgr = mgr.clone();
                            let p = p.clone();
                            async move {
                                if let Err(e) = mgr.send(&p, &data, "text", true).await {
                                    tracing::error!("脚本 send 失败: {}", e);
                                }
                                Ok::<_, rquickjs::Error>(())
                            }
                        })),
                    )?;
                }

                // expect(pattern, timeout_ms):返回首条正则匹配行(无匹配返回空串)
                {
                    let mgr = manager.clone();
                    let p = port.clone();
                    globals.set(
                        "expect",
                        Func::from(Async(move |pattern: String, timeout_ms: u64| {
                            let mgr = mgr.clone();
                            let p = p.clone();
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
                    )?;
                }

                // clear():清空接收缓冲区
                {
                    let mgr = manager.clone();
                    let p = port.clone();
                    globals.set(
                        "clear",
                        Func::from(Async(move || {
                            let mgr = mgr.clone();
                            let p = p.clone();
                            async move {
                                if let Err(e) = mgr.clear_buffer(&p).await {
                                    tracing::error!("脚本 clear 失败: {}", e);
                                }
                                Ok::<_, rquickjs::Error>(())
                            }
                        })),
                    )?;
                }

                // sleep(ms):验证 tokio 原语在 native async function 内可用
                globals.set(
                    "sleep",
                    Func::from(Async(|ms: u64| async move {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                        Ok::<_, rquickjs::Error>(())
                    })),
                )?;

                // 包成 async IIFE 求值,返回 Promise 并 await——此处把 JS 事件循环交还 tokio 驱动。
                let wrapped = format!("(async () => {{\n{}\n}})()", code);
                let promise: Promise = ctx.eval(wrapped.as_str())?;
                promise.into_future::<()>().await?;
                Ok::<_, rquickjs::Error>(())
            })
            .await;

        outcome.map_err(|e| ScriptError::Script(e.to_string()))
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

    /// (b) 死循环被外层 tokio timeout 在 wall-clock 超时后中止,返回 Timeout 且不挂死。
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
}

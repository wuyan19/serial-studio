//! MCP 扩展点：二次宿主（topo-hub 等）向 `/mcp` 注入额外工具集。
//!
//! ss-server 对具体扩展零感知：AppState 携带扩展列表（组装时注入，create_state
//! 置空），tools/list 追加其描述符、tools/call 在内置工具名未命中时逐个委托。
//! 扩展自带所需上下文（自身的 store/广播通道），经 `&AppState` 读共享运行时
//! （设备注册表、端口管理器）——不需要的扩展拿不到多余的东西。

use crate::AppState;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// 一个 MCP 工具集扩展。
pub trait McpExtension: Send + Sync + 'static {
    /// tools/list 追加的工具描述符（形状同内置工具：name/description/inputSchema）。
    fn tools(&self) -> Vec<Value>;

    /// 处理 tools/call。返回 None 表示"非本扩展的工具名"，交回调度链；
    /// 返回 Some 则是完整 MCP 工具结果（content 数组），与内置工具同构。
    ///
    /// `principal` = 调用方身份（工具参数 token 优先于 Mcp-Session-Id 头，
    /// 由 mcp.rs 统一解析；None = 匿名）。租约类语义消费它，纯工具可忽略。
    ///
    /// 返回的 future 借用全部入参（统一 'a）——实现里可用 state 读共享运行时、
    /// 用 name 分发；调度方（dispatch）当埘认 await，借用立收。
    fn call<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        principal: Option<&'a str>,
        state: &'a AppState,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + 'a>>;

    /// 内置工具执行前的准入检查（如 topo-hub 写闸：MCP 写类操作须持租约）。
    /// 仅对内置工具调用；返回 Some(结果) = 拦截（isError 标记），None = 放行。
    /// 默认全放行。
    fn intercept<'a>(
        &'a self,
        _name: &'a str,
        _args: Value,
        _principal: Option<&'a str>,
        _state: &'a AppState,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + 'a>> {
        Box::pin(async move { None })
    }

    /// 脚本内写操作的逐次准入闸（send/clear 每次调用前执行）。
    /// 返回 None = 不检查（UI/Tauri 场景）；Some(gate) = 注入到脚本引擎。
    /// 默认 None。
    fn script_gate(
        &self,
        _principal: Option<&str>,
        _state: &AppState,
    ) -> Option<ss_core::WriteGateFn> {
        None
    }
}

/// 调度辅助：按注册顺序委托扩展，None 透传给下一个。
pub(crate) async fn dispatch(
    extensions: &[Arc<dyn McpExtension>],
    name: &str,
    args: Value,
    principal: Option<&str>,
    state: &AppState,
) -> Option<Value> {
    for ext in extensions {
        if let Some(result) = ext.call(name, args.clone(), principal, state).await {
            return Some(result);
        }
    }
    None
}

/// 准入辅助：按注册顺序询问扩展，首个 Some 即拦截。
pub(crate) async fn intercept(
    extensions: &[Arc<dyn McpExtension>],
    name: &str,
    args: Value,
    principal: Option<&str>,
    state: &AppState,
) -> Option<Value> {
    for ext in extensions {
        if let Some(denied) = ext.intercept(name, args.clone(), principal, state).await {
            return Some(denied);
        }
    }
    None
}

/// 脚本写闸辅助：按注册顺序询问扩展，首个 Some 即作为脚本引擎的逐次闸。
/// 无扩展提供则返回 None（脚本内 send/clear 不检查——UI/Tauri 场景）。
pub fn script_gate(
    extensions: &[Arc<dyn McpExtension>],
    principal: Option<&str>,
    state: &AppState,
) -> Option<ss_core::WriteGateFn> {
    for ext in extensions {
        if let Some(gate) = ext.script_gate(principal, state) {
            return Some(gate);
        }
    }
    None
}

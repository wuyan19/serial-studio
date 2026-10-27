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
    /// 返回的 future 借用全部入参（统一 'a）——实现里可用 state 读共享运行时、
    /// 用 name 分发；调度方（dispatch）当埘认 await，借用立收。
    fn call<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        state: &'a AppState,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + 'a>>;
}

/// 调度辅助：按注册顺序委托扩展，None 透传给下一个。
pub(crate) async fn dispatch(
    extensions: &[Arc<dyn McpExtension>],
    name: &str,
    args: Value,
    state: &AppState,
) -> Option<Value> {
    for ext in extensions {
        if let Some(result) = ext.call(name, args.clone(), state).await {
            return Some(result);
        }
    }
    None
}

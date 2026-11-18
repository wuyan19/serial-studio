//! SSE 变更通知流（GET /api/events）。
//!
//! ui-rack 的推送通道：topo_changed（拓扑定义变更）/ lease_changed（租约申请、
//! 续租、释放、过期、抢占）。事件不载荷数据——客户端收到即重拉 REST，变更频率
//! 低，重拉语义最简单且天然幂等。Lagged（消费太慢）同样触发重拉，行为正确。

use crate::api::TopoState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub async fn sse(
    State(state): State<TopoState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // 注意 data() 不可省：SSE 规范要求事件带 data 行才派发——只设 event 名的
    // 事件在浏览器 EventSource 永远不触发（curl 看得到原始字节，测不出来）。
    let topo = BroadcastStream::new(state.topo_bus.subscribe())
        .filter_map(|_| Some(Ok(Event::default().event("topo_changed").data("1"))));
    let lease = BroadcastStream::new(state.lease_bus.subscribe())
        .filter_map(|_| Some(Ok(Event::default().event("lease_changed").data("1"))));
    Sse::new(futures_util::stream::select(topo, lease)).keep_alive(KeepAlive::default())
}

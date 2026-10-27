//! SSE 变更通知流（GET /api/events）。
//!
//! ui-topo 的推送通道：拓扑/（P1 的）租约变更经 topo_bus 扇出，客户端收到
//! `topo_changed` 事件后重拉 REST。事件不载荷数据——变更频率低，重拉语义
//! 最简单且天然幂等。Lagged（消费太慢）同样触发客户端重拉，行为正确。

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
    let rx = BroadcastStream::new(state.topo_bus.subscribe());
    // tokio_stream 的 filter_map 是同步闭包；Lagged 也映射成事件（客户端重拉即正确）。
    let stream = rx.filter_map(|_| Some(Ok(Event::default().event("topo_changed"))));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

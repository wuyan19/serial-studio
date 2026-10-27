//! 拓扑工具的 MCP 集成测试：经 ss_server::mcp::handle_request 走完整
//! JSON-RPC 调度链（tools/list 合并扩展、tools/call 内置未命中委托扩展）。

use serde_json::Value;
use std::sync::Arc;
use topo_hub::mcp_topo::TopoTools;
use topo_hub::test_support::{ensure_test_config_dir, make_state, unique_name};
use topo_hub::TopoState;

fn state_with_tools() -> TopoState {
    ensure_test_config_dir();
    let (tx, _) = tokio::sync::broadcast::channel::<()>(16);
    let mut base = make_state();
    base.mcp_extensions = vec![Arc::new(TopoTools { bus: tx.clone() })];
    TopoState {
        base,
        topo_bus: Arc::new(tx),
    }
}

async fn call(state: &TopoState, body: &str) -> Value {
    ss_server::mcp::handle_request(body, &state.base).await
}

fn text(resp: &Value) -> String {
    resp["result"]["content"][0]["text"].as_str().unwrap().into()
}

#[tokio::test]
async fn topo_tools_listed_alongside_builtin() {
    let state = state_with_tools();
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
    )
    .await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 17, "12 内置串口/脚本工具 + 5 拓扑工具");
    for name in ["topo_list", "topo_get", "topo_create", "topo_update", "topo_delete"] {
        assert!(
            tools.iter().any(|t| t["name"] == name),
            "缺工具 {name}"
        );
    }
}

#[tokio::test]
async fn topo_crud_roundtrip() {
    let state = state_with_tools();
    let name = unique_name("集成拓扑");

    // create：设备键 + 端点键各一，成员定型后落盘
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"topo_create","arguments":{{"name":"{name}","description":"集成测试","members":[{{"key":"ssh-x1","note":"被测网关"}},{{"key":"ssh-x1::shell"}}]}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(resp["result"]["isError"].is_null(), "创建应成功: {msg}");
    assert!(msg.contains("已创建拓扑"), "{msg}");

    // list 能看到
    let msg = text(&call(&state, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"topo_list","arguments":{}}}"#).await);
    assert!(msg.contains(&name), "{msg}");

    // get：成员两行，设备行带昵称与备注，端点行带端点名
    let msg = text(
        &call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"topo_get","arguments":{{"topo":"{name}"}}}}}}"#
            ),
        )
        .await,
    );
    assert!(msg.contains("设备 ssh-x1"), "{msg}");
    assert!(msg.contains("车间网关"), "{msg}");
    assert!(msg.contains("被测网关"), "{msg}");
    assert!(msg.contains("端点 ssh-x1::shell"), "{msg}");

    // update：改描述 + 换成员
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"topo_update","arguments":{{"topo":"{name}","description":"改述","members":[{{"key":"ssh-x2"}}]}}}}}}"#
        ),
    )
    .await;
    assert!(text(&resp).contains("已更新拓扑"));

    // delete → 再 get 报不存在
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"topo_delete","arguments":{{"topo":"{name}"}}}}}}"#
        ),
    )
    .await;
    assert!(text(&resp).contains("已删除拓扑"));
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"topo_get","arguments":{{"topo":"{name}"}}}}}}"#
        ),
    )
    .await;
    assert_eq!(resp["result"]["isError"], true, "删除后 get 应报错");
}

#[tokio::test]
async fn topo_create_rejects_unknown_member() {
    let state = state_with_tools();
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"topo_create","arguments":{"name":"坏拓扑","members":[{"key":"ghost-dev"}]}}}"#,
    )
    .await;
    assert_eq!(resp["result"]["isError"], true);
    assert!(text(&resp).contains("ghost-dev"), "错误应指明坏键");
}

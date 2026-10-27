//! 拓扑与租约工具的 MCP 集成测试：经 ss_server::mcp 的 handle_request(_with)
//! 走完整 JSON-RPC 调度链（principal 解析、写闸 intercept、扩展分发）。

use serde_json::Value;
use std::sync::Arc;
use topo_hub::mcp_topo::TopoTools;
use topo_hub::test_support::{ensure_test_config_dir, make_state, unique_name};
use topo_hub::TopoState;

fn state_with_tools() -> TopoState {
    ensure_test_config_dir();
    let mut ts = TopoState::create(make_state());
    ts.base.mcp_extensions = vec![Arc::new(TopoTools {
        bus: (*ts.topo_bus).clone(),
        leases: Arc::clone(&ts.leases),
    })];
    ts
}

async fn call(state: &TopoState, body: &str) -> Value {
    ss_server::mcp::handle_request(body, &state.base).await
}

/// 以指定 principal（模拟 Mcp-Session-Id 头回传）调用。
async fn call_as(state: &TopoState, token: &str, body: &str) -> Value {
    ss_server::mcp::handle_request_with(Some(token), body, &state.base).await
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
    assert_eq!(tools.len(), 23, "14 内置(含 port_open/close) + 5 拓扑 + 4 租约工具");
    for name in [
        "topo_list",
        "topo_get",
        "topo_create",
        "topo_update",
        "topo_delete",
        "lease_acquire",
        "lease_renew",
        "lease_release",
        "lease_status",
    ] {
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

// ===== 租约与写闸（P1）=====

/// initialize 签发 token → 持 token 申请租约 → 写闸放行/拦截/冲突/释放全链路。
#[tokio::test]
async fn lease_flow_and_write_gate() {
    let state = state_with_tools();

    // 匿名申请 → 拒
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"devices":["ssh-x1"]}}}"#,
    )
    .await;
    assert_eq!(resp["result"]["isError"], true);
    assert!(text(&resp).contains("token"), "{}", text(&resp));

    // 匿名写 → 闸拒（引导先申请）
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_send","arguments":{"port":"ssh-x1::shell","data":"AT"}}}"#,
    )
    .await;
    assert_eq!(resp["result"]["isError"], true);
    assert!(text(&resp).contains("租约"), "匿名写应被闸拦: {}", text(&resp));

    // initialize → token（模拟标准客户端从响应取 token 后以头回传）
    let init = call(
        &state,
        r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}"#,
    )
    .await;
    let token = init["result"]["session_token"].as_str().unwrap().to_string();

    // A 会话申请设备 ssh-x1
    let resp = call_as(
        &state,
        &token,
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"devices":["ssh-x1"],"holder":"集成-agent"}}}"#,
    )
    .await;
    let msg = text(&resp);
    assert!(resp["result"]["isError"].is_null(), "申请应成功: {msg}");
    let lease_id = msg.split("已获租约 ").nth(1).unwrap().split('（').next().unwrap().to_string();

    // A 写（闸放行 → 进入工具本体，失败原因是端口未开而非租约）
    let resp = call_as(
        &state,
        &token,
        r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"serial_send","arguments":{"port":"ssh-x1::shell","data":"AT"}}}"#,
    )
    .await;
    let msg = text(&resp);
    assert!(!msg.contains("租约"), "持租约者写应过闸: {msg}");

    // port_open 同样过闸：持租约 → 工具本体报端口打不开；匿名 → 闸拦
    let resp = call_as(
        &state,
        &token,
        r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"port_open","arguments":{"port":"ssh-x1::shell"}}}"#,
    )
    .await;
    let msg = text(&resp);
    assert!(!msg.contains("租约") && resp["result"]["isError"] == true, "持租约开口过闸: {msg}");
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"port_open","arguments":{"port":"ssh-x1::shell"}}}"#,
    )
    .await;
    assert!(text(&resp).contains("租约"), "匿名开口应被闸拦");

    // B 会话（另一 token）写同端口 → 闸拒 + 报出 A 的持有信息
    let resp = call_as(
        &state,
        "token-b-别人",
        r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"serial_send","arguments":{"port":"ssh-x1::shell","data":"AT"}}}"#,
    )
    .await;
    let msg = text(&resp);
    assert!(msg.contains("租约") && msg.contains("集成-agent"), "应报当前持有者: {msg}");

    // B 申请同设备 → 冲突明细
    let resp = call_as(
        &state,
        "token-b-别人",
        r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"devices":["ssh-x1"]}}}"#,
    )
    .await;
    assert!(text(&resp).contains("集成-agent"), "冲突应报持有者");

    // B 释放 A 的租约 → token 不匹配拒；A 释放成功
    let del = format!(r#"{{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{{"name":"lease_release","arguments":{{"lease_id":"{lease_id}"}}}}}}"#);
    let resp = call_as(&state, "token-b-别人", &del).await;
    assert!(text(&resp).contains("不属于"), "非持有者释放应拒");
    let resp = call_as(&state, &token, &del).await;
    assert!(text(&resp).contains("已释放"));

    // 释放后 B 可申请
    let resp = call_as(
        &state,
        "token-b-别人",
        r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"devices":["ssh-x1"]}}}"#,
    )
    .await;
    assert!(resp["result"]["isError"].is_null());
}

/// 租约状态查询：本会话视角。
#[tokio::test]
async fn lease_status_shows_own_leases() {
    let state = state_with_tools();
    let resp = call_as(
        &state,
        "token-status",
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lease_status","arguments":{}}}"#,
    )
    .await;
    assert!(text(&resp).contains("无活跃租约"));

    call_as(
        &state,
        "token-status",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"endpoints":["ssh-x2::shell"]}}}"#,
    )
    .await;
    let resp = call_as(
        &state,
        "token-status",
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lease_status","arguments":{}}}"#,
    )
    .await;
    assert!(text(&resp).contains("ssh-x2::shell"), "{}", text(&resp));
}

//! 设备/拓扑/租约工具的 MCP 集成测试：经 ss_server::mcp 的 handle_request(_with)
//! 走完整 JSON-RPC 调度链（principal 解析、写闸 intercept、扩展分发）。
//! P2.5 模型：设备=一等实体（通道=串口/SSH），拓扑成员/租约均为设备引用。

use serde_json::Value;
use std::sync::Arc;
use topo_hub::mcp_topo::TopoTools;
use topo_hub::test_support::{
    ensure_test_config_dir, make_state, reset_stores, unique_name, STORE_LOCK,
};
use topo_hub::TopoState;

fn state_with_tools() -> TopoState {
    ensure_test_config_dir();
    reset_stores();
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
    resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn tools_listed_alongside_builtin() {
    let state = state_with_tools();
    let resp = call(&state, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 22, "10 内置 + 4 拓扑 + 4 设备 + 4 租约");
    for name in [
        "topo_get",
        "topo_create",
        "topo_update",
        "topo_delete",
        "device_get",
        "device_create",
        "device_update",
        "device_delete",
        "lease_acquire",
        "lease_renew",
        "lease_release",
        "lease_status",
    ] {
        assert!(tools.iter().any(|t| t["name"] == name), "缺工具 {name}");
    }
    // 并入列表粒度的旧名只剩分发别名,tools/list 不出现
    for old in [
        "topo_list",
        "device_list",
        "serial_status",
        "serial_debug_script",
    ] {
        assert!(
            tools.iter().all(|t| t["name"] != old),
            "旧名 {old} 不应出现"
        );
    }
}

#[tokio::test]
async fn device_and_topology_roundtrip() {
    let _g = STORE_LOCK.lock().unwrap();
    let state = state_with_tools();
    let dev_name = unique_name("交换机");
    let topo_name = unique_name("拓扑");

    // 注册设备：串口 + SSH 双通道
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev_name}","model":"H3C S5120","channels":[{{"type":"serial","port":"COM4"}},{{"type":"ssh","host":"192.0.2.70","username":"root","nickname":"车间网关","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    // device_get 不传参=列表（原 device_list 并入）；旧名别名同效
    let msg = text(&call(&state, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"device_get","arguments":{}}}"#).await);
    assert!(
        msg.contains(&dev_name) && msg.contains("串口 COM4"),
        "{msg}"
    );
    let alias = text(&call(&state, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"device_list","arguments":{}}}"#).await);
    assert_eq!(msg, alias, "旧名别名输出应一致");
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"device_get","arguments":{{"device":"{dev_name}"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(msg.contains("空闲") && msg.contains("车间网关"), "{msg}");

    // 设备资源独占：同串口三注册拒绝（throwaway 名，不成器）
    let other = unique_name("设备");
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{other}","channels":[{{"type":"ssh","host":"192.0.2.71","username":"root","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{}","channels":[{{"type":"serial","port":"COM4"}}]}}}}}}"#,
            unique_name("冲突设备")
        ),
    )
    .await;
    assert!(text(&resp).contains("已是其它设备"));

    // 拓扑：成员=设备引用，连线端点=成员设备
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"topo_create","arguments":{{"name":"{topo_name}","members":[{{"device":"{dev_name}","note":"被测交换机"}},{{"device":"{other}"}}],"links":[{{"from":"{dev_name}","to":"{other}","label":"级联"}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    // 未知成员设备报错
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"topo_create","arguments":{"name":"坏","members":[{"device":"ghost"}]}}}"#,
    )
    .await;
    assert!(text(&resp).contains("ghost"));

    // topo_get：设备行（通道+备注）与连接行（设备名）
    let msg = text(
        &call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"topo_get","arguments":{{"topo":"{topo_name}"}}}}}}"#
            ),
        )
        .await,
    );
    assert!(msg.contains(&format!("设备 {dev_name}")), "{msg}");
    assert!(msg.contains("被测交换机"));
    assert!(msg.contains("连接") && msg.contains("级联"), "{msg}");
    // 旧名 topo_list 别名与 topo_get 输出一致
    let alias = text(
        &call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"topo_list","arguments":{{"topo":"{topo_name}"}}}}}}"#
            ),
        )
        .await,
    );
    assert_eq!(msg, alias, "旧名别名输出应一致");

    // 设备删除被拓扑引用拦截
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{{"name":"device_delete","arguments":{{"device":"{dev_name}"}}}}}}"#
        ),
    )
    .await;
    assert!(text(&resp).contains(topo_name.as_str()), "应列出引用拓扑");

    // 清理：删拓扑 → 删设备
    for name in [&topo_name] {
        let resp = call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"topo_delete","arguments":{{"topo":"{name}"}}}}}}"#
            ),
        )
        .await;
        assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    }
    for name in [&dev_name, &other] {
        let resp = call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{{"name":"device_delete","arguments":{{"device":"{name}"}}}}}}"#
            ),
        )
        .await;
        assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    }
}

/// initialize 签发 token → 设备注册 → 申请（设备级）→ 写闸放行/拦截/冲突/释放。
#[tokio::test]
async fn lease_flow_and_write_gate() {
    let _g = STORE_LOCK.lock().unwrap();
    let state = state_with_tools();
    let dev_name = unique_name("闸设备");

    // 匿名写 → 引导 token
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"serial_send","arguments":{"port":"COM4","data":"AT"}}}"#,
    )
    .await;
    assert!(text(&resp).contains("token"));

    // 未注册端口（有 token）→ 引导 device_create
    let resp = call_as(
        &state,
        "tok-x",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_send","arguments":{"port":"COM99","data":"AT"}}}"#,
    )
    .await;
    let msg = text(&resp);
    assert!(msg.contains("device_create"), "未注册端口引导注册: {msg}");

    // initialize → token → 注册设备（COM4 串口 + 内联 SSH）
    let init = call(
        &state,
        r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}"#,
    )
    .await;
    let token = init["result"]["session_token"]
        .as_str()
        .unwrap()
        .to_string();
    let resp = call_as(
        &state,
        &token,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev_name}","channels":[{{"type":"serial","port":"COM4"}},{{"type":"ssh","host":"192.0.2.71","username":"root","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    // 内联 SSH 的通道 id 是服务端生成的——从 REST 读回，拼端点键
    let ssh_ep = topo_hub::device::find(&dev_name)
        .unwrap()
        .channels
        .iter()
        .find_map(|c| match c {
            topo_hub::device::Channel::Ssh(s) => Some(format!("{}::shell", s.id)),
            _ => None,
        })
        .unwrap();

    // A 会话申请设备
    let resp = call_as(
        &state,
        &token,
        &format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"lease_acquire","arguments":{{"devices":["{dev_name}"],"holder":"集成-agent"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(resp["result"]["isError"].is_null(), "申请应成功: {msg}");
    let lease_id = msg
        .split("已获租约 ")
        .nth(1)
        .unwrap()
        .split('（')
        .next()
        .unwrap()
        .to_string();

    // A 写串口通道（过闸 → 工具本体的端口未开错）；写 SSH 通道同样过闸
    for port in ["COM4", &ssh_ep] {
        let resp = call_as(
            &state,
            &token,
            &format!(
                r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"serial_send","arguments":{{"port":"{port}","data":"AT"}}}}}}"#
            ),
        )
        .await;
        let msg = text(&resp);
        assert!(!msg.contains("租约"), "持设备租约写 {port} 应过闸: {msg}");
    }

    // B 会话写同设备另一通道 → 闸拒 + 报出 A（设备级独占的体现）
    let resp = call_as(
        &state,
        "token-b-别人",
        &format!(
            r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"serial_send","arguments":{{"port":"{ssh_ep}","data":"AT"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(
        msg.contains("租约") && msg.contains("集成-agent"),
        "应报当前持有者: {msg}"
    );

    // B 申请同设备（endpoints 糖走 COM4）→ 冲突明细
    let resp = call_as(
        &state,
        "token-b-别人",
        r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"lease_acquire","arguments":{"endpoints":["COM4"]}}}"#,
    )
    .await;
    assert!(text(&resp).contains("集成-agent"), "冲突应报持有者");

    // B 释放 A 的租约 → token 不匹配拒；A 释放成功；B 可申请
    let del = format!(
        r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"lease_release","arguments":{{"lease_id":"{lease_id}"}}}}}}"#
    );
    assert!(text(&call_as(&state, "token-b-别人", &del).await).contains("不属于"));
    assert!(text(&call_as(&state, &token, &del).await).contains("已释放"));
    let resp = call_as(
        &state,
        "token-b-别人",
        &format!(
            r#"{{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{{"name":"lease_acquire","arguments":{{"devices":["{dev_name}"]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null());
}

/// 租约状态查询：本会话视角。
#[tokio::test]
async fn lease_status_shows_own_leases() {
    let _g = STORE_LOCK.lock().unwrap();
    let state = state_with_tools();
    let dev = unique_name("状态设备");
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev}","channels":[{{"type":"ssh","host":"192.0.2.71","username":"root","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    let resp = call_as(
        &state,
        "token-status",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lease_status","arguments":{}}}"#,
    )
    .await;
    assert!(text(&resp).contains("无活跃租约"));

    call_as(
        &state,
        "token-status",
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"lease_acquire","arguments":{{"devices":["{dev}"]}}}}}}"#
        ),
    )
    .await;
    let resp = call_as(
        &state,
        "token-status",
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"lease_status","arguments":{}}}"#,
    )
    .await;
    assert!(text(&resp).contains(&dev), "{}", text(&resp));
}

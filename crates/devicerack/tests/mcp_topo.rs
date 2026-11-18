//! 设备本体论工具面（发现/租约/通道 I/O/管理）的 MCP 集成测试：经
//! ss_server::mcp 的 handle_request(_with) 走完整 JSON-RPC 调度链（principal
//! 解析、写闸 intercept、扩展分发）。分叉声明：内置 serial_* 隐藏、管理面隐藏。

use serde_json::Value;
use std::sync::Arc;
use devicerack::mcp_topo::TopoTools;
use devicerack::test_support::{
    ensure_test_config_dir, make_state, reset_stores, unique_name, STORE_LOCK,
};
use devicerack::TopoState;

fn state_with_tools() -> TopoState {
    ensure_test_config_dir();
    reset_stores();
    let mut ts = TopoState::create(make_state());
    ts.base.mcp_extensions = vec![Arc::new(TopoTools {
        bus: (*ts.topo_bus).clone(),
        leases: Arc::clone(&ts.leases),
        sessions: Arc::clone(&ts.sessions),
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
async fn tools_list_forked_and_admin_hidden() {
    let state = state_with_tools();
    let resp = call(&state, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    // 11 = 发现 3 + 租约 3 + I/O 5（管理 6 隐藏；内置 serial_*/port_* 分叉隐藏）
    assert_eq!(tools.len(), 11, "发现 3 + 租约 3 + I/O 5");
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for name in [
        "get_topology",
        "get_device",
        "list_my_leases",
        "acquire_lease",
        "renew_lease",
        "release_lease",
        "exec_command",
        "open_session",
        "send_input",
        "read_output",
        "close_session",
    ] {
        assert!(names.contains(&name), "缺工具 {name}");
    }
    // 管理面隐藏 + 内置分叉隐藏（tools/list 不出现）
    for hidden in [
        "device_create",
        "device_update",
        "device_delete",
        "topo_create",
        "topo_update",
        "topo_delete",
        "serial_list",
        "serial_send",
        "port_open",
        "port_close",
    ] {
        assert!(
            tools.iter().all(|t| t["name"] != hidden),
            "{hidden} 不应出现在 tools/list"
        );
    }

    // 隐藏≠禁用：内置名与管理面 tools/call 照常分发
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"serial_list","arguments":{}}}"#,
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "内置名照常可调用");
}

#[tokio::test]
async fn device_and_topology_roundtrip() {
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = state_with_tools();
    let dev_name = unique_name("交换机");
    let topo_name = unique_name("拓扑");

    // 管理面（隐藏但可调用）：注册设备（串口 + SSH 双通道）
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev_name}","model":"H3C S5120","channels":[{{"type":"serial","port":"COM4"}},{{"type":"ssh","host":"192.0.2.70","username":"root","nickname":"车间网关","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    // get_device 无参=列表；带参=详情（通道带序号，I/O channel 参数用）
    let msg = text(&call(&state, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_device","arguments":{}}}"#).await);
    assert!(
        msg.contains(&dev_name) && msg.contains("串口 COM4"),
        "{msg}"
    );
    let msg = text(
        &call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"get_device","arguments":{{"device":"{dev_name}"}}}}}}"#
            ),
        )
        .await,
    );
    assert!(
        msg.contains("空闲") && msg.contains("通道[0]") && msg.contains("通道[1]"),
        "详情应带通道序号: {msg}"
    );

    // 设备资源独占：同串口重复注册拒绝
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{}","channels":[{{"type":"serial","port":"COM4"}}]}}}}}}"#,
            unique_name("冲突设备")
        ),
    )
    .await;
    assert!(text(&resp).contains("已是其它设备"));

    // 拓扑：成员=设备引用，连线端点=成员设备
    let other = unique_name("设备");
    call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{other}","channels":[{{"type":"ssh","host":"192.0.2.71","username":"root","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"topo_create","arguments":{{"name":"{topo_name}","members":[{{"device":"{dev_name}","note":"被测交换机"}},{{"device":"{other}"}}],"links":[{{"from":"{dev_name}","to":"{other}","label":"级联","from_port":"GE1/1/1","to_port":"eth0"}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    // 未知成员设备报错
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"topo_create","arguments":{"name":"坏","members":[{"device":"ghost"}]}}}"#,
    )
    .await;
    assert!(text(&resp).contains("ghost"));

    // get_topology：无参=列表；带参=详情（成员行 + 连接行含端口标签）
    let msg = text(&call(&state, r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_topology","arguments":{}}}"#).await);
    assert!(msg.contains(&topo_name), "{msg}");
    let msg = text(
        &call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"get_topology","arguments":{{"topology":"{topo_name}"}}}}}}"#
            ),
        )
        .await,
    );
    assert!(msg.contains(&format!("设备 {dev_name}")), "{msg}");
    assert!(msg.contains("被测交换机"));
    assert!(
        msg.contains("连接") && msg.contains("GE1/1/1") && msg.contains("eth0"),
        "{msg}"
    );

    // 设备删除被拓扑引用拦截
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{{"name":"device_delete","arguments":{{"device":"{dev_name}"}}}}}}"#
        ),
    )
    .await;
    assert!(text(&resp).contains(topo_name.as_str()), "应列出引用拓扑");

    // 清理：删拓扑 → 删设备
    let resp = call(
        &state,
        &format!(
            r#"{{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{{"name":"topo_delete","arguments":{{"topology":"{topo_name}"}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    for name in [&dev_name, &other] {
        let resp = call(
            &state,
            &format!(
                r#"{{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{{"name":"device_delete","arguments":{{"device":"{name}"}}}}}}"#
            ),
        )
        .await;
        assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    }
}

/// 租约流（设备级独占）+ I/O 入口闸：未租约拒绝并引导；持租约后 I/O 过闸
/// （真实端口打开失败属工具本体错误——闸已过，错误文案不同）。
#[tokio::test]
async fn lease_flow_and_io_gate() {
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = state_with_tools();
    let dev_name = unique_name("闸设备");

    // 设备注册（COM99=本机不存在的端口名，测闸语义不碰真串口）
    let resp = call_as(
        &state,
        "tok-a",
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev_name}","channels":[{{"type":"serial","port":"COM99"}}]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));

    // 匿名 exec_command → 引导会话标识
    let resp = call(
        &state,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"exec_command","arguments":{"device":"x","command":"show"}}}"#,
    )
    .await;
    assert!(text(&resp).contains("会话标识"));

    // 有会话无租约 → 引导 acquire_lease
    let resp = call_as(
        &state,
        "tok-a",
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"exec_command","arguments":{{"device":"{dev_name}","command":"show version"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(msg.contains("acquire_lease"), "应引导申请租约: {msg}");

    // 申请租约（设备级）
    let resp = call_as(
        &state,
        "tok-a",
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"acquire_lease","arguments":{{"devices":["{dev_name}"],"holder":"集成-agent"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(resp["result"]["isError"].is_null(), "申请应成功: {msg}");
    assert!(msg.contains("租约=写权"), "成功文案应说明写权: {msg}");
    let lease_id = msg
        .split("已获租约 ")
        .nth(1)
        .unwrap()
        .split('（')
        .next()
        .unwrap()
        .to_string();

    // list_my_leases 可见
    let resp = call_as(
        &state,
        "tok-a",
        r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_my_leases","arguments":{}}}"#,
    )
    .await;
    assert!(text(&resp).contains(&dev_name));

    // 持租约后 I/O：闸过，端口打不开（COM99 不存在）报打开失败（不再是闸拒绝）
    let resp = call_as(
        &state,
        "tok-a",
        &format!(
            r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"exec_command","arguments":{{"device":"{dev_name}","command":"show version"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(
        msg.contains("打开通道失败"),
        "闸过后的端口错误应报打开失败: {msg}"
    );
    assert!(!msg.contains("先 acquire_lease"), "不应再引导租约: {msg}");

    // B 会话 I/O 同设备 → 闸拒 + 报出 A（设备级独占）
    let resp = call_as(
        &state,
        "tok-b",
        &format!(
            r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"exec_command","arguments":{{"device":"{dev_name}","command":"show version"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(
        msg.contains("未持设备") && msg.contains("集成-agent"),
        "应报当前持有者: {msg}"
    );

    // B 申请同设备 → 冲突明细报持有者
    let resp = call_as(
        &state,
        "tok-b",
        &format!(
            r#"{{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{{"name":"acquire_lease","arguments":{{"devices":["{dev_name}"]}}}}}}"#
        ),
    )
    .await;
    assert!(text(&resp).contains("集成-agent"), "冲突应报持有者");

    // B 释放 A 的租约 → token 不匹配拒
    let del = format!(
        r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"release_lease","arguments":{{"lease_id":"{lease_id}"}}}}}}"#
    );
    assert!(text(&call_as(&state, "tok-b", &del).await).contains("不属于"));

    // renew → release → B 可申请
    let resp = call_as(
        &state,
        "tok-a",
        &format!(
            r#"{{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{{"name":"renew_lease","arguments":{{"lease_id":"{lease_id}"}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null(), "{}", text(&resp));
    assert!(text(&call_as(&state, "tok-a", &del).await).contains("已释放"));
    let resp = call_as(
        &state,
        "tok-b",
        &format!(
            r#"{{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{{"name":"acquire_lease","arguments":{{"devices":["{dev_name}"]}}}}}}"#
        ),
    )
    .await;
    assert!(resp["result"]["isError"].is_null());
}

/// 通道寻址（I/O 工具的 channel 参数）：序号 / 标签子串 / 缺省规则 / 越界报错。
/// 不碰真串口——解析错误发生在端口打开之前。
#[tokio::test]
async fn io_channel_addressing() {
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = state_with_tools();
    let dev_name = unique_name("多通道设备");
    call_as(
        &state,
        "tok-ch",
        &format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"device_create","arguments":{{"name":"{dev_name}","channels":[{{"type":"ssh","host":"192.0.2.70","username":"admin","nickname":"管理口","auth":{{"type":"agent"}}}},{{"type":"ssh","host":"192.0.2.70","username":"support","auth":{{"type":"agent"}}}}]}}}}}}"#
        ),
    )
    .await;
    call_as(
        &state,
        "tok-ch",
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"acquire_lease","arguments":{{"devices":["{dev_name}"]}}}}}}"#
        ),
    )
    .await;

    // channel 越界 → 报可选范围
    let resp = call_as(
        &state,
        "tok-ch",
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"exec_command","arguments":{{"device":"{dev_name}","channel":"9","command":"x"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(msg.contains("超出范围") && msg.contains("通道"), "{msg}");

    // channel 标签子串（"admin" 命中通道 0）→ 闸/解析过，SSH 主机不可达报打开失败
    let resp = call_as(
        &state,
        "tok-ch",
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"exec_command","arguments":{{"device":"{dev_name}","channel":"admin","command":"x"}}}}}}"#
        ),
    )
    .await;
    let msg = text(&resp);
    assert!(
        msg.contains("打开通道失败") || msg.contains("发送失败"),
        "应走到连接层（非寻址错误）: {msg}"
    );
    assert!(!msg.contains("无匹配通道"), "{msg}");

    // 不存在的设备 → 引导 get_device
    let resp = call_as(
        &state,
        "tok-ch",
        r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"exec_command","arguments":{"device":"幽灵设备","command":"x"}}}"#,
    )
    .await;
    assert!(text(&resp).contains("设备不存在"));
}

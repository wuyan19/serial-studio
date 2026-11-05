//! 测试辅助（单元与集成测试共用）：AppState 组装（RealPortOpener + SSH fixture）
//! 与配置目录隔离。生产代码不引用本模块。

use ss_core::{EventBus, RealPortOpener, SerialManager};
use ss_server::address::AddressResolver;
use ss_server::device::DeviceClientManager;
use ss_server::ssh::{SshAuthRecord, SshEndpointRecord, SshHostRecord, SshManager};
use ss_server::AppState;
use std::sync::Arc;
use tokio::sync::broadcast;

/// 共享 tempdir 作为配置目录（幂等 set）；store 类测试用唯一拓扑名/串行锁避让。
pub fn ensure_test_config_dir() {
    let dir = std::env::temp_dir().join("topo-hub-test");
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", &dir);
    std::fs::create_dir_all(&dir).unwrap();
}

/// 全局 store 测试锁：device/topology/lease 三个模块的测试共享 devices.json /
/// topologies.json（资源独占校验跨文件生效），必须全局串行；此前各模块各持
/// 一把锁，跨模块互踩 + 失败泄漏的旧数据毒化下一轮（COM4/ssh-x1 被上个运行
/// 的残留设备占住）。每测先清两份库。
pub static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn reset_stores() {
    let Some(dir) = ss_server::config::config_dir() else {
        return;
    };
    let _ = std::fs::remove_file(dir.join("devices.json"));
    let _ = std::fs::remove_file(dir.join("topologies.json"));
}

/// 测试名后缀（进程内自增 + pid，多测试并行不撞名）。
pub fn unique_name(prefix: &str) -> String {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{}-{}-{}", prefix, std::process::id(), n)
}

/// SSH fixture：两台设备。ssh-x1（昵称「车间网关」，shell 端点带别名「控制台」）、
/// ssh-x2（无昵称，shell）。成员定型/展示逻辑测试的数据源。
pub fn ssh_with_entries() -> Arc<SshManager> {
    let m = SshManager::empty();
    m.update_registry(vec![
        SshHostRecord {
            id: "ssh-x1".into(),
            host: "192.0.2.70".into(),
            port: 22,
            username: "root".into(),
            nickname: Some("车间网关".into()),
            auth: SshAuthRecord::Password {
                password: "pw".into(),
            },
            endpoints: vec![SshEndpointRecord {
                name: "shell".into(),
                r#type: "shell".into(),
                alias: Some("控制台".into()),
            }],
        },
        SshHostRecord {
            id: "ssh-x2".into(),
            host: "192.0.2.71".into(),
            port: 22,
            username: "pi".into(),
            nickname: None,
            auth: SshAuthRecord::Agent,
            endpoints: vec![SshEndpointRecord {
                name: "shell".into(),
                r#type: "shell".into(),
                alias: None,
            }],
        },
    ]);
    Arc::new(m)
}

/// 测试 AppState（照 ss-server mcp 测试的 make_state，SSH 换成有内容的 fixture，
/// 且 state.ssh 与 AddressResolver 共用同一实例——别名解析与 has_host 同源）。
pub fn make_state() -> AppState {
    let event_bus = Arc::new(EventBus::new(16));
    let (meta_tx, _) = broadcast::channel(16);
    let (script_tx, _) = broadcast::channel(16);
    let devices = Arc::new(DeviceClientManager::empty(
        script_tx.clone(),
        "inst-topo-test",
    ));
    let ssh = ssh_with_entries();
    let addresses = Arc::new(AddressResolver::new(
        Arc::clone(&devices),
        Arc::clone(&ssh),
        meta_tx.clone(),
        "inst-topo-test".into(),
    ));
    let manager = Arc::new(SerialManager::with_key_resolver(
        event_bus.clone(),
        Arc::new(RealPortOpener),
        addresses.key_resolver_fn(),
    ));
    AppState {
        manager,
        event_bus,
        meta_bus: Arc::new(meta_tx),
        script_bus: Arc::new(script_tx),
        enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
        closers: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        script_runs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        devices,
        ssh,
        addresses,
        instance_id: "inst-topo-test".into(),
        mcp_extensions: Vec::new(),
    }
}

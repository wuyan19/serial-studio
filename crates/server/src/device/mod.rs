//! 远程设备管理层:注册表 + 连接池 + 对 core 的 PortOpener 路由。
//!
//! 抽象定位(面向未来演进):一台"设备"= 一个可寻址的端口提供方。当前唯一
//! transport 是 WS(连远端 ss);未来直连 TCP 串口服务器 / RFC 2217 等实现
//! DeviceTransport 即可,注册表/状态机/列表合并逻辑不动。
//!
//! 生命周期:挂在 AppState(跨 ServiceSupervisor 热重启保留);`start()` 惰性 +
//! 幂等(镜像 core drainer 的教训:new() 时无 reactor 不能 spawn)。
//! 设备注册表读 remotes.json(save_remotes 后 update_registry 增删 diff)。

pub mod client;
pub mod port_io;

pub use client::DeviceClient;

use ss_core::{split_port_key, PortIo, RemoteDevice, SerialConfig, SerialError};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::protocol::DeviceStateView;
use crate::PortView;

/// 设备命令(DeviceClient 的 writer 消费;与 open 同通道保序)。
pub(crate) enum DeviceCommand {
    Open {
        port: String,
        config: SerialConfig,
        /// Ok 载荷 = 服务端实际打开的远端线名(Acquired.resolved;登记 IO 用真名)
        reply: std::sync::mpsc::Sender<Result<String, String>>,
    },
    Write {
        port: String,
        data: Vec<u8>,
        reply: std::sync::mpsc::Sender<std::io::Result<()>>,
    },
    ClosePort {
        port: String,
    },
    SetAlias {
        port: String,
        alias: Option<String>,
        /// Ok 载荷(解析后线名)对别名设置无意义,调用方只看成败
        reply: std::sync::mpsc::Sender<Result<String, String>>,
    },
    /// 重拉远端端口列表(远端 MetaChanged/事件到达时触发;结果经 Ports 消息
    /// 更新缓存并 diff 决定是否通知本地——**不直接扇出**,防自连回授环)。
    RefreshList,
}

/// 设备上下线事件(device_bus 广播;ws / tauri 两出口订阅转发给前端)。
#[derive(Clone, Debug)]
pub enum DeviceEvent {
    Online { dev_id: String },
    Offline { dev_id: String },
}

/// 设备连接管理器。
pub struct DeviceClientManager {
    devices: std::sync::Mutex<HashMap<String, Arc<DeviceClient>>>,
    device_bus: broadcast::Sender<DeviceEvent>,
    meta_bus: broadcast::Sender<()>,
    started: AtomicBool,
}

impl DeviceClientManager {
    /// 空管理器(测试/无设备;不 spawn,注册设备需手动 update + start)。
    pub fn empty(meta_bus: broadcast::Sender<()>) -> Self {
        let (device_bus, _) = broadcast::channel(16);
        Self {
            devices: std::sync::Mutex::new(HashMap::new()),
            device_bus,
            meta_bus,
            started: AtomicBool::new(false),
        }
    }

    /// 读 remotes.json 构造(生产组装点)。
    pub fn from_registry(meta_bus: broadcast::Sender<()>) -> Self {
        let m = Self::empty(meta_bus);
        let remotes = crate::remotes_store::load();
        if !remotes.is_empty() {
            m.update_registry(&remotes);
        }
        m
    }

    /// 幂等惰性启动:eager 连接全部注册设备(拉端口列表需要连接)。
    /// 由 supervisor.start(GUI 经 tauri::async_runtime / headless 经 rt)触发。
    pub fn start(&self) {
        if self.started.swap(true, Ordering::Relaxed) {
            return;
        }
        let clients: Vec<Arc<DeviceClient>> =
            self.devices.lock().unwrap().values().cloned().collect();
        for c in clients {
            tokio::spawn(async move { c.run().await });
        }
    }

    /// 更新注册表(save_remotes 后):新增即建连,删除即断连;已有设备的地址
    /// 变化按"删旧建新"处理(简单可靠,连接状态不迁移)。
    pub fn update_registry(&self, remotes: &[RemoteDevice]) {
        let mut devices = self.devices.lock().unwrap();
        let want: HashMap<String, (String, u16)> = remotes
            .iter()
            .map(|d| (d.id.clone(), (d.host.clone(), d.port)))
            .collect();
        // 删除不再存在的 / 地址变化的(旧 client 的句柄随通道失效走断开路径)
        let stale_ids: Vec<String> = devices
            .iter()
            .filter(|(id, c)| {
                want.get(*id)
                    .map(|(h, p)| c.device().host != *h || c.device().port != *p)
                    .unwrap_or(true)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale_ids {
            if let Some(old) = devices.remove(&id) {
                old.stop();
            }
        }
        // 新增
        for d in remotes {
            if devices.contains_key(&d.id) {
                continue;
            }
            self.spawn_client_locked(&mut devices, d.clone());
        }
    }

    /// 建立并(若已启动)拉起一个设备 client。devices 须已持有锁。
    fn spawn_client_locked(
        &self,
        devices: &mut HashMap<String, Arc<DeviceClient>>,
        dev: RemoteDevice,
    ) {
        let client = Arc::new(DeviceClient::new(
            dev,
            self.device_bus.clone(),
            self.meta_bus.clone(),
        ));
        let id = client.device().id.clone();
        devices.insert(id, Arc::clone(&client));
        if self.started.load(Ordering::Relaxed) {
            tokio::spawn(async move { client.run().await });
        }
    }

    /// 订阅设备上下线事件。
    pub fn subscribe(&self) -> broadcast::Receiver<DeviceEvent> {
        self.device_bus.subscribe()
    }

    /// 打开远端端口(PortOpener 路由入口;同步,spawn_blocking 内调)。
    /// `port` 为剥掉本设备段后的后缀(可能仍含更深层级——级联整体透传)。
    pub fn open_blocking(
        &self,
        dev_id: &str,
        port: &str,
        config: &SerialConfig,
    ) -> Result<Box<dyn PortIo>, SerialError> {
        let client = {
            let devices = self.devices.lock().unwrap();
            devices.get(dev_id).cloned()
        };
        match client {
            Some(c) => c.open_blocking(port, config),
            None => Err(SerialError::OpenFailed {
                port: format!("{}::{}", dev_id, port),
                message: format!("远程设备 {} 未注册", dev_id),
            }),
        }
    }

    /// 远端设备端口桶(列表合并用):每设备返回 (devId, 远端 PortView 缓存快照)。
    /// 键由调用方 compose(devId, 远端线名)——远端别名随 PortView 透传。
    pub fn remote_buckets(&self) -> Vec<(String, Vec<PortView>)> {
        let devices = self.devices.lock().unwrap();
        devices
            .iter()
            .map(|(id, c)| (id.clone(), c.cached_ports_snapshot()))
            .collect()
    }

    /// 设备状态快照(Devices 推送用)。
    pub fn device_states(&self) -> Vec<DeviceStateView> {
        self.devices
            .lock()
            .unwrap()
            .values()
            .map(|c| c.state_view())
            .collect()
    }

    /// 设备 id 是否已注册(完整键首段甄别:id 恒权威,昵称只在非 id 时尝试)。
    pub fn is_registered(&self, dev_id: &str) -> bool {
        self.devices.lock().unwrap().contains_key(dev_id)
    }

    /// 昵称 → 设备 id 列表(AddressResolver 的设备别名查询)。
    /// 注册表个位数条目,现查免缓存恒新鲜;多个同名昵称返回多条(歧义由调用方处理)。
    pub fn ids_by_nickname(&self, nick: &str) -> Vec<String> {
        let devices = self.devices.lock().unwrap();
        devices
            .values()
            .filter(|c| c.device().nickname.as_deref() == Some(nick))
            .map(|c| c.device().id.clone())
            .collect()
    }

    /// 设备 id → 昵称(serial_list / MCP 展示用)。
    pub fn nickname_of(&self, dev_id: &str) -> Option<String> {
        let devices = self.devices.lock().unwrap();
        devices
            .get(dev_id)
            .and_then(|c| c.device().nickname.clone())
    }

    /// 设置远端端口别名(转发;port 为剥前缀后的远端线名)。
    pub fn set_alias_blocking(
        &self,
        dev_id: &str,
        port: &str,
        alias: Option<String>,
    ) -> Result<(), String> {
        let client = {
            let devices = self.devices.lock().unwrap();
            devices.get(dev_id).cloned()
        };
        match client {
            Some(c) => c.set_alias_blocking(port, alias),
            None => Err(format!("远程设备 {} 未注册", dev_id)),
        }
    }

    /// 主动断开设备(断开按钮):停重连,置离线。再次连接走 reconnect(重置 stopped)。
    pub fn disconnect(&self, dev_id: &str) -> Result<(), String> {
        let devices = self.devices.lock().unwrap();
        match devices.get(dev_id) {
            Some(c) => {
                c.stop();
                Ok(())
            }
            None => Err(format!("远程设备 {} 未注册", dev_id)),
        }
    }

    /// 重连设备(重连按钮):删旧建新——旧 client 的命令通道随旧 run 退出而失效,
    /// 旧句柄发命令失败走断开路径;reopen 经 devices 表查到**新** client,走新通道。
    pub fn reconnect(&self, dev_id: &str) -> Result<(), String> {
        let mut devices = self.devices.lock().unwrap();
        match devices.get(dev_id).map(|c| c.device().clone()) {
            Some(dev) => {
                if let Some(old) = devices.remove(dev_id) {
                    old.stop();
                }
                self.spawn_client_locked(&mut devices, dev);
                Ok(())
            }
            None => Err(format!("远程设备 {} 未注册", dev_id)),
        }
    }
}

/// 组合 opener:本地串口走 core 的 serial,远端设备走 DeviceClientManager。
/// 后缀整体透传(split 首段路由)——级联(A→B→C)逐层剥段,无特判。
pub struct CompositeOpener {
    devices: Arc<DeviceClientManager>,
}

impl CompositeOpener {
    pub fn new(devices: Arc<DeviceClientManager>) -> Self {
        Self { devices }
    }
}

impl ss_core::PortOpener for CompositeOpener {
    fn open(&self, port: &str, config: &SerialConfig) -> Result<Box<dyn PortIo>, SerialError> {
        match split_port_key(port) {
            (ss_core::LOCAL_DEVICE_ID, name) => ss_core::serial::open(name, config),
            (dev, rest) => self.devices.open_blocking(dev, rest, config),
        }
    }
}

//! 端口寻址解析：别名(本机/远端)与设备昵称 → 规范端口键。
//!
//! 架构定位:**别名解析只发生在 manager 边界一处**——core 的 `SerialManager`
//! 经 `KeyResolver` 闭包调用这里,WS/MCP/Telnet/脚本各接入方自动获得别名能力,
//! 不在任一 adapter 私藏解析逻辑。
//!
//! 解析规则(与 SKILL.md / MCP usage guide 同源):
//! 1. 完整键(含 `::`,首段为设备 id)→ 原样返回;
//!    首段非 id 而是唯一匹配的设备昵称 → 重写为该设备 id(`test::COM5` → `uuidB::COM5`)。
//!    末段为叶别名(后缀不含 `::`)且在该设备作用域内唯一命中 → 一并重写
//!    (`test::GPS` / `uuidB::GPS` → `uuidB::COM9`)——远端口别名随列表透传,
//!    本机索引与远端 ports.json 同源,本地解析与远端解析殊途同归。
//!    多级后缀透传,由下一跳继续解析——`test::uuidC::…` 逐层生效,无需特判。
//! 2. 裸名:本机端口别名优先(与"裸名=本机"语义一致),其次在线设备的远端端口别名
//!    (唯一命中才解析)。多个命中 = 真歧义(平名输入信息不足),warn + 原样透传,
//!    下游 NotOpen 兜底;MCP 入口经 [`AddressResolver::lookup_port`] 报出候选列表。
//!
//! 性能契约:resolver 是热路径(send 每次都过),故本机+远端端口别名叫表缓存在内存
//! (`RwLock<HashMap>`),由 meta_bus 通知驱动重建(set_alias / 设备列表 diff 都发
//! meta_bus);设备昵称直接扫注册表(个位数条目,免缓存恒新鲜)。

use ss_core::{compose_port_key, normalize_port_key, split_port_key, PORT_KEY_SEP};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

use crate::device::DeviceClientManager;

/// 别名查找结果。Ambiguous 时携带全部候选键(按 本机优先、键名字典序 排序)。
#[derive(Debug, Clone, PartialEq)]
pub enum AliasMatch {
    /// 无命中(调用方应原样透传,下游 NotOpen 兜底)。
    None,
    /// 唯一命中。
    Unique(String),
    /// 多个命中——平名输入欠定,不得擅自挑一个(串口写错设备有真实后果)。
    Ambiguous(Vec<String>),
}

/// 端口寻址解析器。克隆共享(Arc 内核);manager 持有的闭包与 MCP 直查共用同一实例。
pub struct AddressResolver {
    inner: Arc<Inner>,
}

struct Inner {
    devices: Arc<DeviceClientManager>,
    /// 本机实例 id(透传谓词语义判据用)。非 'static 硬编码,由装配点注入。
    self_id: Arc<str>,
    /// 别名 → 候选完整键列表。含本机(裸名键)与远端(compose 键)。
    /// 由 watcher 任务在 meta_bus 通知时重建;空索引时查不到即透传。
    port_aliases: RwLock<HashMap<String, Vec<String>>>,
    /// 本机真实枚举串口名(原值集 + 小写集,Windows 大小写不敏感)。
    /// **真实名恒优先于别名**:远端设备可能把它的口起了与本机口同名的别名,
    /// 若别名无条件命中,同一输入的路由目标会随设备在线状态漂移(可写错设备)。
    real_names: RwLock<RealNames>,
    /// 各远端设备的真实叶名(小写集)。设备作用域叶别名解析的同则防护:
    /// 远端 validate_alias 只在写入时点校验别名不与真实口同名,之后插上的
    /// 口不受其约束——解析侧以「命中该设备真实叶名即透传」兜底,别名永远
    /// 遮蔽不了远端真实口。
    device_real_names: RwLock<HashMap<String, std::collections::HashSet<String>>>,
    /// watcher 是否已启动(惰性:首次 resolver 调用时才需要 runtime)。
    watcher_started: AtomicBool,
    /// 重建触发源:set_alias / 设备 Ports diff / 设备注册表变更都发此广播。
    meta_bus: broadcast::Sender<()>,
    /// 本地端口元数据读取器(生产=ports.json 落盘读;测试注入内存表,
    /// 免环境变量竞争)。重建时调用。
    meta_loader: MetaLoader,
}

/// 本地端口元数据读取器。
pub(crate) type MetaLoader = Arc<
    dyn Fn() -> std::collections::BTreeMap<String, crate::port_meta_store::PortMeta> + Send + Sync,
>;

/// 本机真实端口名集合(精确 + 小写双形态;小写形态供 Windows 大小写不敏感匹配)。
#[derive(Default, Clone)]
struct RealNames {
    exact: std::collections::HashSet<String>,
    lower: std::collections::HashSet<String>,
}

impl AddressResolver {
    /// 生产构造。不立即 spawn watcher(new() 可能不在 runtime 内);
    /// 首次经 [`Self::key_resolver_fn`] / [`Self::lookup_port`] 调用时同步重建一次
    /// 再惰性拉起订阅循环。
    pub fn new(
        devices: Arc<DeviceClientManager>,
        meta_bus: broadcast::Sender<()>,
        self_id: Arc<str>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                devices,
                self_id,
                port_aliases: RwLock::new(HashMap::new()),
                real_names: RwLock::new(RealNames::default()),
                device_real_names: RwLock::new(HashMap::new()),
                watcher_started: AtomicBool::new(false),
                meta_bus,
                meta_loader: Arc::new(crate::port_meta_store::load),
            }),
        }
    }

    /// 注入给 SerialManager 的 KeyResolver(canonical 化的别名半边)。
    /// 输入已完成遗留 `local::` 剥除;失败/歧义一律原样透传(warn 留痕)。
    pub fn key_resolver_fn(&self) -> ss_core::KeyResolver {
        let inner = Arc::clone(&self.inner);
        Arc::new(move |key: &str| inner.resolve(key))
    }

    /// MCP 入口的直查:返回歧义候选以便向用户报错(resolver 路径只能 warn)。
    /// 同样触发惰性 watcher——纯 MCP 场景(无任何端口操作)也要有新鲜索引。
    pub fn lookup_port(&self, alias_or_name: &str) -> AliasMatch {
        self.inner.ensure_watcher();
        let aliases = self.inner.port_aliases.read().unwrap();
        let real = self.inner.real_names.read().unwrap();
        resolve_bare(alias_or_name, &real, &aliases)
    }

    /// 设备昵称 → 设备 id 列表(注册表现查,恒新鲜)。
    pub fn device_ids_by_nickname(&self, nick: &str) -> Vec<String> {
        self.inner.devices.ids_by_nickname(nick)
    }

    /// 设备 id → 昵称(serial_list 展示用)。
    pub fn nickname_of(&self, dev_id: &str) -> Option<String> {
        self.inner.devices.nickname_of(dev_id)
    }
}

impl Inner {
    fn resolve(self: &Arc<Self>, key: &str) -> String {
        // 首次调用:同步重建索引(磁盘读一次,毫秒级)+ 惰性拉起 meta_bus 订阅循环
        self.ensure_watcher();
        if key.contains(PORT_KEY_SEP) {
            self.resolve_device_scope(key)
        } else {
            // 热路径(send 每次都过):持读锁查表即返,不做整表克隆;
            // resolve_bare 纯同步短临界区,锁内无 IO 无重入
            let aliases = self.port_aliases.read().unwrap();
            let real = self.real_names.read().unwrap();
            match resolve_bare(key, &real, &aliases) {
                AliasMatch::Unique(k) => k,
                AliasMatch::Ambiguous(cands) => {
                    tracing::warn!("端口别名「{key}」匹配多个端口 {cands:?},不擅自选择,原样透传");
                    key.to_string()
                }
                AliasMatch::None => key.to_string(),
            }
        }
    }

    /// 完整键的首段甄别:设备 id 原样;唯一昵称重写为 id;其余原样(下游报未注册)。
    /// 首段落定后,末段叶别名(后缀不含 `::`)在该设备作用域内唯一命中则一并重写。
    fn resolve_device_scope(self: &Arc<Self>, key: &str) -> String {
        let (first, rest) = split_port_key(key);
        let dev = if self.devices.is_registered(first) {
            first.to_string()
        } else {
            match self.devices.ids_by_nickname(first) {
                ids if ids.len() == 1 => ids[0].clone(),
                ids if ids.len() > 1 => {
                    tracing::warn!("设备昵称「{first}」匹配多台设备 {ids:?},不擅自选择");
                    return key.to_string();
                }
                _ => return key.to_string(),
            }
        };
        // 叶别名解析只对不含 :: 的末段尝试;多级后缀透传给下一跳(其 manager 解析)
        if !rest.contains(PORT_KEY_SEP) {
            if let Some(resolved) = self.resolve_leaf_alias(&dev, rest) {
                return resolved;
            }
        }
        compose_port_key(&dev, rest)
    }

    /// 设备作用域内的叶别名 → 完整键。候选取自别名索引(键首段 == 该设备),
    /// 唯一命中才重写;设备内歧义/无命中返回 None(原样透传)。
    /// **真实名恒优先**:leaf 命中该设备的真实叶名(小写,Windows 口径与
    /// resolve_bare 一致)时透传——远端 validate_alias 是写入时点快照,
    /// 之后新插的口不受其约束,别名遮蔽真实口在这里兜底。
    fn resolve_leaf_alias(&self, dev_id: &str, leaf: &str) -> Option<String> {
        if self
            .device_real_names
            .read()
            .unwrap()
            .get(dev_id)
            .map(|s| s.contains(&leaf.to_lowercase()))
            .unwrap_or(false)
        {
            return None;
        }
        let aliases = self.port_aliases.read().unwrap();
        let mut cands: Vec<&String> = aliases
            .get(leaf)?
            .iter()
            .filter(|k| split_port_key(k).0 == dev_id)
            .collect();
        match cands.len() {
            1 => Some(cands.remove(0).clone()),
            0 => None,
            _ => {
                tracing::warn!("端口别名「{leaf}」在设备 {dev_id} 内匹配多个端口,不擅自选择");
                None
            }
        }
    }

    /// 全量重建别名索引:本机真实枚举名 + 本地 ports.json(裸名键)+ 各在线设备缓存(归一线名)。
    fn rebuild(&self) {
        // 真实端口名(优先级最高——真实名输入恒透传,别名不得遮蔽)
        let mut real = RealNames::default();
        for name in ss_core::serial::list_port_names() {
            real.lower.insert(name.to_lowercase());
            real.exact.insert(name);
        }
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for (port, meta) in (self.meta_loader)() {
            if let Some(a) = meta.alias {
                map.entry(a).or_default().push(port); // 本机键 = 裸名(store 即裸名键)
            }
        }
        // 各设备真实叶名(小写)——设备作用域叶别名解析的「真实名恒优先」判据
        let mut device_real: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
        for (dev_id, views) in self.devices.remote_buckets() {
            for pv in views {
                // 与 DeviceClient 入站归一同一规则;此处幂等兜底。
                // 多级条目与列表合并共用透传谓词(环检测+深度上限)——否则列表可见
                // 的级联口裸名别名解析不到,行为分裂
                let wire = normalize_port_key(&pv.info.name);
                if let Some(key) = crate::passthrough_port_key(&dev_id, &wire, &self.self_id) {
                    // 真实叶名 = 复合键末段(多级级联即最末跳的口名)
                    let leaf = key
                        .rsplit(PORT_KEY_SEP)
                        .next()
                        .unwrap_or(&key)
                        .to_lowercase();
                    device_real.entry(dev_id.clone()).or_default().insert(leaf);
                    if let Some(a) = pv.alias {
                        map.entry(a).or_default().push(key);
                    }
                }
            }
        }
        *self.real_names.write().unwrap() = real;
        *self.port_aliases.write().unwrap() = map;
        *self.device_real_names.write().unwrap() = device_real;
    }

    /// 惰性启动:**先订阅后重建**——订阅与重建之间发生的变更必然触发循环内再重建,
    /// 不丢通知;反序则有窗口(订阅前最后一次变更丢失,索引陈旧到下一事件)。
    /// 循环里 Lagged(广播积压)也走重建——宁可多建,不可陈旧。
    fn ensure_watcher(self: &Arc<Self>) {
        if self.watcher_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        let mut rx = self.meta_bus.subscribe();
        // 初始状态在调用方线程同步重建(单个小文件读,毫秒级,一次性);
        // 后续重建走 spawn_blocking——不阻塞 tokio worker。
        this.rebuild();
        tokio::spawn(async move {
            while let Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) = rx.recv().await {
                let t = Arc::clone(&this);
                let _ = tokio::task::spawn_blocking(move || t.rebuild()).await;
            }
        });
    }
}

/// 裸名解析(纯函数,可测):**完整键 > 真实端口名 > 别名 > 透传**。
/// 真实名命中(精确或 Windows 大小写不敏感)直接 None(= 原样透传),
/// 保证别名永远无法遮蔽本机真实串口——否则路由目标随远端在线状态漂移。
fn resolve_bare(
    name: &str,
    real: &RealNames,
    aliases: &HashMap<String, Vec<String>>,
) -> AliasMatch {
    if real.exact.contains(name) || real.lower.contains(&name.to_lowercase()) {
        return AliasMatch::None;
    }
    let Some(cands) = aliases.get(name) else {
        return AliasMatch::None;
    };
    match cands.len() {
        0 => AliasMatch::None,
        1 => AliasMatch::Unique(cands[0].clone()),
        _ => {
            // 本机优先(裸名在前),同组内字典序——确定性,便于测试与预期
            let mut sorted = cands.clone();
            sorted.sort_by_key(|k| (k.contains(PORT_KEY_SEP), k.clone()));
            AliasMatch::Ambiguous(sorted)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::DeviceClientManager;

    /// 不触盘的测试解析器(设备表注入昵称 "test" 的设备 id=uuid-b,不 start)。
    fn resolver_with_devices() -> AddressResolver {
        let (meta_tx, _) = broadcast::channel(16);
        let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone(), "inst-self"));
        devices.update_registry(&[ss_core::RemoteDevice {
            id: "uuid-b".into(),
            host: "127.0.0.1".into(),
            port: 1,
            nickname: Some("test".into()),
        }]);
        AddressResolver::new(Arc::clone(&devices), meta_tx, "inst-self".into())
    }

    fn real_names_of(names: &[&str]) -> RealNames {
        let mut r = RealNames::default();
        for n in names {
            r.exact.insert(n.to_string());
            r.lower.insert(n.to_lowercase());
        }
        r
    }

    #[test]
    fn bare_real_name_beats_alias_and_case_folds() {
        // 远端别名与本机真实口同名:真实名恒胜出(否则路由随远端在线状态漂移)
        let real = real_names_of(&["COM5"]);
        let aliases = HashMap::from([("COM5".to_string(), vec!["uuid-b::COM9".to_string()])]);
        assert_eq!(
            resolve_bare("COM5", &real, &aliases),
            AliasMatch::None,
            "真实端口名命中应透传,别名不得遮蔽"
        );
        // Windows 大小写不敏感:com5 视同 COM5
        assert_eq!(resolve_bare("com5", &real, &aliases), AliasMatch::None);
    }

    #[test]
    fn bare_alias_unique_local_and_remote() {
        let real = real_names_of(&[]);
        let aliases = HashMap::from([
            ("GPS".to_string(), vec!["COM7".to_string()]),
            ("CAM".to_string(), vec!["uuid-b::COM9".to_string()]),
        ]);
        assert_eq!(
            resolve_bare("GPS", &real, &aliases),
            AliasMatch::Unique("COM7".into())
        );
        assert_eq!(
            resolve_bare("CAM", &real, &aliases),
            AliasMatch::Unique("uuid-b::COM9".into()),
            "远端唯一命中同样可解析"
        );
    }

    #[test]
    fn bare_alias_ambiguous_lists_local_first() {
        let real = real_names_of(&[]);
        let aliases = HashMap::from([(
            "GPS".to_string(),
            vec![
                "uuid-a::COM5".to_string(),
                "COM7".to_string(),
                "uuid-b::COM9".to_string(),
            ],
        )]);
        match resolve_bare("GPS", &real, &aliases) {
            AliasMatch::Ambiguous(cands) => {
                // 本机(裸名)优先,组内字典序——确定性输出供 MCP 报候选
                assert_eq!(cands, vec!["COM7", "uuid-a::COM5", "uuid-b::COM9"]);
            }
            other => panic!("应为 Ambiguous,得到 {:?}", other),
        }
    }

    #[test]
    fn unknown_name_is_none() {
        let real = real_names_of(&[]);
        assert_eq!(
            resolve_bare("COM7", &real, &HashMap::new()),
            AliasMatch::None
        );
    }

    #[test]
    fn full_key_and_device_nickname_resolution() {
        let r = resolver_with_devices();
        // 完整键:首段是注册设备 id → 原样
        assert_eq!(r.inner.resolve_device_scope("uuid-b::COM5"), "uuid-b::COM5");
        // 首段是唯一昵称 → 重写为设备 id
        assert_eq!(r.inner.resolve_device_scope("test::COM5"), "uuid-b::COM5");
        // 未知首段 → 原样透传(下游报未注册)
        assert_eq!(r.inner.resolve_device_scope("ghost::COM5"), "ghost::COM5");
    }

    /// 预置别名索引的解析器(watcher_started=true 防重建清空预置索引)。
    /// 设备 uuid-b(昵称 test);GPS 的候选键列表由调用方给定。
    fn scoped_resolver_with_alias(gps_candidates: Vec<String>) -> AddressResolver {
        let (meta_tx, _) = broadcast::channel(16);
        let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone(), "inst-self"));
        devices.update_registry(&[ss_core::RemoteDevice {
            id: "uuid-b".into(),
            host: "127.0.0.1".into(),
            port: 1,
            nickname: Some("test".into()),
        }]);
        AddressResolver {
            inner: Arc::new(Inner {
                devices,
                self_id: "inst-self".into(),
                port_aliases: RwLock::new(HashMap::from([("GPS".to_string(), gps_candidates)])),
                real_names: RwLock::new(RealNames::default()),
                device_real_names: RwLock::new(HashMap::from([(
                    "uuid-b".to_string(),
                    std::collections::HashSet::from(["com9".to_string()]),
                )])),
                watcher_started: AtomicBool::new(true),
                meta_bus: meta_tx,
                meta_loader: Arc::new(std::collections::BTreeMap::new),
            }),
        }
    }

    /// 真实名遮蔽防护:别名与该设备真实叶名同名(COM9 既是 COM7 的别名、
    /// 又是设备上后来插入的真实口)时,真实名输入透传,不被别名重写。
    #[test]
    fn device_scope_real_name_beats_shadowing_alias() {
        // 别名 COM9 → uuid-b::COM7;设备真实叶名含 com9(rebuild 测试里
        // scoped_resolver_with_alias 预置了 com9)
        let (meta_tx, _) = broadcast::channel(16);
        let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone(), "inst-self"));
        devices.update_registry(&[ss_core::RemoteDevice {
            id: "uuid-b".into(),
            host: "127.0.0.1".into(),
            port: 1,
            nickname: Some("test".into()),
        }]);
        let r = AddressResolver {
            inner: Arc::new(Inner {
                devices,
                self_id: "inst-self".into(),
                port_aliases: RwLock::new(HashMap::from([(
                    "COM9".to_string(),
                    vec!["uuid-b::COM7".to_string()],
                )])),
                real_names: RwLock::new(RealNames::default()),
                device_real_names: RwLock::new(HashMap::from([(
                    "uuid-b".to_string(),
                    std::collections::HashSet::from(["com9".to_string()]),
                )])),
                watcher_started: AtomicBool::new(true),
                meta_bus: meta_tx,
                meta_loader: Arc::new(std::collections::BTreeMap::new),
            }),
        };
        // 真实名输入(大小写不敏感) → 透传,不重写到 COM7
        assert_eq!(r.inner.resolve_device_scope("uuid-b::COM9"), "uuid-b::COM9");
        assert_eq!(r.inner.resolve_device_scope("test::com9"), "uuid-b::com9");
    }

    #[test]
    fn device_scope_resolves_leaf_alias() {
        let r = scoped_resolver_with_alias(vec!["uuid-b::COM9".to_string()]);
        // 昵称 + 叶别名 → 设备 id + 真实端口名
        assert_eq!(r.inner.resolve_device_scope("test::GPS"), "uuid-b::COM9");
        // 设备 id + 叶别名同样解析(本地检查与远端解析口径一致)
        assert_eq!(r.inner.resolve_device_scope("uuid-b::GPS"), "uuid-b::COM9");
        // 末段是真实端口名(com9 在设备真实叶名集)→ 真实名恒优先,透传(compose 回原键)
        assert_eq!(r.inner.resolve_device_scope("test::COM9"), "uuid-b::COM9");
    }

    #[test]
    fn device_scope_leaf_alias_ambiguous_passthrough() {
        // 同设备两个端口共用别名 GPS → 叶别名歧义不重写;首段昵称照常重写
        let r = scoped_resolver_with_alias(vec![
            "uuid-b::COM9".to_string(),
            "uuid-b::COM7".to_string(),
        ]);
        assert_eq!(r.inner.resolve_device_scope("test::GPS"), "uuid-b::GPS");
        // 别名属于别的设备(首段过滤后无候选)→ 叶别名透传
        let r2 = scoped_resolver_with_alias(vec!["uuid-c::COM9".to_string()]);
        assert_eq!(r2.inner.resolve_device_scope("uuid-b::GPS"), "uuid-b::GPS");
    }

    #[test]
    fn device_scope_multihop_suffix_untouched() {
        // 多级后缀(含 ::)不在本级解析叶别名,透传给下一跳
        let r = scoped_resolver_with_alias(vec!["uuid-b::COM9".to_string()]);
        assert_eq!(
            r.inner.resolve_device_scope("test::uuid-c::GPS"),
            "uuid-b::uuid-c::GPS"
        );
    }

    #[test]
    fn device_ids_by_nickname_query() {
        let r = resolver_with_devices();
        assert_eq!(r.device_ids_by_nickname("test"), vec!["uuid-b"]);
        assert!(r.device_ids_by_nickname("nope").is_empty());
        assert_eq!(r.nickname_of("uuid-b"), Some("test".into()));
    }

    /// rebuild 集成测:经注入的 meta_loader 种入本地别名(免环境变量——
    /// 进程内并行测试会互相翻转 SERIAL_STUDIO_CONFIG_DIR,env 种子有 flake),
    /// 公开 lookup_port 走真实的 ensure_watcher→rebuild→索引 链路。
    #[tokio::test]
    async fn rebuild_picks_up_local_alias() {
        let (meta_tx, _) = broadcast::channel(16);
        let devices = Arc::new(DeviceClientManager::empty(meta_tx.clone(), "inst-self"));
        let mut seed = std::collections::BTreeMap::new();
        seed.insert(
            "R-COM7".to_string(),
            crate::port_meta_store::PortMeta {
                alias: Some("R-GPS".to_string()),
            },
        );
        let loader: MetaLoader = Arc::new(move || seed.clone());
        let r = AddressResolver {
            inner: Arc::new(Inner {
                devices,
                self_id: "inst-self".into(),
                port_aliases: RwLock::new(HashMap::new()),
                real_names: RwLock::new(RealNames::default()),
                device_real_names: RwLock::new(HashMap::new()),
                watcher_started: AtomicBool::new(false),
                meta_bus: meta_tx,
                meta_loader: loader,
            }),
        };
        assert_eq!(
            r.lookup_port("R-GPS"),
            AliasMatch::Unique("R-COM7".into()),
            "rebuild 应从注入的元数据表拾取本机别名"
        );
    }
}

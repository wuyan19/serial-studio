//! 共享宏/脚本库的线协议载荷类型(Kind/Change/Changes/Snapshot)。
//! get/patch 编排依赖 ss-server 的宏/脚本 store,留在 server 侧同名模块。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Macros,
    Scripts,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Change {
    pub before: Option<Value>,
    pub after: Option<Value>,
}

pub type Changes = BTreeMap<String, Change>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub items: Value,
    pub server_id: String,
}

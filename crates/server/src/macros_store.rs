//! Macro persistence shared by desktop and Web clients.

use ss_core::Macro;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<PathBuf, String> {
    Ok(crate::config::config_dir()
        .ok_or("无法定位配置目录")?
        .join("macros.json"))
}

pub fn load() -> BTreeMap<String, Macro> {
    load_checked().unwrap_or_default()
}

pub fn load_checked() -> Result<BTreeMap<String, Macro>, String> {
    let _guard = LOCK.lock().map_err(|_| "宏库锁不可用")?;
    crate::libraries::read_checked(&path()?)
}

pub fn save(items: &BTreeMap<String, Macro>) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "宏库锁不可用")?;
    crate::libraries::write_atomic(&path()?, items)
}

pub fn patch(changes: &crate::libraries::Changes) -> Result<BTreeMap<String, Macro>, String> {
    let _guard = LOCK.lock().map_err(|_| "宏库锁不可用")?;
    crate::libraries::patch_locked(&path()?, changes)
}

//! rust-embed 要求目标目录在编译期存在。ui-topo 尚未 npm build 时放一张占位页，
//! 保证 `cargo build/test` 不依赖前端工具链；真实构建后 dist 内是正式产物
//! （debug 模式 rust-embed 运行时读盘，产物即时生效）。

use std::fs;
use std::path::Path;

fn main() {
    let dist = Path::new("../../ui-topo/dist");
    if !dist.exists() {
        let _ = fs::create_dir_all(dist);
        let _ = fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=\"utf-8\"><title>devicerack</title>\
             <p>ui-topo 未构建：npm install --prefix ui-topo && npm run build --prefix ui-topo</p>",
        );
    }
}

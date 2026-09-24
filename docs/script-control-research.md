# 脚本暂停/继续/停止调研结论

结论先行：**停止已支持**（本地 UI 与 WS 出口均有停止按钮）；**暂停/继续技术上可行**，方案是在 QuickJS 中断处理器上阻塞脚本线程，成本为一个中等规模 PR。本文给实现者方案与边界，实现前应通读。

## 1. 现状：停止的机制（暂停要复用的地基）

每个脚本独占一条 OS 线程跑 QuickJS（`core/src/script.rs`，rquickjs future 非 `Send` 的隔离措施）。停止 = 调用方 set `script_runs` 注册表里的 `abort: Arc<AtomicBool>`，经三条通道传播：

| 通道 | 覆盖场景 | 位置 |
|---|---|---|
| interrupt handler（字节码边界） | 纯 CPU 循环 | `run_script_inner` 的 `set_interrupt_handler` |
| `sleep` 原语 50ms 分段轮询 | await 循环（采集脚本主形态） | script.rs `sleep` 闭包 |
| `expect` 的 `select!` + `await_abort` | 长 expect 等待 | script.rs `expect` 闭包 |

中断统一以 JS 异常抛出，经 `map_aborted` 归一为 `ScriptError::Aborted`。MCP 出口无停止手段（无 stop 工具，仅 300s 超时兜底）。

## 2. 暂停/继续方案

核心思路：**暂停 = 让脚本线程冻结在字节码边界，恢复后从原处继续**。不杀执行环境，不丢脚本状态。

### 2.1 状态与中断处理器改造（core）

`ScriptRun`（server 层注册表）增加 `paused: Arc<AtomicBool>` 并传入 core。interrupt handler 改为循环：

```rust
loop {
    if abort.load(Relaxed) { return true; }    // 暂停中也可停止
    if !paused.load(Relaxed) { return false; } // 运行中，放行下一条字节码
    std::thread::sleep(50ms);                  // 暂停：阻塞在本线程
}
```

暂停时脚本线程阻塞在处理器里——纯 CPU 循环与 await 循环都冻结（await 中的脚本在当前 await 完成回到字节码边界时冻结）。每脚本独占线程，阻塞不影响其它脚本与主线程；线程内存驻留与长跑脚本相同，无新增泄漏面。

### 2.2 原语暂停感知（core）

`sleep` 已有 50ms 分段循环，加一个"暂停则等待"分支即可，暂停在 sleep 内即时生效（不必等当前 sleep 走完）。`send`/`clear` 是短操作，无需感知。

### 2.3 命令面与 UI

| 层 | 改动 |
|---|---|
| Tauri 命令 | `pause_script` / `resume_script`，与 `stop_script` 同表同路 |
| WS 协议 | `protocol.rs` 加 `PauseScript` / `ResumeScript` 消息对，`ws.rs` set/clear flag |
| 前端 | 运行卡加 暂停/继续 按钮，三个 transport 出命令；`run_id` 路由已具备 |

## 3. 语义边界（实现时必须处理的点）

- **`expect` 暂停粒度与超时消耗**：`expect` 阻塞在 `spawn_blocking` 的 `grep_text`（全缓冲非破坏扫描 + Condvar 等待），暂停信号打不进去——暂停要等当前 expect 自行结束（命中或超时）才生效，且其 `timeout_ms` 按 wall-clock 消耗，长暂停后恢复可能立即超时。若要暂停即时生效，需给 `expect` 加暂停分支：取消后等恢复再以剩余时间重发（扫描非破坏，重发语义一致）；剩余时间的记账需把 `timeout_ms` 换成 deadline 传递。
- **超时 deadline**：MCP 路径的 300s 总超时同为 wall-clock，暂停期间照走。MCP 无暂停 UI，不受影响；若未来暴露需同步冻结。
- **并发槽**：暂停中的脚本继续占用 WS `script_semaphore` 槽与脚本线程。保持占用最简单且安全（防止暂停脚本时被新脚本顶掉并发额度）；如需释放则要处理恢复时重排队，不建议首版做。
- **暂停中的停止/关窗**：`abort` 检查在暂停循环内（见 2.1），停止与窗口销毁清理（owner 过滤 + set abort）天然覆盖暂停态。

## 4. 实施清单

1. core：interrupt handler 循环 + `sleep` 暂停分支 + 单测（暂停不退出、恢复继续跑、暂停中可停止）。
2. server：`ScriptRun` 加 `paused` 字段 + WS 消息对。
3. tauri-app：`pause_script` / `resume_script` 命令。
4. ui：运行卡按钮 + transport 命令面。
5. 可选后续：`expect` 暂停即时生效（deadline 化）。

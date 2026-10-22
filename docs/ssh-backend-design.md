# SSH 设备后端设计

把 SSH 远程主机接入端口体系:像打开串口一样打开一台设备的 shell 终端,占有权/多持有者/宏/脚本/日志/WS·MCP·Telnet 出口全部自动生效。UI 已先行落地(见侧栏 SSH 设备卡与管理弹窗),本文档记录后端架构。

## 架构定位

SSH 设备是**第二种非本机端口来源**,与远程 ss 设备(`device/`)平行,同属"一台设备 = 一个可寻址的端口提供方"抽象:

```
CompositeOpener (server/src/device/mod.rs)
├─ 裸名                    → core serial(本机串口)
├─ 首段命中 ssh_hosts.json → ssh::SshManager(本文档)
└─ 其余复合键              → DeviceClientManager(远程 ss 设备)
```

**core 零改动**:SSH 实例实现 `PortIo`(全双工字节通道窄 trait),manager/port_task 不感知传输介质——这是 CLAUDE.md 既定的扩展路径。

## 模块划分(crates/server/src/ssh/)

| 文件 | 职责 |
|---|---|
| `store.rs` | 注册表 `ssh_hosts.json` + 已知指纹 `ssh_known_hosts.json`(进程内锁、损坏回退、全量覆盖,与 remotes_store 同构) |
| `session.rs` | 单主机 russh 连接:TOFU 校验、三种认证(密钥/Agent/密码)、命令循环、实例任务(独占 PTY channel) |
| `port_io.rs` | `PortIo` 桥接:推→拉缓冲(Condvar) + 命令通道写,镜像 `device/port_io.rs` 的 RemotePortIo |
| `mod.rs` | 管理器门面:注册表同步、会话池、`open_blocking`、`next_instance_key`(纯函数) |

## 关键机制

**会话生命周期(懒建,与 device/ 的 eager 有意不同)**:SSH 有认证开销且无需枚举远端端口,首次 open 才建连;连接断(命令失败)→ 会话任务标 dead + 全部实例 shared 置 closed → port_task 走 Disconnect 路径 → drainer 标 disconnected 保占有权 → reopen 时 `ensure_session` 重建新连接。USB 拔插模型映射网络断连。

**同步/异步桥接**(与 DeviceClient 同构):同步侧(manager 的 spawn_blocking)经 std mpsc 发命令等回执;异步侧(命令循环)持有 russh Handle。实例任务独占 Channel——`wait()` 需 `&mut`,写/resize 经实例内命令通道在 select 之外串行执行,借用无冲突。open 失败分两级:连接级(会话报废、清池)与实例级(会话保留)。

**实例模型**:端点(定义,如 `shell`)在注册表,实例(运行时,`shell@N`)是运行产物。`next_instance_key` 取最小空闲序号(复用已关实例的号,manager 占有权快照为唯一依据)。实例行在 list 输出中由 manager 快照自然出现(已开端口),端点行由注册表桶输出。holders 数字恒为"共享该流的人数"——与串口心智一致,实例数即行数。

**Host key(TOFU)**:首连指纹记入 `ssh_known_hosts.json` 并放行;已记录且不匹配 → 拒绝连接(日志带两端指纹),直到人工删除该条目。指纹变更的确认对话框属 UI 侧后续工作,v1 语义为拒绝并留痕。

**认证**:密钥文件(`~` 展开)、SSH Agent(Windows=Pageant 管道,其余=SSH_AUTH_SOCK,逐身份尝试)、密码。凭据明文存 `ssh_hosts.json`(见安全边界)。

## 线协议新增(WS JSON,与 ui/transport.ts 对侧同步)

| ClientMsg | ServerMsg | 说明 |
|---|---|---|
| `ssh_list` | `ssh_hosts` | 注册表全量 |
| `ssh_save {hosts}` | `ssh_hosts` / `error` | 全量覆盖(先落盘后同步会话池) |
| `ssh_test {host_id}` | `ssh_test_result {ok,message}` | 直连探测(建连+认证+即拆,不进会话池) |
| `ssh_next_instance {host_id,base}` | `ssh_instance {name}` | 分配实例名;前端先问名再 open |
| `resize {port,cols,rows}` | `ok` | PTY window_change(串口端口静默成功) |

open/write/close 复用既有 `open`/`write`/`close` action——SSH 实例对 manager 就是普通端口。别名走 `set_alias` 的 ssh 分支(写注册表端点,实例行 `shell@N` 拒绝)。

## 安全边界

- 密码明文落盘(server 侧配置目录,UI 明示)。headless Linux 无系统 keyring 是不做加密的决策依据;升级 keychain 是 v2 课题。
- 凭据不进日志:tracing 只记设备 id/host/错误信息,不记密码与密钥内容。
- ss-server WS 默认无认证——能连上服务的人可用已存凭据开 shell,与现有串口面暴露程度一致,release note 需写明;服务访问口令是独立课题。
- TOFU 拒绝不带交互重置:需人工删 `ssh_known_hosts.json` 条目(v1)。

## 测试

`tests/ssh_session.rs`:russh 内置 server 起假 SSH 主机(回显 PTY),覆盖 open→write→read 回环、多实例隔离(`shell`/`shell@2` 互不串流)、认证失败快速回执(不等超时)、resize 幂等。纯函数单测:实例分配(最小空闲、跨设备隔离)、注册表线格式(camelCase 契约)、端点校验。全部 193 个 workspace 测试绿,clippy 0 warning。

注意:`#[tokio::test]`(current_thread)里调 PortIo 阻塞方法必须 `spawn_blocking`——write 内 `recv_timeout` 会冻结唯一 runtime 线程,命令循环停摆造成回执超时假错。

## 边界与后续

- **keepalive**:russh `inactivity_timeout=None`,空闲连接依赖 TCP;后续可加协议层 keepalive(对齐 device/ 的 10s/20s 心跳)。
- **exec/serial 端点**:`SshEndpointRecord.type` 已留判别空间;落地时 open_pty_shell 按 type 分支。
- **多级级联**:SSH 端口随 list 透传(经 `passthrough_port_key` 谓词),理论免费;未专门验证。
- **认证失败重输闭环**(弹窗更新已存密码)、**TOFU 确认 UI**:与前端联调时补。
- **UI 对接**:前端预览的 localStorage 数据层换成上述 WS action(`loadSshHosts/persistSshHosts/connectSsh/testSsh` 四个替换点已预埋)。

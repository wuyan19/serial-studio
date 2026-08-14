import type { Macro, PortInfo, Script, SerialConfig } from "./types";
import { Channel } from "@tauri-apps/api/core";
import { getMode, getRemoteFromUrl, loadConn, tauriInvoke } from "./lib";

/** acquire 结果：区分首开与附加（附加时 config 为端口实际配置，请求的配置被忽略）。 */
export interface AcquiredResult {
  port: string;
  /** true = 本次真正打开（首开）；false = 附加到已开端口 */
  opened: boolean;
  /** 端口当前实际生效的配置 */
  config: SerialConfig;
  /** 当前持有者数（含自己） */
  holders: number;
}

/** 数据面传输抽象：屏蔽 IPC/WS 协议差异。组件只懂领域（port/bytes/macro）。 */
export interface Transport {
  /** 触发一次端口列表拉取；数据经 onPorts 回调推送（推送模型，避免请求-响应竞态丢回复）。 */
  list(): Promise<void>;
  /** 端口列表更新回调（list 响应或服务端推送均经此）。后到覆盖先到——最新数据胜出。 */
  onPorts(cb: (ports: PortInfo[]) => void): () => void;
  open(port: string, config: SerialConfig): Promise<AcquiredResult>;
  /** 设置端口别名（空串 = 清除）。写 ports.json，跟随端口所在机器。
   *  open 命令不碰磁盘——rename / 首开带别名都走此入口。 */
  setAlias(port: string, alias: string): Promise<void>;
  close(port: string): Promise<void>;
  /** 强制关闭:踢掉远程客户端(WS/MCP)。仅本地可用。 */
  forceClose(port: string): Promise<void>;
  write(port: string, data: string): Promise<void>;
  runMacro(name: string, port: string, macro: Macro, runId: string): Promise<void>;
  runScript(name: string, port: string, script: Script, args: Record<string, string>, runId: string): Promise<void>;
  /** 停止运行中的脚本(按 runId)。set abort flag,脚本经 sleep 轮询秒级退出。 */
  stopScript(runId: string): Promise<void>;
  /** 停止运行中的宏(按 runId)。复用 script_runs 表,set abort flag → 宏经 Delay/Expect 退出。 */
  stopMacro(runId: string): Promise<void>;
  onData(cb: (port: string, data: Uint8Array) => void): () => void;
  onPortOpened(cb: (port: string) => void): () => void;
  onPortClosed(cb: (port: string) => void): () => void;
  /** 设备意外断开(USB 拔出):前端保留 tab 可重连(区别于 onPortClosed 的删 tab)。 */
  onPortDisconnected(cb: (port: string) => void): () => void;
  /** 持有者数量变化（有人加入/退出，端口未关）。 */
  onHolders(cb: (port: string, holders: number) => void): () => void;
  /** 端口元数据（别名等）变更——重新拉取端口列表（别的客户端改了别名时及时同步）。 */
  onMetaChanged(cb: () => void): () => void;
  /** 脚本库(scripts.json)变更——重新 load_scripts(MCP/Tauri 写入后及时同步,不必重启)。 */
  onScriptsChanged(cb: () => void): () => void;
  onError(cb: (msg: string) => void): () => void;
  onMacroResult(cb: (runId: string | undefined, name: string, success: boolean, msg: string) => void): () => void;
  onScriptResult(cb: (runId: string | undefined, name: string, success: boolean, msg: string) => void): () => void;
  /** 脚本 log() 实时输出。前端按 runId 路由到对应运行实例的日志区(MCP 触发的 run_id="" 由调用方过滤)。 */
  onScriptLog(cb: (runId: string, message: string) => void): () => void;
  onConnectedChange(cb: (connected: boolean) => void): () => void;
  /** 服务版本号 + 是否启用远程脚本执行（关于页 + 脚本 UI 显隐）。本地恒 enableScripting=true。 */
  getVersion(): Promise<{ version: string; enableScripting: boolean }>;
  /** 脚本编写 SKILL 全文(嵌入二进制;「脚本指南」对话框展示 / 复制给外部 Agent)。 */
  getScriptSkill(): Promise<string>;
  dispose(): void;
}

/** 解 Binary 数据帧：`[port_len:u8][port UTF-8][data]`。data 为零拷贝视图，直接喂 xterm。 */
function decodeDataFrame(buf: ArrayBuffer): { port: string; data: Uint8Array } {
  const bytes = new Uint8Array(buf);
  const portLen = bytes[0];
  const port = new TextDecoder().decode(bytes.subarray(1, 1 + portLen));
  const data = bytes.subarray(1 + portLen);
  return { port, data };
}

/** 心跳 / 重连参数。 */
const PING_INTERVAL = 10_000;  // 应用层 ping 周期（浏览器 WS API 不暴露协议层 ping，只能自备）
const PONG_TIMEOUT = 20_000;   // 无任何入站帧超过此时长 → 认为连接已死，主动 close 触发重连
const RECONNECT_BASE = 1_000;  // 退避基数 1s（服务端秒级重启时第一次重试就赶上）
const RECONNECT_CAP = 30_000;  // 退避上限
const STABLE_RESET = 10_000;   // open 后稳定此时长 → 退避归零（防服务端抖动引发快速重连风暴）

/** 在途请求的 resolve/reject 对：断连 / dispose 时统一 reject，防 Promise 永悬。 */
interface Controller<T> { resolve: (v: T) => void; reject: (e: Error) => void }

// ===== 事件目录（单一数据源） =====

/** Transport 事件回调签名目录。新增事件：此处加签名 + TransportEvents 加 on* 方法，
 *  两个实现（Local/Remote）自动获得——此前 handlers 表与 on* 方法族在两实现各抄一份，
 *  每加一个事件要改 4 处。 */
export interface TransportEventsMap {
  data: (port: string, data: Uint8Array) => void;
  ports: (ports: PortInfo[]) => void;
  opened: (port: string) => void;
  closed: (port: string) => void;
  disconnected: (port: string) => void;
  holders: (port: string, holders: number) => void;
  metaChanged: () => void;
  scriptsChanged: () => void;
  error: (msg: string) => void;
  macroResult: (runId: string | undefined, name: string, success: boolean, msg: string) => void;
  scriptResult: (runId: string | undefined, name: string, success: boolean, msg: string) => void;
  scriptLog: (runId: string, message: string) => void;
  connected: (connected: boolean) => void;
}

type HandlerSets = { [K in keyof TransportEventsMap]: Set<TransportEventsMap[K]> };

/** on* 方法族 + 订阅集合的共用底座（Local/Remote 继承）。 */
abstract class TransportEventBase {
  protected handlers: HandlerSets = {
    data: new Set(),
    ports: new Set(),
    opened: new Set(),
    closed: new Set(),
    disconnected: new Set(),
    holders: new Set(),
    metaChanged: new Set(),
    scriptsChanged: new Set(),
    error: new Set(),
    macroResult: new Set(),
    scriptResult: new Set(),
    scriptLog: new Set(),
    connected: new Set(),
  };

  onData(cb: TransportEventsMap["data"]) {
    this.handlers.data.add(cb);
    return () => { this.handlers.data.delete(cb); };
  }
  onPorts(cb: TransportEventsMap["ports"]) {
    this.handlers.ports.add(cb);
    return () => { this.handlers.ports.delete(cb); };
  }
  onPortOpened(cb: TransportEventsMap["opened"]) {
    this.handlers.opened.add(cb);
    return () => { this.handlers.opened.delete(cb); };
  }
  onPortClosed(cb: TransportEventsMap["closed"]) {
    this.handlers.closed.add(cb);
    return () => { this.handlers.closed.delete(cb); };
  }
  onPortDisconnected(cb: TransportEventsMap["disconnected"]) {
    this.handlers.disconnected.add(cb);
    return () => { this.handlers.disconnected.delete(cb); };
  }
  onHolders(cb: TransportEventsMap["holders"]) {
    this.handlers.holders.add(cb);
    return () => { this.handlers.holders.delete(cb); };
  }
  onError(cb: TransportEventsMap["error"]) {
    this.handlers.error.add(cb);
    return () => { this.handlers.error.delete(cb); };
  }
  onMetaChanged(cb: TransportEventsMap["metaChanged"]) {
    this.handlers.metaChanged.add(cb);
    return () => { this.handlers.metaChanged.delete(cb); };
  }
  onScriptsChanged(cb: TransportEventsMap["scriptsChanged"]) {
    this.handlers.scriptsChanged.add(cb);
    return () => { this.handlers.scriptsChanged.delete(cb); };
  }
  onMacroResult(cb: TransportEventsMap["macroResult"]) {
    this.handlers.macroResult.add(cb);
    return () => { this.handlers.macroResult.delete(cb); };
  }
  onScriptResult(cb: TransportEventsMap["scriptResult"]) {
    this.handlers.scriptResult.add(cb);
    return () => { this.handlers.scriptResult.delete(cb); };
  }
  onScriptLog(cb: TransportEventsMap["scriptLog"]) {
    this.handlers.scriptLog.add(cb);
    return () => { this.handlers.scriptLog.delete(cb); };
  }
  onConnectedChange(cb: TransportEventsMap["connected"]) {
    this.handlers.connected.add(cb);
    return () => { this.handlers.connected.delete(cb); };
  }
}

/** WS 实现（远程/Web 模式）。封装 WS 协议细节（控制 JSON + 数据 Binary 帧）+ 自愈重连 + 心跳。
 *  服务端重启 / 强杀 / 断电后：指数退避自动重连 → 重连成功重新 list + (由 App 层) 重放开过的端口。 */
export class RemoteTransport extends TransportEventBase implements Transport {
  private host: string;
  private portNum: number;
  private ws!: WebSocket;
  /** open 回复按 port 路由：并发 open（重连后重放多端口）各取各的回复，不串台。
   *  旧实现是单槽，并发 open 时后写覆盖前写 → 只末个 caller 拿到结果、其余 Promise 永悬。 */
  private openResolvers = new Map<string, Controller<AcquiredResult>>();
  private versionController: Controller<{ version: string; enableScripting: boolean }> | null = null;
  private scriptSkillController: Controller<string> | null = null;
  /** WS 就绪 promise：send() 据此等待 open，避免 CONNECTING 态 send 抛 InvalidStateError。每次重连重建。 */
  private openPromise!: Promise<void>;
  private openResolve: () => void = () => {};
  /** 主动 dispose 置 true → onclose 不再触发重连。 */
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.portNum = port;
    this.connect();
  }

  /** 建立 WS + 绑事件。构造与每次重连都走这里；openPromise 在此重建供 send() 等待新一轮 open。 */
  private connect() {
    if (this.closed) return; // dispose 后漏过 clearTimers 的退避回调不再新建连接
    const ws = new WebSocket(`ws://${this.host}:${this.portNum}/ws`);
    ws.binaryType = "arraybuffer"; // 数据帧 Binary，控制帧 Text
    this.ws = ws;
    this.openPromise = new Promise<void>((resolve) => { this.openResolve = resolve; });
    this.wire(ws);
  }

  /** 绑事件。每个 handler 用捕获的 socket 做 stale 守卫——旧 WS 关闭时不应触发新连接的重连/状态。 */
  private wire(ws: WebSocket) {
    ws.onopen = () => {
      if (this.ws !== ws) return; // stale：这是已废弃的旧连接
      this.openResolve(); // send() 解除等待
      this.reconnectAttempts = 0;
      this.handlers.connected.forEach((cb) => cb(true));
      this.startHeartbeat(ws);
      // 稳定连接后归零退避：服务端抖动（连上即断）不会被无限快速重连
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        if (this.ws === ws) this.reconnectAttempts = 0;
      }, STABLE_RESET);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale
      this.rejectPending(new Error("连接已断开"));
      this.clearTimers();
      this.handlers.connected.forEach((cb) => cb(false));
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // 只日志：onclose 必在 onerror 之后触发且只一次，这里再调度重连会双触发
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      // 任意入站帧 = TCP 双向通，等价收到 pong → 清 pong 超时（空闲时才靠显式 ping 探活）
      this.clearPongTimer();
      // 数据帧 Binary（[port_len][port][data]），控制帧 Text(JSON)
      if (typeof e.data !== "string") {
        const { port, data } = decodeDataFrame(e.data);
        this.handlers.data.forEach((cb) => cb(port, data));
        return;
      }
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "ports":
          // 推送模型：每个 ports 消息都推给所有订阅者（后到覆盖先到，避免 resolver 丢回复）
          this.handlers.ports.forEach((cb) => cb(msg.ports as PortInfo[]));
          break;
        case "opened":
          this.handlers.opened.forEach((cb) => cb(msg.port));
          break;
        case "closed":
          this.handlers.closed.forEach((cb) => cb(msg.port));
          break;
        case "disconnected":
          this.handlers.disconnected.forEach((cb) => cb(msg.port));
          break;
        case "acquired": {
          // 按 port 路由：并发 open（重连后重放）各取各的回复，不再串台
          const c = this.openResolvers.get(msg.port);
          if (c) {
            c.resolve({ port: msg.port, opened: msg.opened, config: msg.config, holders: msg.holders });
            this.openResolvers.delete(msg.port);
          }
          break;
        }
        case "holders":
          this.handlers.holders.forEach((cb) => cb(msg.port, msg.holders));
          break;
        case "meta_changed":
          this.handlers.metaChanged.forEach((cb) => cb());
          break;
        case "scripts_changed":
          this.handlers.scriptsChanged.forEach((cb) => cb());
          break;
        case "error":
          this.handlers.error.forEach((cb) => cb(msg.message));
          break;
        case "macro_result":
          this.handlers.macroResult.forEach((cb) =>
            cb(msg.run_id, msg.name, msg.success, msg.message)
          );
          break;
        case "version":
          if (this.versionController) {
            this.versionController.resolve({ version: msg.version, enableScripting: !!msg.enable_scripting });
            this.versionController = null;
          }
          break;
        case "script_skill":
          if (this.scriptSkillController) {
            this.scriptSkillController.resolve(msg.text as string);
            this.scriptSkillController = null;
          }
          break;
        case "script_result":
          this.handlers.scriptResult.forEach((cb) => cb(msg.run_id, msg.name, msg.success, msg.message));
          break;
        case "script_log":
          this.handlers.scriptLog.forEach((cb) => cb(msg.run_id, msg.message));
          break;
        case "pong":
          break; // 已由"任意入站帧重置 pong 超时"兜底，显式分支仅作协议标记
      }
    };
  }

  /** 退避重连：2^n × ±20% jitter，cap 30s，无限重试。终止方式：删设备 / 折叠设备卡 → effect teardown → dispose。 */
  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const base = Math.min(RECONNECT_BASE * 2 ** this.reconnectAttempts, RECONNECT_CAP);
    const jitter = base * (0.8 + Math.random() * 0.4); // ±20% 防多设备同步重连雷暴
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, jitter);
  }

  /** 应用层心跳：浏览器 WS 不能发协议层 ping，只能自备 ping/pong 探活（应对服务端强杀/断电不发 Close frame）。 */
  private startHeartbeat(ws: WebSocket) {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      // 非 OPEN 跳过本轮：重连窗口里 send() 会 await openPromise 挂住，等发出去时 pong 早超时了
      if (this.ws !== ws || this.ws.readyState !== WebSocket.OPEN) return;
      // 排一个 pong 超时：下一轮 ping 前若无任何入站帧（pong 或数据）→ 认为连接已死
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        if (this.ws === ws) {
          try { this.ws.close(); } catch { /* 已关闭 */ }
          // close() → onclose → scheduleReconnect；此处不再直接调度，否则双触发
        }
      }, PONG_TIMEOUT);
      this.send(JSON.stringify({ action: "ping" }));
    }, PING_INTERVAL);
  }

  private clearPongTimer() {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  /** 清所有定时器（心跳 / 退避 / 稳定检测）。onclose 与 dispose 共用。 */
  private clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    this.clearPongTimer();
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
  }

  /** reject 所有在途请求（断连 / dispose），防 getVersion/getScriptSkill/open 的 Promise 永悬。 */
  private rejectPending(err: Error) {
    this.openResolvers.forEach((c) => c.reject(err));
    this.openResolvers.clear();
    this.versionController?.reject(err);
    this.versionController = null;
    this.scriptSkillController?.reject(err);
    this.scriptSkillController = null;
  }

  /** 统一发送出口：等 WS open 后再 send，消除裸 ws.send 在 CONNECTING 态抛异常的隐患。重连期间自然等待。 */
  private async send(payload: string) {
    if (this.closed) throw new Error("transport disposed");
    await this.openPromise;
    this.ws.send(payload);
  }

  async list() {
    await this.send(JSON.stringify({ action: "list" }));
  }
  onPorts(cb: (ports: PortInfo[]) => void) {
    this.handlers.ports.add(cb);
    return () => { this.handlers.ports.delete(cb); };
  }
  async open(port: string, config: SerialConfig) {
    // 先挂 controller 再发：确保 "acquired" 回复到达时 controller 已就位（不靠微任务时序）。
    const result = new Promise<AcquiredResult>((resolve, reject) => {
      this.openResolvers.set(port, { resolve, reject });
    });
    await this.send(JSON.stringify({ action: "open", port, config }));
    return result;
  }
  async close(port: string) {
    await this.send(JSON.stringify({ action: "close", port }));
  }
  async setAlias(port: string, alias: string) {
    await this.send(JSON.stringify({ action: "set_alias", port, alias }));
  }
  async forceClose(_port: string) {
    // 强制关闭是本地特权，远程不可用（防止远程误操作踢掉他人）
    throw new Error("强制关闭仅本地可用");
  }
  async write(port: string, data: string) {
    await this.send(JSON.stringify({ action: "write", port, data, encoding: "text" }));
  }
  async runMacro(name: string, port: string, macro: Macro, runId: string) {
    await this.send(JSON.stringify({ action: "run_macro", name, port, macro, run_id: runId }));
  }
  async runScript(name: string, port: string, script: Script, args: Record<string, string>, runId: string) {
    await this.send(JSON.stringify({ action: "run_script", name, port, script, args, run_id: runId }));
  }
  async stopScript(runId: string) {
    await this.send(JSON.stringify({ action: "stop_script", run_id: runId }));
  }
  async stopMacro(runId: string) {
    await this.send(JSON.stringify({ action: "stop_macro", run_id: runId }));
  }
  async getVersion() {
    const result = new Promise<{ version: string; enableScripting: boolean }>((resolve, reject) => {
      this.versionController = { resolve, reject };
    });
    await this.send(JSON.stringify({ action: "version" }));
    return result;
  }
  async getScriptSkill() {
    const result = new Promise<string>((resolve, reject) => {
      this.scriptSkillController = { resolve, reject };
    });
    await this.send(JSON.stringify({ action: "get_script_skill" }));
    return result;
  }

  override onConnectedChange(cb: (connected: boolean) => void) {
    const un = super.onConnectedChange(cb);
    // 订阅即回报当前状态：晚订阅者（重连期间挂载的组件）能立即拿到“已连接”
    if (this.ws.readyState === WebSocket.OPEN) cb(true);
    return un;
  }

  dispose() {
    // closed 守卫阻止随后 onclose 触发的重连；清所有定时器防旧 transport 在被 effect 丢弃后仍后台重连
    // （否则内存泄漏 + 旧 session 占着端口不释放，服务端 release_all 只在 WS 真断时触发）。
    this.closed = true;
    this.clearTimers();
    this.rejectPending(new Error("transport disposed"));
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

/** IPC 实现（本地模式）：Tauri invoke 命令 + event 监听。绕过 WS，进程内直连。 */
export class LocalTransport extends TransportEventBase implements Transport {
  private unlisten: Array<() => void> = [];
  /** per-port 字节流通道。Channel 无需 unlisten，关闭走 close_port_stream 摘除。 */
  private streamChannels = new Map<string, Channel<ArrayBuffer>>();

  constructor() {
    super();
    this.setupEvents();
  }

  private setupEvents() {
    const setup = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      // 数据走 per-port Channel 直传（open 时建），不再 listen("serial-data")。
      this.unlisten.push(
        await listen<string>("serial-opened", (e) =>
          this.handlers.opened.forEach((cb) => cb(e.payload)))
      );
      this.unlisten.push(
        await listen<string>("serial-closed", (e) =>
          this.handlers.closed.forEach((cb) => cb(e.payload)))
      );
      this.unlisten.push(
        await listen<string>("serial-disconnected", (e) =>
          this.handlers.disconnected.forEach((cb) => cb(e.payload)))
      );
      this.unlisten.push(
        await listen<{ port: string; holders: number }>("serial-holders", (e) =>
          this.handlers.holders.forEach((cb) => cb(e.payload.port, e.payload.holders)))
      );
      this.unlisten.push(
        await listen<{ message: string }>("serial-error", (e) =>
          this.handlers.error.forEach((cb) => cb(e.payload.message)))
      );
      this.unlisten.push(
        await listen<{ run_id?: string; name: string; success: boolean; message: string }>(
          "macro-result",
          (e) =>
            this.handlers.macroResult.forEach((cb) =>
              cb(e.payload.run_id, e.payload.name, e.payload.success, e.payload.message)
            )
        )
      );
      this.unlisten.push(
        await listen<{ run_id?: string; name: string; success: boolean; message: string }>(
          "script-result",
          (e) =>
            this.handlers.scriptResult.forEach((cb) =>
              cb(e.payload.run_id, e.payload.name, e.payload.success, e.payload.message)
            )
        )
      );
      this.unlisten.push(
        await listen<{ run_id: string; message: string }>("script-log", (e) =>
          this.handlers.scriptLog.forEach((cb) => cb(e.payload.run_id, e.payload.message))
        )
      );
      this.unlisten.push(
        await listen("ports-meta-changed", () =>
          this.handlers.metaChanged.forEach((cb) => cb()))
      );
      this.unlisten.push(
        await listen("scripts-changed", () =>
          this.handlers.scriptsChanged.forEach((cb) => cb()))
      );
    };
    setup().catch((e) => console.error("本地事件订阅失败", e));
  }

  async list() {
    const ports = await tauriInvoke<PortInfo[]>("list_ports");
    this.handlers.ports.forEach((cb) => cb(ports));
  }
  onPorts(cb: (ports: PortInfo[]) => void) {
    this.handlers.ports.add(cb);
    return () => { this.handlers.ports.delete(cb); };
  }
  async open(port: string, config: SerialConfig) {
    const chan = new Channel<ArrayBuffer>();
    // ≥1024B fetch 二进制 / <1024B eval new Uint8Array([..]).buffer，两侧都产出 ArrayBuffer。
    // new Uint8Array(buf) 是零拷贝视图，xterm.write 直接消费。
    chan.onmessage = (buf: ArrayBuffer) => {
      const bytes = new Uint8Array(buf);
      this.handlers.data.forEach((cb) => cb(port, bytes));
    };
    this.streamChannels.set(port, chan);
    // 后端返回 AcquireResult 枚举：{kind:"opened",config} | {kind:"attached",config,holders}
    const r = await tauriInvoke<{ kind: string; config: SerialConfig; holders?: number }>(
      "open_port_stream",
      { port, config, onEvent: chan }
    );
    if (r.kind === "opened") {
      return { port, opened: true, config: r.config, holders: r.holders ?? 1 };
    }
    return { port, opened: false, config: r.config, holders: r.holders ?? 1 };
  }
  async close(port: string) {
    try {
      await tauriInvoke("close_port_stream", { port });
    } finally {
      this.streamChannels.delete(port);
    }
  }
  async setAlias(port: string, alias: string) {
    await tauriInvoke("set_port_alias", { port, alias });
  }
  async forceClose(port: string) {
    await tauriInvoke("force_close_port", { port });
    this.streamChannels.delete(port); // 后端 PortClosed 已摘，前端同步清引用
  }
  async write(port: string, data: string) {
    await tauriInvoke("write_port", { port, data });
  }
  async runMacro(name: string, port: string, macro: Macro, runId: string) {
    await tauriInvoke("run_macro", { name, port, macro, runId });
  }
  async runScript(name: string, port: string, script: Script, args: Record<string, string>, runId: string) {
    await tauriInvoke("run_script", { name, port, script, args, runId });
  }
  async stopScript(runId: string) {
    await tauriInvoke("stop_script", { runId });
  }
  async stopMacro(runId: string) {
    await tauriInvoke("stop_macro", { runId });
  }
  async getVersion() {
    const { getVersion } = await import("@tauri-apps/api/app");
    const version = await getVersion();
    return { version, enableScripting: true }; // 本地主权:脚本恒可用
  }
  async getScriptSkill() {
    return tauriInvoke<string>("get_script_skill");
  }

  override onConnectedChange(cb: (connected: boolean) => void) {
    const un = super.onConnectedChange(cb);
    cb(true); // IPC 永远已连接
    return un;
  }

  dispose() {
    this.unlisten.forEach((fn) => fn());
    // 不调 close_port_stream：保持“端口随窗口 Destroyed 释放”的现有语义。
    // 仅清前端引用；后端通道由 Destroyed 的 remove_window 兜底。
    this.streamChannels.clear();
  }
}

/** 按运行形态创建 Transport：本地 → IPC；远程窗口/Web → WS。形态判定唯一入口 getMode()。 */
export function createTransport(): Transport {
  if (getMode() === "local") return new LocalTransport();
  const { host, port } = getRemoteFromUrl() ?? loadConn();
  return new RemoteTransport(host, port);
}

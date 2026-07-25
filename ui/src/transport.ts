import type { Macro, PortInfo, SerialConfig } from "./types";
import { Channel } from "@tauri-apps/api/core";
import { getRemoteFromUrl, isTauri, loadConn, tauriInvoke } from "./lib";

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
  list(): Promise<PortInfo[]>;
  open(port: string, config: SerialConfig): Promise<AcquiredResult>;
  close(port: string): Promise<void>;
  /** 强制关闭：无视持有者直接拆毁。仅本地有意义，远程会 reject。 */
  forceClose(port: string): Promise<void>;
  write(port: string, data: string): Promise<void>;
  runMacro(name: string, port: string, macro: Macro): Promise<void>;
  onData(cb: (port: string, data: Uint8Array) => void): () => void;
  onPortOpened(cb: (port: string) => void): () => void;
  onPortClosed(cb: (port: string) => void): () => void;
  /** 持有者数量变化（有人加入/退出，端口未关）。 */
  onHolders(cb: (port: string, holders: number) => void): () => void;
  onError(cb: (msg: string) => void): () => void;
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void): () => void;
  onConnectedChange(cb: (connected: boolean) => void): () => void;
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

/** WS 实现（远程/Web 模式）。封装 WS 协议细节（控制 JSON + 数据 Binary 帧）。 */
export class RemoteTransport implements Transport {
  private ws: WebSocket;
  private listResolver: ((p: PortInfo[]) => void) | null = null;
  private openResolver: ((r: AcquiredResult) => void) | null = null;
  private handlers = {
    data: new Set<(port: string, data: Uint8Array) => void>(),
    opened: new Set<(port: string) => void>(),
    closed: new Set<(port: string) => void>(),
    holders: new Set<(port: string, holders: number) => void>(),
    error: new Set<(msg: string) => void>(),
    macroResult: new Set<(name: string, success: boolean, msg: string) => void>(),
    connected: new Set<(c: boolean) => void>(),
  };

  constructor(host: string, port: number) {
    this.ws = new WebSocket(`ws://${host}:${port}/ws`);
    this.ws.binaryType = "arraybuffer"; // 数据帧 Binary，控制帧 Text
    this.ws.onopen = () => this.handlers.connected.forEach((cb) => cb(true));
    this.ws.onclose = () => this.handlers.connected.forEach((cb) => cb(false));
    this.ws.onmessage = (e) => {
      // 数据帧 Binary（[port_len][port][data]），控制帧 Text(JSON)
      if (typeof e.data !== "string") {
        const { port, data } = decodeDataFrame(e.data);
        this.handlers.data.forEach((cb) => cb(port, data));
        return;
      }
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "ports":
          if (this.listResolver) {
            this.listResolver(msg.ports as PortInfo[]);
            this.listResolver = null;
          }
          break;
        case "opened":
          this.handlers.opened.forEach((cb) => cb(msg.port));
          break;
        case "closed":
          this.handlers.closed.forEach((cb) => cb(msg.port));
          break;
        case "acquired":
          if (this.openResolver) {
            this.openResolver({
              port: msg.port,
              opened: msg.opened,
              config: msg.config,
              holders: msg.holders,
            });
            this.openResolver = null;
          }
          break;
        case "holders":
          this.handlers.holders.forEach((cb) => cb(msg.port, msg.holders));
          break;
        case "error":
          this.handlers.error.forEach((cb) => cb(msg.message));
          break;
        case "macro_result":
          this.handlers.macroResult.forEach((cb) =>
            cb(msg.name, msg.success, msg.message)
          );
          break;
      }
    };
  }

  async list() {
    this.ws.send(JSON.stringify({ action: "list" }));
    return new Promise<PortInfo[]>((resolve) => {
      this.listResolver = resolve;
    });
  }
  async open(port: string, config: SerialConfig) {
    this.ws.send(JSON.stringify({ action: "open", port, config }));
    return new Promise<AcquiredResult>((resolve) => {
      this.openResolver = resolve;
    });
  }
  async close(port: string) {
    this.ws.send(JSON.stringify({ action: "close", port }));
  }
  async forceClose(_port: string) {
    // 强制关闭是本地特权，远程不可用（防止远程误操作踢掉他人）
    throw new Error("强制关闭仅本地可用");
  }
  async write(port: string, data: string) {
    this.ws.send(JSON.stringify({ action: "write", port, data, encoding: "text" }));
  }
  async runMacro(name: string, port: string, macro: Macro) {
    this.ws.send(JSON.stringify({ action: "run_macro", name, port, macro }));
  }

  onData(cb: (port: string, data: Uint8Array) => void) {
    this.handlers.data.add(cb);
    return () => { this.handlers.data.delete(cb); };
  }
  onPortOpened(cb: (port: string) => void) {
    this.handlers.opened.add(cb);
    return () => { this.handlers.opened.delete(cb); };
  }
  onPortClosed(cb: (port: string) => void) {
    this.handlers.closed.add(cb);
    return () => { this.handlers.closed.delete(cb); };
  }
  onHolders(cb: (port: string, holders: number) => void) {
    this.handlers.holders.add(cb);
    return () => { this.handlers.holders.delete(cb); };
  }
  onError(cb: (msg: string) => void) {
    this.handlers.error.add(cb);
    return () => { this.handlers.error.delete(cb); };
  }
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void) {
    this.handlers.macroResult.add(cb);
    return () => { this.handlers.macroResult.delete(cb); };
  }
  onConnectedChange(cb: (connected: boolean) => void) {
    this.handlers.connected.add(cb);
    if (this.ws.readyState === WebSocket.OPEN) cb(true);
    return () => { this.handlers.connected.delete(cb); };
  }

  dispose() {
    this.ws.close();
  }
}

/** IPC 实现（本地模式）：Tauri invoke 命令 + event 监听。绕过 WS，进程内直连。 */
export class LocalTransport implements Transport {
  private unlisten: Array<() => void> = [];
  /** per-port 字节流通道。Channel 无需 unlisten，关闭走 close_port_stream 摘除。 */
  private streamChannels = new Map<string, Channel<ArrayBuffer>>();
  private handlers = {
    data: new Set<(port: string, data: Uint8Array) => void>(),
    opened: new Set<(port: string) => void>(),
    closed: new Set<(port: string) => void>(),
    holders: new Set<(port: string, holders: number) => void>(),
    error: new Set<(msg: string) => void>(),
    macroResult: new Set<(name: string, success: boolean, msg: string) => void>(),
    connected: new Set<(c: boolean) => void>(),
  };

  constructor() {
    this.handlers.connected.forEach((cb) => cb(true));
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
        await listen<{ port: string; holders: number }>("serial-holders", (e) =>
          this.handlers.holders.forEach((cb) => cb(e.payload.port, e.payload.holders)))
      );
      this.unlisten.push(
        await listen<{ message: string }>("serial-error", (e) =>
          this.handlers.error.forEach((cb) => cb(e.payload.message)))
      );
      this.unlisten.push(
        await listen<{ name: string; success: boolean; message: string }>(
          "macro-result",
          (e) =>
            this.handlers.macroResult.forEach((cb) =>
              cb(e.payload.name, e.payload.success, e.payload.message)
            )
        )
      );
    };
    setup().catch((e) => console.error("本地事件订阅失败", e));
  }

  async list() {
    return tauriInvoke<PortInfo[]>("list_ports");
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
      return { port, opened: true, config: r.config, holders: 1 };
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
  async forceClose(port: string) {
    await tauriInvoke("force_close_port", { port });
    this.streamChannels.delete(port); // 后端 PortClosed 已摘，前端同步清引用
  }
  async write(port: string, data: string) {
    await tauriInvoke("write_port", { port, data });
  }
  async runMacro(name: string, port: string, macro: Macro) {
    await tauriInvoke("run_macro", { name, port, macro });
  }

  onData(cb: (port: string, data: Uint8Array) => void) {
    this.handlers.data.add(cb);
    return () => { this.handlers.data.delete(cb); };
  }
  onPortOpened(cb: (port: string) => void) {
    this.handlers.opened.add(cb);
    return () => { this.handlers.opened.delete(cb); };
  }
  onPortClosed(cb: (port: string) => void) {
    this.handlers.closed.add(cb);
    return () => { this.handlers.closed.delete(cb); };
  }
  onHolders(cb: (port: string, holders: number) => void) {
    this.handlers.holders.add(cb);
    return () => { this.handlers.holders.delete(cb); };
  }
  onError(cb: (msg: string) => void) {
    this.handlers.error.add(cb);
    return () => { this.handlers.error.delete(cb); };
  }
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void) {
    this.handlers.macroResult.add(cb);
    return () => { this.handlers.macroResult.delete(cb); };
  }
  onConnectedChange(cb: (connected: boolean) => void) {
    this.handlers.connected.add(cb);
    cb(true); // IPC 永远已连接
    return () => { this.handlers.connected.delete(cb); };
  }

  dispose() {
    this.unlisten.forEach((fn) => fn());
    // 不调 close_port_stream：保持“端口随窗口 Destroyed 释放”的现有语义。
    // 仅清前端引用；后端通道由 Destroyed 的 remove_window 兜底。
    this.streamChannels.clear();
  }
}

/** 按模式创建 Transport：本地 → IPC；远程/Web → WS */
export function createTransport(): Transport {
  const remote = getRemoteFromUrl();
  if (isTauri() && !remote) return new LocalTransport();
  const { host, port } = remote ? remote : loadConn();
  return new RemoteTransport(host, port);
}

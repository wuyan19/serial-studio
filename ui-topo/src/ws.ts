/** WS 客户端（抄 serial-studio transport.ts 的 RemoteTransport 子集，同源同协议）。
 *
 * 数据面：Binary 帧 `[port_len:u8][port UTF-8][data]`（server→client）；写走 JSON
 * write action。控制面：ServerMsg 文本帧（ports/opened/closed/acquired/holders/
 * meta_changed/devices/ssh_hosts/ssh_test_result/error/version/pong）。
 * 应用层 ping 探活（10s 间隔 + pong 超时）+ 指数退避重连——应对服务端强杀不发 Close。
 */

import type { PortView } from "./api";
import type { SshOpenError, SshHost as SshHostT } from "./types";

/** Open.config 线格式要求完整 SerialConfig（baud_rate 无默认值，缺字段整条
 * 消息反序列化被拒——"SSH 打不开且无反馈"的根因）。SSH 端点服务端忽略其
 * 内容，但必须带全字段。 */
const FULL_DEFAULT_CONFIG = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "lf",
};

function decodeDataFrame(buf: ArrayBuffer): { port: string; data: Uint8Array } {
  const bytes = new Uint8Array(buf);
  const len = bytes[0];
  const port = new TextDecoder().decode(bytes.subarray(1, 1 + len));
  return { port, data: bytes.subarray(1 + len) };
}

const PING_INTERVAL = 10_000;
const PONG_TIMEOUT = 5_000;
const RECONNECT_BASE = 500;
const RECONNECT_CAP = 15_000;

type Handlers = {
  connected: ((on: boolean) => void)[];
  data: ((port: string, data: Uint8Array) => void)[];
  ports: ((ports: PortView[]) => void)[];
  opened: ((port: string) => void)[];
  closed: ((port: string) => void)[];
  disconnected: ((port: string) => void)[];
  holders: ((port: string, holders: number) => void)[];
  metaChanged: (() => void)[];
  devices: ((devices: unknown[]) => void)[];
  error: ((message: string) => void)[];
  sshHosts: ((hosts: SshHostT[]) => void)[];
  sshTestResult: ((hostId: string, ok: boolean, message: string) => void)[];
};

export interface OpenResult {
  port: string;
  opened: boolean;
  config: Record<string, unknown>;
  holders: number;
}

export class Ws {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private openWaiters: (() => void)[] = [];
  private openResolvers = new Map<string, { resolve: (r: OpenResult) => void; reject: (e: Error & { ssh?: SshOpenError }) => void }>();
  /** 同端口在途 open 的单飞表（key=端口，value=共享 Promise）。 */
  private openInflight = new Map<string, Promise<OpenResult>>();
  private versionWaiters: ((v: { version: string; enableScripting: boolean; instanceId?: string }) => void)[] = [];
  private h: Handlers = {
    connected: [], data: [], ports: [], opened: [], closed: [], disconnected: [],
    holders: [], metaChanged: [], devices: [], error: [], sshHosts: [], sshTestResult: [],
  };

  on<K extends keyof Handlers>(kind: K, cb: Handlers[K][number]): () => void {
    (this.h[kind] as unknown[]).push(cb);
    return () => {
      const arr = this.h[kind] as unknown[];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    // 数据帧按 ArrayBuffer 解码——默认 blob 下 new Uint8Array(e.data) 是空数组，
    // 设备回显会被整帧吞掉（屏幕无输出但 TX 正常，"打字没反应"的根因）
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.startHeartbeat(ws);
      this.openWaiters.forEach((f) => f());
      this.openWaiters = [];
      this.h.connected.forEach((cb) => cb(true));
      // 连上即拉一次全量（端口表/SSH 表/版本）
      this.send({ action: "list" });
      this.send({ action: "ssh_list" });
      this.version().catch(() => {});
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.rejectPending(new Error("连接已断开"));
      this.clearTimers();
      this.h.connected.forEach((cb) => cb(false));
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose 必随后触发，这里不重复调度 */
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.clearPongTimer();
      if (typeof e.data !== "string") {
        const { port, data } = decodeDataFrame(e.data);
        this.h.data.forEach((cb) => cb(port, data));
        return;
      }
      this.dispatch(JSON.parse(e.data));
    };
  }

  private dispatch(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "ports":
        this.h.ports.forEach((cb) => cb(msg.ports as PortView[]));
        break;
      case "opened":
        this.h.opened.forEach((cb) => cb(msg.port as string));
        break;
      case "closed":
        this.h.closed.forEach((cb) => cb(msg.port as string));
        break;
      case "disconnected":
        this.h.disconnected.forEach((cb) => cb(msg.port as string));
        break;
      case "acquired": {
        const c = this.openResolvers.get(msg.port as string);
        if (c) {
          c.resolve({
            port: msg.port as string,
            opened: msg.opened as boolean,
            config: (msg.config ?? {}) as Record<string, unknown>,
            holders: msg.holders as number,
          });
          this.openResolvers.delete(msg.port as string);
        }
        break;
      }
      case "holders":
        this.h.holders.forEach((cb) => cb(msg.port as string, msg.holders as number));
        break;
      case "meta_changed":
        this.h.metaChanged.forEach((cb) => cb());
        break;
      case "devices":
        this.h.devices.forEach((cb) => cb((msg.devices ?? []) as unknown[]));
        break;
      case "error": {
        const message = msg.message as string;
        this.h.error.forEach((cb) => cb(message));
        const wire = typeof msg.port === "string" ? msg.port : null;
        if (wire && this.openResolvers.has(wire)) {
          const err = Object.assign(new Error(message), { ssh: msg.ssh as SshOpenError | undefined });
          this.openResolvers.get(wire)!.reject(err);
          this.openResolvers.delete(wire);
        } else if (!wire && this.openResolvers.size > 0) {
          // 消息层错误（如参数解析失败）不带 port——必须兜底 reject 全部在途
          // open，否则 Promise 永久悬挂（SSH "打不开且无反馈"的第二成因）
          const err = new Error(message);
          this.openResolvers.forEach((c) => c.reject(err));
          this.openResolvers.clear();
        }
        break;
      }
      case "ssh_hosts":
        this.h.sshHosts.forEach((cb) => cb(msg.hosts as SshHostT[]));
        break;
      case "ssh_test_result":
        this.h.sshTestResult.forEach((cb) =>
          cb(msg.host_id as string, !!msg.ok, (msg.message as string) ?? ""),
        );
        break;
      case "version": {
        const v = {
          version: msg.version as string,
          enableScripting: !!msg.enable_scripting,
          instanceId: msg.instance_id as string | undefined,
        };
        this.versionWaiters.forEach((f) => f(v));
        this.versionWaiters = [];
        break;
      }
      case "pong":
        break;
    }
  }

  private send(obj: unknown) {
    this.ws?.send(JSON.stringify(obj));
  }

  private whenOpen(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => this.openWaiters.push(resolve));
  }

  /** 打开端口。UI 恒用规范键（PortView.name，服务端真名）——请求名与回执
   *  Acquired.port（resolved 真名）天然一致，按端口配对无歧义。SSH 失败 reject
   *  带 ssh 结构化分类（auth_failed / host_key_unknown / host_key_changed）。
   *  25s 超时：SSH 建连（TCP+认证+PTY）可能很慢，超时必须反馈而非永久悬挂。
   *  同端口并发 open 单飞：此前两次 open 会互相覆盖 openResolvers 表项、
   *  超时定时器误删对方表项，其中一个 Promise 永久悬挂（双击/StrictMode 双开必踩）。 */
  async open(port: string, config?: Record<string, unknown>): Promise<OpenResult> {
    await this.whenOpen();
    const inflight = this.openInflight.get(port);
    if (inflight) return inflight;
    const p = new Promise<OpenResult>((resolve, reject) => {
      const settle = () => {
        this.openInflight.delete(port);
        this.openResolvers.delete(port);
      };
      const timer = setTimeout(() => {
        const entry = this.openResolvers.get(port);
        if (entry) entry.reject(new Error(`打开 ${port} 超时（25 秒无回执；SSH 主机不可达或网络慢）`));
      }, 25_000);
      this.openResolvers.set(port, {
        resolve: (r) => {
          clearTimeout(timer);
          settle();
          resolve(r);
        },
        reject: (e: Error & { ssh?: SshOpenError }) => {
          clearTimeout(timer);
          settle();
          reject(e);
        },
      });
      this.send({
        action: "open",
        port,
        config: { ...FULL_DEFAULT_CONFIG, ...(config ?? {}) },
      });
    });
    this.openInflight.set(port, p);
    return p;
  }

  close(port: string) {
    this.send({ action: "close", port });
  }

  write(port: string, data: string) {
    this.send({ action: "write", port, data, encoding: "text" });
  }

  resize(port: string, cols: number, rows: number) {
    this.send({ action: "resize", port, cols, rows });
  }

  setAlias(port: string, alias: string | null) {
    this.send({ action: "set_alias", port, alias });
  }

  sshList() {
    this.send({ action: "ssh_list" });
  }

  /** 全量表覆盖（协议形态：hosts 数组；增删改都走它）。 */
  sshSave(hosts: SshHostT[]) {
    this.send({ action: "ssh_save", hosts });
  }

  sshTest(hostId: string) {
    this.send({ action: "ssh_test", host_id: hostId });
  }

  sshTrustHost(hostId: string) {
    this.send({ action: "ssh_trust_host", host_id: hostId });
  }

  async version(): Promise<{ version: string; enableScripting: boolean; instanceId?: string }> {
    await this.whenOpen();
    return new Promise((resolve) => {
      this.versionWaiters.push(resolve);
      this.send({ action: "version" });
    });
  }

  private rejectPending(e: Error) {
    this.openResolvers.forEach((c) => c.reject(e));
    this.openResolvers.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const base = Math.min(RECONNECT_BASE * 2 ** this.reconnectAttempts, RECONNECT_CAP);
    const delay = base + Math.random() * base; // 抖动：多客户端同时断连不齐步重连
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private startHeartbeat(ws: WebSocket) {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => ws.close(), PONG_TIMEOUT);
      this.send({ action: "ping" });
    }, PING_INTERVAL);
  }

  private clearPongTimer() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPongTimer();
  }
}

/** 进程级单例：数据面连接全 UI 共用。 */
export const ws = new Ws();

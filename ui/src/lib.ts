import type { ConnConfig, Macro, SerialConfig } from "./types";

// ===== 环境检测 / Tauri 调用 =====

export function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// ===== localStorage 持久化（跟着用户走的配置） =====

const CONFIG_KEY = "serial-studio-config";
export const DEFAULT_CONFIG: SerialConfig = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "lf",
};

export function loadConfig(): SerialConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG;
}
export function saveConfig(config: SerialConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

const CONN_KEY = "serial-studio-conn";
export function loadConn(): ConnConfig {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { host: location.hostname || "localhost", port: 18700 };
}
export function saveConn(c: ConnConfig) {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/** 远程窗口：URL ?remote=host:port 携带远程地址 */
export function getRemoteFromUrl(): ConnConfig | null {
  const remote = new URLSearchParams(location.search).get("remote");
  if (!remote) return null;
  const [host, portStr] = remote.split(":");
  const port = parseInt(portStr, 10);
  return host && port ? { host, port } : null;
}

/** 初始连接：远程窗口（?remote）> 本地模式（Tauri 连本机服务）> Web（loadConn） */
export function initConn(): ConnConfig {
  return getRemoteFromUrl() ?? (isTauri() ? { host: "127.0.0.1", port: 18700 } : loadConn());
}

const MACROS_KEY = "serial-studio-macros";
export function loadMacrosLocal(): Record<string, Macro> {
  try {
    const raw = localStorage.getItem(MACROS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}
export function persistMacrosLocal(macros: Record<string, Macro>) {
  try {
    localStorage.setItem(MACROS_KEY, JSON.stringify(macros));
  } catch {
    /* ignore */
  }
}

/** 持久化宏：Tauri → invoke save_macros；Web → localStorage */
export async function persistMacros(macros: Record<string, Macro>) {
  if (isTauri()) {
    try {
      await tauriInvoke("save_macros", { macros });
    } catch (e) {
      console.error("保存宏失败", e);
    }
  } else {
    persistMacrosLocal(macros);
  }
}

// ===== 共享常量 =====

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

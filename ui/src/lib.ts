import type { ConnConfig, Macro, PortId, RemoteDevice, Script, ScriptParam, SerialConfig } from "./types";

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

/**
 * 从脚本 code 解析 `// @param` 声明:让 AI 生成的脚本自包含(一段 code 含参数声明,
 * 粘贴即用,自动填入参数区)。格式:
 *   // @param <name> string [default=值]
 *   // @param <name> select 选项1|选项2|... [default=选项]
 * 返回解析出的参数数组;code 无任何 @param 行时返回 null(调用方据此不覆盖现有 params)。
 */
export function parseParamsFromCode(code: string): ScriptParam[] | null {
  const params: ScriptParam[] = [];
  for (const line of code.split("\n")) {
    const m = line.match(/^\s*\/\/\s*@param\s+(\w+)\s+(string|select)\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    const type = m[2] as "string" | "select";
    const rest = m[3] ?? "";
    const defaultMatch = rest.match(/\bdefault=(\S+)/);
    const def = defaultMatch ? defaultMatch[1] : undefined;
    let options: string[] | undefined;
    if (type === "select") {
      const optsStr = rest.replace(/\bdefault=\S+/, "").trim();
      options = optsStr ? optsStr.split("|").map((s) => s.trim()).filter((s) => s.length > 0) : undefined;
    }
    params.push({ name, type, default: def, options });
  }
  return params.length > 0 ? params : null;
}

/**
 * 按分组字段聚合:返回有序组列表,每组含组名 + 组内项(按 key 字典序)。
 * 具名组按组名字典序在前;无 group 的项并入末尾「未分组」组(仅当存在无组项)。
 */
export function groupBy<T>(
  items: [string, T][],
  getGroup: (t: T) => string | undefined,
): { name: string; items: [string, T][] }[] {
  const buckets = new Map<string, [string, T][]>();
  const ungrouped: [string, T][] = [];
  for (const [k, v] of items) {
    const g = getGroup(v)?.trim();
    if (g) (buckets.get(g) ?? buckets.set(g, []).get(g)!).push([k, v]);
    else ungrouped.push([k, v]);
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, it]) => ({ name, items: it.sort((a, b) => a[0].localeCompare(b[0])) }));
  if (ungrouped.length)
    groups.push({ name: "未分组", items: ungrouped.sort((a, b) => a[0].localeCompare(b[0])) });
  return groups;
}

// ===== 端口复合键（devId::name，多 Transport 共存时区分本地/远程同名端口） =====

/** 组装端口复合键：`${devId}::${name}`。串口名不含 `::`，分隔安全。 */
export function portIdOf(devId: string, name: string): PortId {
  return `${devId}::${name}`;
}

/** 解析端口复合键。仅按首个 `::` 切分：devId（UUID 或 "local"）不含 `::`，
 *  name（如 /dev/ttyUSB0）含 `/` 但不含 `::`。无分隔符时按本地裸端口名兼容旧值。 */
export function parsePortId(id: PortId): { devId: string; name: string } {
  const idx = id.indexOf("::");
  if (idx < 0) return { devId: "local", name: id };
  return { devId: id.slice(0, idx), name: id.slice(idx + 2) };
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
  // Web 模式默认连"同源"：从 ss-server 打开页面时即连回它自己（含自定义 --port）
  return { host: location.hostname || "localhost", port: location.port ? Number(location.port) : 18700 };
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

const SCRIPTS_KEY = "serial-studio-scripts";
export function loadScriptsLocal(): Record<string, Script> {
  try {
    const raw = localStorage.getItem(SCRIPTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}
export function persistScriptsLocal(scripts: Record<string, Script>) {
  try {
    localStorage.setItem(SCRIPTS_KEY, JSON.stringify(scripts));
  } catch {
    /* ignore */
  }
}

/** 持久化脚本：Tauri → invoke save_scripts；Web → localStorage */
export async function persistScripts(scripts: Record<string, Script>) {
  if (isTauri()) {
    try {
      await tauriInvoke("save_scripts", { scripts });
    } catch (e) {
      console.error("保存脚本失败", e);
    }
  } else {
    persistScriptsLocal(scripts);
  }
}

const REMOTES_KEY = "serial-studio-remotes";
export function loadRemotesLocal(): RemoteDevice[] {
  try {
    const raw = localStorage.getItem(REMOTES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}
export function persistRemotesLocal(remotes: RemoteDevice[]) {
  try {
    localStorage.setItem(REMOTES_KEY, JSON.stringify(remotes));
  } catch {
    /* ignore */
  }
}

// ===== 共享常量 =====

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** 下载 / 保存 JSON 文件。
 * - Tauri 桌面端：弹原生保存对话框（用户选位置 + 文件名），写文件。返回 false = 用户取消。
 * - Web：浏览器 blob 下载到下载文件夹（无取消概念，返回 true）。
 * 写入失败抛错（调用方 catch）。 */
export async function downloadJson(filename: string, obj: unknown): Promise<boolean> {
  const content = JSON.stringify(obj, null, 2);
  if (isTauri()) {
    return tauriInvoke<boolean>("save_json_file", { defaultName: filename, content });
  }
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

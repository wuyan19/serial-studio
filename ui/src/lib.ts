import type { ConnConfig, Macro, PortId, RemoteDevice, Script, ScriptParam, SerialConfig } from "./types";

// ===== 环境检测 / Tauri 调用 =====

export function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** 运行形态（唯一判定点，勿在别处重组 isTauri/getRemoteFromUrl）：
 *  - local        = Tauri 桌面壳的本地模式（IPC 直连本机服务）
 *  - remote-window= Tauri 壳内的远程窗口（?remote=host:port，WS 连远程服务）
 *  - web          = 浏览器打开 ss-server 页面（WS 连同源/已存连接） */
export type RunMode = "local" | "remote-window" | "web";
export function getMode(): RunMode {
  if (getRemoteFromUrl()) return "remote-window";
  return isTauri() ? "local" : "web";
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
 *   // @param <name> string default=值
 *   // @param <name> select 选项1|选项2|... default=选项
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
    // 容错:default 提取到 ]/[ 空格停(AI 可能误生成 [default=x]);options 剥方括号
    const defaultMatch = rest.match(/\bdefault=([^\[\]\s]+)/);
    const def = defaultMatch ? defaultMatch[1] : undefined;
    let options: string[] | undefined;
    if (type === "select") {
      const optsStr = rest.replace(/\bdefault=\S+/, "").replace(/[\[\]]/g, "").trim();
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
    // 保留名「未分组」归入 ungrouped:否则它会进具名 bucket，与下面合成的「未分组」组并存，
    // 产生两条同名组 → 渲染 key={g.name} 碰撞（重命名组为「未分组」时可触发）。
    if (g && g !== "未分组") (buckets.get(g) ?? buckets.set(g, []).get(g)!).push([k, v]);
    else ungrouped.push([k, v]);
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, it]) => ({ name, items: it.sort((a, b) => a[0].localeCompare(b[0])) }));
  if (ungrouped.length)
    groups.push({ name: "未分组", items: ungrouped.sort((a, b) => a[0].localeCompare(b[0])) });
  return groups;
}

// ===== 命名记录的增改与分组操作（宏/脚本共用：名字是 Record key，group 是字段） =====

/**
 * 重命名/新增一条命名记录：
 * - oldKey 非空且与新名不同 → 删旧 key（否则改名会变成「复制一份」、旧名残留）。
 * - 新名为空、或被别的记录占用（非自身）→ 返回 null，调用方据此报错。
 * 宏/脚本的 save 共用，统一「真重命名 + 重名冲突」语义。
 */
export function upsertNamed<T>(
  rec: Record<string, T>,
  oldKey: string | null,
  newKey: string,
  value: T,
): Record<string, T> | null {
  const k = newKey.trim();
  if (!k) return null;
  if (k !== oldKey && rec[k] != null) return null;
  const next = { ...rec };
  if (oldKey && oldKey !== k) delete next[oldKey];
  next[k] = value;
  return next;
}

/**
 * 重命名分组：把 group===oldName 的成员 group 字段改为 newName。
 * - newName 为空 → 原样返回（防止把组名清空误当成解散；解散走 dissolveGroup）。
 * - 撞已有组名 → 成员并入该组（groupBy 自然合并）。
 * 组是派生实体（无独立存储），所以「改组名」= 批量改成员字段。
 */
export function renameGroup<T extends { group?: string }>(
  rec: Record<string, T>,
  oldName: string,
  newName: string,
): Record<string, T> {
  const n = newName.trim();
  if (!n) return rec;
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) next[k] = v.group === oldName ? { ...v, group: n } : v;
  return next;
}

/**
 * 解散分组：把 group===name 的成员 group 置空（移至「未分组」），成员本身保留。
 * 返回新 map 与受影响成员数（供确认文案用）。组随末个成员而灭——与 renameGroup 对称。
 */
export function dissolveGroup<T extends { group?: string }>(
  rec: Record<string, T>,
  name: string,
): { next: Record<string, T>; count: number } {
  let count = 0;
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v.group === name) {
      next[k] = { ...v, group: undefined };
      count++;
    } else {
      next[k] = v;
    }
  }
  return { next, count };
}

// ===== 端口复合键(devId::name,区分远程设备;本地端口键=裸名) =====

/** 组装端口复合键：`${devId}::${name}`。串口名不含 `::`，分隔安全。 */
export function portIdOf(devId: string, name: string): PortId {
  return `${devId}::${name}`;
}

/** 解析端口复合键。仅按首个 `::` 切分：devId（UUID）不含 `::`，
 *  name（如 /dev/ttyUSB0）含 `/` 但不含 `::`。无分隔符 = 本机裸端口名（规范形态）。 */
export function parsePortId(id: PortId): { devId: string; name: string } {
  const idx = id.indexOf("::");
  if (idx < 0) return { devId: "local", name: id };
  return { devId: id.slice(0, idx), name: id.slice(idx + 2) };
}

/** 线上端口名 → 完整 pid（事件 ingest 用）。本地 transport 的线名已是本机视角键
 *  （本地口=裸名、远端桶=devId::name,pid ≡ 线名,直通）；远程 transport 的线名是
 *  远端侧键(远端视角的裸名或其级联键),需加本设备前缀——
 *  两级 "uuid::uuid2::COM3" 即在此自然产生（级联）。 */
export function wireToPid(devId: string, wirePort: string): PortId {
  return devId === "local" ? (wirePort as PortId) : portIdOf(devId, wirePort);
}

/** pid 的展示名：最后一个 `::` 之后（多级级联也只显示串口名，设备归属由分桶表达）。
 *  串口名不含 `::` 是既有不变量。 */
export function displayPortName(pid: PortId): string {
  const idx = pid.lastIndexOf("::");
  return idx < 0 ? pid : pid.slice(idx + 2);
}

// ===== 终端记录文件名 =====

/** 文件名消毒:Windows/Mac/Linux 通吃——非法字符与控制符替换为 _,空串回落占位。
 *  远程设备昵称/实例 uuid、串口名(含 / 的 ttyUSB 类)都过这里。纯函数,单测在 lib.test.ts。 */
export function sanitizeFileName(s: string): string {
  const cleaned = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "_";
}

/** 文件名用本地时间戳:yyyyMMdd-HHmmss(如 20260826-163821)。 */
export function timestampForFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 终端记录默认文件名:`<时间戳>-<端口>.log`;远程口带设备标识
 *  `<时间戳>-<设备昵称|uuid>_<串口名>.log`(devLabel 缺省回退键首段)。
 *  多级级联键取首段(直连设备的标识——它是本机注册的远端,非端口属主)。
 *  纯函数,单测在 lib.test.ts。 */
export function defaultCaptureName(pid: PortId, devLabel?: string): string {
  const bare = displayPortName(pid);
  const label = pid.includes("::")
    ? `${sanitizeFileName(devLabel ?? parsePortId(pid).devId)}_${sanitizeFileName(bare)}`
    : sanitizeFileName(bare);
  return `${timestampForFileName()}-${label}.log`;
}

/** 合并字节块为单个连续数组(记录攒批落盘用)。纯函数,单测在 lib.test.ts。 */
export function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 桶内条目名 → pid（列表消费侧，幂等）：条目键首段已等于桶 devId（本地 transport
 *  的合并视图，键为完整 pid）则直通；否则（远程 transport 的远端侧键）加桶前缀。 */
export function bucketPidOf(grpDevId: string, name: string): PortId {
  return parsePortId(name).devId === grpDevId ? (name as PortId) : portIdOf(grpDevId, name);
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

/** 初始连接：远程窗口（?remote）> 本地模式（Tauri 连本机服务）> Web（loadConn）。按形态单点分流。 */
export function initConn(): ConnConfig {
  switch (getMode()) {
    case "remote-window":
      return getRemoteFromUrl()!;
    case "local":
      return { host: "127.0.0.1", port: 18700 };
    default:
      return loadConn();
  }
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

/** 脚本上次运行参数(脚本名 → 参数键值)。属 UI 运行时状态(同 ConnConfig 一类,非
 *  宏/脚本库数据),三形态统一 localStorage,不进桌面端 JSON store;预填按脚本当前
 *  params 声明过滤失效键(见 prefillRunValues),丢了大不了重填。 */
const SCRIPT_ARGS_KEY = "serial-studio-script-args";
export function loadScriptArgs(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(SCRIPT_ARGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}
export function persistScriptArgs(args: Record<string, Record<string, string>>) {
  try {
    localStorage.setItem(SCRIPT_ARGS_KEY, JSON.stringify(args));
  } catch {
    /* ignore */
  }
}

/** 参数声明的默认值:string → default,select → default(须在 options 内)否则首个
 *  非空 option,均无则空串。ScriptRunParamsDialog 的行内重置也用同一结果做目标值。 */
export function paramDefault(p: ScriptParam): string {
  if (p.default !== undefined && (p.type !== "select" || (p.options ?? []).includes(p.default))) {
    return p.default;
  }
  return p.options?.find((o) => o) ?? "";
}

/** 运行参数预填:缓存命中用上次值(用户"按需微调"的语义,优先于声明默认),否则回落
 *  声明默认。select 的缓存值已不在当前 options(脚本被编辑过)也回落,防下拉悬空;
 *  string 的空串缓存保留(用户上次显式清空)。纯函数,单测在 lib.test.ts。 */
export function prefillRunValues(
  params: ScriptParam[],
  cached: Record<string, string> | undefined,
): Record<string, string> {
  const init: Record<string, string> = {};
  for (const p of params) {
    const c = cached?.[p.name];
    if (c !== undefined && (p.type !== "select" || (p.options ?? []).includes(c))) {
      init[p.name] = c;
    } else {
      init[p.name] = paramDefault(p);
    }
  }
  return init;
}

const REMOTES_KEY = "serial-studio-remotes";
export function persistRemotesLocal(remotes: RemoteDevice[]) {
  try {
    localStorage.setItem(REMOTES_KEY, JSON.stringify(remotes));
  } catch {
    /* ignore */
  }
}

/** 持久化远程设备列表：Tauri → invoke save_remotes；Web → localStorage。
 * 仅桌面端真正落盘到 remotes.json（Web/远程窗口 remotes 由 connConfig 派生，不调此函数）。 */
export async function persistRemotes(remotes: RemoteDevice[]) {
  if (isTauri()) {
    try {
      await tauriInvoke("save_remotes", { remotes });
    } catch (e) {
      console.error("保存远程设备失败", e);
    }
  } else {
    persistRemotesLocal(remotes);
  }
}

/** 设备在线快照条目(Devices 推送)。host/port 供 id 对齐;旧版后端缺省。 */
export interface DeviceStateEntry {
  id: string;
  online: boolean;
  host?: string;
  port?: number;
}

/** remotes 的 id 对齐结果:list 无变化时为原引用(跳过 setState),renamed 为本次替换映射。 */
export interface RemoteIdAlignment {
  list: RemoteDevice[];
  renamed: Map<string, string>;
}

/** 按地址把后端"学习到的实例 id"对齐回 remotes 条目(段名=实例 id):
 * 后端握手学习会把设备段名从占位 uuid 替换为对端实例 id,Devices 推送随之携带新 id。
 * 时序保证(后端先迁移后 online)使占位 id 从未有端口桶/打开的 tab——替换是纯增量,
 * 无需迁移任何键。设备缺 host/port(旧版后端)或已对齐时不动作。 */
export function alignRemotesId(
  remotes: RemoteDevice[],
  devices: DeviceStateEntry[],
): RemoteIdAlignment {
  const renamed = new Map<string, string>();
  for (const d of devices) {
    if (!d.host || d.port === undefined) continue; // 旧版后端无地址字段,跳过
    if (remotes.some((r) => r.id === d.id)) continue; // 已对齐(或同 id 新条目)
    const target = remotes.find((r) => r.host === d.host && r.port === d.port && r.id !== d.id);
    if (target) renamed.set(target.id, d.id);
  }
  if (renamed.size === 0) return { list: remotes, renamed };
  const list = remotes.map((r) => {
    const to = renamed.get(r.id);
    return to ? { ...r, id: to } : r;
  });
  return { list, renamed };
}

// ===== 共享常量 =====

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** 复制文本到系统剪贴板（终端选中即复制用）。
 *  navigator.clipboard 只在安全上下文存在（Tauri 的 tauri/https.localhost、Web 的 localhost ✓；
 *  局域网 http://192.168.x.x 访问 Web 版 ✗），缺失或失败时降级 execCommand（已废弃但
 *  Chromium/WebKit 均仍支持，恰好覆盖非安全上下文）。返回是否成功。 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到兜底 */
    }
  }
  try {
    // 记住复制前焦点:select() 会把焦点抢到临时 textarea,删掉后丢到 body——
    // 终端(xterm 的隐藏输入代理)会失焦,不归还的话要再点一下窗口才能继续打字。
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement("textarea");
    ta.value = text;
    // 移出视口 + 防滚动穿透;readonly 防 iOS 弹键盘(本项目桌面为主,防御性保留)
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    prev?.focus();
    return ok;
  } catch {
    return false;
  }
}

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

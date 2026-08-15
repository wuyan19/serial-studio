/**
 * 快捷键注册表（唯一真相源）。
 *
 * 两个出口都只读这里、都经调用方传入的 dispatch(actionId) 执行：
 *  - A 全局 window listener（capture；焦点/模态由 App 抑制）—— 见 App.tsx
 *  - B 桌面原生菜单 accelerator（仅 global 作用域）—— 见 menu.ts
 * 桌面 accelerator 由 OS 先于 webview 拦截，故 listener 不会与之双触发；
 * 若某 combo 注册 accelerator 失败（罕见符号键），OS 不拦截，listener 兜底。
 *
 * combo 规范形："mod+shift+f"——小写、修饰符在前、主键在后。
 * mod = 平台主修饰符：匹配用 ctrlKey||metaKey，序列化成 CmdOrCtrl。
 *
 * 范本：theme.ts / term-font.ts（module-private current + Set<Listener> + localStorage）。
 */
import type { ActionId, ShortcutMap } from "./types";
import { isTauri } from "./lib";

const KEY = "serial-studio-keybindings2";

/** 默认绑定。combo 留空 = 该动作默认无快捷键（仍可在桌面菜单点选）。 */
export const DEFAULT_BINDINGS: ShortcutMap = {
  "search.open": { combo: "mod+shift+f", scope: "global" },
  "theme.toggle": { combo: "mod+shift+l", scope: "global" },
  "port.refresh": { combo: "mod+shift+p", scope: "global" },
  // Ctrl+, 被 WebView2 在 JS 之前吞掉(只收到裸 Control 修饰键),改 mod+alt+s
  "settings.open": { combo: "mod+alt+s", scope: "global" },
  "activity.toggle-ports": { combo: "mod+shift+i", scope: "global" },
  "activity.toggle-macros": { combo: "mod+shift+o", scope: "global" },
  "activity.toggle-scripts": { combo: "mod+shift+b", scope: "global" },
  // Ctrl+. 同理被吞,改 mod+alt+a
  "about.open": { combo: "mod+alt+a", scope: "global" },
  "remote.open": { combo: "mod+t", scope: "global" },
  // Ctrl+W 是浏览器保留键(web 会关掉页面标签),改 mod+alt+w 避免冲突
  "port.close-active": { combo: "mod+alt+w", scope: "global" },
  "macro.palette": { combo: "mod+o", scope: "global" },
  "script.palette": { combo: "mod+b", scope: "global" },
  "port.palette": { combo: "mod+i", scope: "global" },
  // 标签页切换：tab.select 是一族键（Ctrl+Alt+1..9，0→末个），用 pattern 捕获数字，不可改键；
  // tab.next/prev 是普通可改键动作，左右循环 wrap。mod+alt+* 是干净命名空间（无默认占用、非浏览器保留）。
  "tab.select": { combo: "", scope: "global", pattern: "^mod\\+alt\\+(\\d)$" },
  "tab.next": { combo: "mod+alt+arrowright", scope: "global" },
  "tab.prev": { combo: "mod+alt+arrowleft", scope: "global" },
  "zoom.in": { combo: "mod+=", scope: "terminal" },
  "zoom.out": { combo: "mod+-", scope: "terminal" },
  "zoom.reset": { combo: "mod+0", scope: "terminal" },
  // 单键 R,仅断开态终端聚焦时触发(connected 态 R 是普通输入);断开无输入,不冲突打字
  "port.reconnect": { combo: "r", scope: "terminal" },
};

/** 动作中文展示名（改键对话框列表 + 冲突提示共用）。 */
export const ACTION_LABELS: Record<ActionId, string> = {
  "search.open": "终端内搜索",
  "theme.toggle": "切换主题",
  "port.refresh": "刷新端口列表",
  "settings.open": "打开设置",
  "about.open": "关于",
  "remote.open": "添加远程设备",
  "activity.toggle-ports": "切到端口侧栏",
  "activity.toggle-macros": "切到宏侧栏",
  "activity.toggle-scripts": "切到脚本侧栏",
  "port.close-active": "关闭当前端口",
  "macro.palette": "宏命令面板",
  "script.palette": "脚本选择面板",
  "port.palette": "串口选择面板",
  "tab.select": "切换到第 N 个标签页",
  "tab.next": "下一个标签页",
  "tab.prev": "上一个标签页",
  "zoom.in": "放大字体",
  "zoom.out": "缩小字体",
  "zoom.reset": "重置字体",
  "port.reconnect": "重连当前端口",
};

type Listener = (m: ShortcutMap) => void;
const listeners = new Set<Listener>();

/** 存储为 overlay：只存用户改动（action→combo），不存默认值。这样改默认值时，
 *  未被用户改过的动作自动跟随新默认，无需清缓存或 bump key。 */
function load(): ShortcutMap {
  const map: ShortcutMap = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const overrides = JSON.parse(raw) as Partial<Record<ActionId, string>>;
      for (const k of Object.keys(overrides) as ActionId[]) {
        if (map[k]) map[k] = { ...map[k], combo: overrides[k] ?? map[k].combo };
      }
    }
  } catch {
    /* ignore */
  }
  return map;
}

let current: ShortcutMap = load();

function persist() {
  const overrides: Record<string, string> = {};
  for (const k of Object.keys(current) as ActionId[]) {
    if (current[k].combo !== DEFAULT_BINDINGS[k].combo) {
      overrides[k] = current[k].combo;
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

function notify() {
  listeners.forEach((l) => l(current));
}

export function getBindings(): ShortcutMap {
  return current;
}

/** combo 命中的动作（精确优先）。精确等值命中返回 { id }；若精确落空但某参数化绑定的
 *  pattern 匹配该 combo，返回 { id, arg }（arg = 捕获组，如 "3"）。无则 null。 */
export function findAction(
  combo: string,
  scope?: "global" | "terminal",
): { id: ActionId; arg?: string } | null {
  // 第一遍：精确等值（所有 1:1 动作在此命中，arg 永不产生）
  for (const k of Object.keys(current) as ActionId[]) {
    const b = current[k];
    if (b.combo && b.combo === combo && (!scope || b.scope === scope)) {
      return { id: k };
    }
  }
  // 第二遍：参数化绑定（pattern）兜底，捕获组当 arg
  for (const k of Object.keys(current) as ActionId[]) {
    const b = current[k];
    if (b.pattern && (!scope || b.scope === scope)) {
      const m = new RegExp(b.pattern).exec(combo);
      if (m) return { id: k, arg: m[1] };
    }
  }
  return null;
}

// ===== 改键校验 =====

export type SetResult = { ok: true } | { ok: false; reason: string };

/** 校验 combo 是否可用于 action（空 combo = 解绑，始终允许）。 */
export function validateCombo(combo: string, action: ActionId): SetResult {
  if (!combo) return { ok: true };
  const parts = combo.split("+");
  if (!parts.includes("mod") && !parts.includes("alt") && action !== "port.reconnect") {
    return { ok: false, reason: "必须包含 Ctrl/⌘ 或 Alt(重连除外:仅断开态触发,不冲突打字)" };
  }
  if (isReserved(combo)) {
    return { ok: false, reason: isTauri() ? "系统保留键" : "浏览器保留键（无法拦截）" };
  }
  for (const k of Object.keys(current) as ActionId[]) {
    if (k === action) continue;
    if (current[k].combo && current[k].combo === combo) {
      return { ok: false, reason: `与「${ACTION_LABELS[k]}」冲突` };
    }
  }
  // 参数化绑定（pattern）冲突：候选 combo 落在别族的 pattern 里也拒
  // （如把 tab.next 改成 mod+alt+5 会吃掉 tab.select 数字族）
  for (const k of Object.keys(current) as ActionId[]) {
    if (k === action) continue;
    const pat = current[k].pattern;
    if (pat && new RegExp(pat).test(combo)) {
      return { ok: false, reason: `与「${ACTION_LABELS[k]}」冲突` };
    }
  }
  return { ok: true };
}

export function setBinding(action: ActionId, combo: string): SetResult {
  const r = validateCombo(combo, action);
  if (!r.ok) return r;
  const prev = current[action];
  if (prev.combo === combo) return { ok: true };
  current = { ...current, [action]: { ...prev, combo } };
  persist();
  notify();
  return { ok: true };
}

export function resetBinding(action: ActionId) {
  setBinding(action, DEFAULT_BINDINGS[action].combo);
}

export function resetAll() {
  current = { ...DEFAULT_BINDINGS };
  persist();
  notify();
}

export function subscribeBindings(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ===== combo 转换 =====

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift"]);

/** KeyboardEvent → 规范 combo。纯修饰符（仍在按组合）返回 ""。 */
export function eventToCombo(e: KeyboardEvent): string {
  if (MODIFIER_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  parts.push(key);
  return parts.join("+");
}

/** combo → Tauri/muda accelerator 串（仅 global 作用域用）。返回 null = 无 accelerator。 */
export function comboToAccelerator(combo: string): string | null {
  if (!combo) return null;
  const specials: Record<string, string> = {
    ",": "Comma",
    ".": "Period",
    "-": "Minus",
    "=": "Equal",
    space: "Space",
  };
  return combo
    .split("+")
    .map((p) => {
      if (p === "mod") return "CmdOrCtrl";
      if (p === "shift") return "Shift";
      if (p === "alt") return "Alt";
      if (specials[p]) return specials[p];
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join("+");
}

/** combo → 人读形用于键帽：Mac 显符号并连写（⌘⇧F），其余 Ctrl+Shift+F。 */
export function formatCombo(combo: string): string {
  if (!combo) return "—";
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const parts = combo.split("+").map((p) => {
    if (p === "mod") return isMac ? "⌘" : "Ctrl";
    if (p === "shift") return isMac ? "⇧" : "Shift";
    if (p === "alt") return isMac ? "⌥" : "Alt";
    if (p === "space") return "Space";
    return p.length === 1 ? p.toUpperCase() : p;
  });
  return parts.join(isMac ? "" : "+");
}

/** 浏览器会拦截且 JS 无法 preventDefault 的组合（web 模式拒；桌面无浏览器 chrome，恒允许）。 */
const BROWSER_RESERVED = new Set([
  "mod+w",
  "mod+shift+w",
  "mod+t",
  "mod+shift+t",
  "mod+n",
  "mod+shift+n",
  "mod+l",
  "mod+d",
  "mod+r",
  "mod+shift+r",
  "mod+f5",
  "mod+tab",
  "mod+shift+tab",
]);

export function isReserved(combo: string): boolean {
  if (isTauri()) return false;
  return BROWSER_RESERVED.has(combo);
}

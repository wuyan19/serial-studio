/**
 * 主题模块。
 * 真 source of truth 是 <html data-theme>，由 index.html 内联脚本在首帧前写入（防闪烁）。
 * 这里只做：读取当前值、切换（写 localStorage + 改属性 + 通知订阅者）。
 * 订阅者：App 的切换按钮图标、TermView 的 xterm 配色。
 *
 * 多主题机制：主题清单在下方 THEMES 注册表，toggle 循环切换。新增主题的接入清单
 * （各处都无法 import 注册表，需手动同步）：
 *   1. THEMES 登记 { id, label }
 *   2. styles.css 加一块 `:root[data-theme="xxx"]` token 覆盖（仿 light 块）
 *   3. index.html 内联脚本的 id 数组 + 首帧背景色规则
 *   4. components/term.tsx 的 TERM_THEMES / SEARCH_DECORATIONS 各加一条
 *   5. App.tsx 的 THEME_ICONS 加一条
 *   6. components/editors.tsx 的 CodeMirror 语法色(cmSyntax*,色值与 TERM_THEMES 同源)加一套
 */

/** 主题注册表（有序，toggle 按此循环）。 */
export const THEMES = [
  { id: "dark", label: "暗色" },
  { id: "light", label: "亮色" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

const KEY = "serial-studio-theme";
type Listener = (t: Theme) => void;
const listeners = new Set<Listener>();

function isTheme(v: string): v is Theme {
  return THEMES.some((t) => t.id === v);
}

function readDom(): Theme {
  const t = document.documentElement.dataset.theme ?? "";
  return isTheme(t) ? t : "dark";
}

let current: Theme = readDom();

export function getTheme(): Theme {
  return current;
}

export function setTheme(t: Theme) {
  if (t === current) return;
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = t;
  listeners.forEach((l) => l(t));
}

/** 循环切换到注册表中的下一个主题。 */
export function toggleTheme() {
  const i = THEMES.findIndex((t) => t.id === current);
  setTheme(THEMES[(i + 1) % THEMES.length].id); // findIndex 落空(-1)时 +1 恰回 0(dark)
}

/** 下一主题的显示名（切换按钮 title 用，如「切换到 亮色」）。 */
export function nextThemeLabel(t: Theme): string {
  const i = THEMES.findIndex((x) => x.id === t);
  return THEMES[(i + 1) % THEMES.length].label;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

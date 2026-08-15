/**
 * 主题模块——一个主题 = 注册表里一条完整自洽的定义(明暗是主题自带的属性,不做独立开关)。
 * 真 source of truth 是 <html data-theme>，由 index.html 内联脚本在首帧前写入（防闪烁）。
 * 这里只做：读取当前值、切换（写 localStorage + 改属性 + 通知订阅者）、集中持有各主题的
 * TS 侧配色(xterm 终端 / 搜索高亮 / CodeMirror 语法色——canvas 与 webview 不吃 CSS 变量,必须给纯色值)。
 *
 * 新增主题清单(3 处,组件代码零改动):
 *   1. theme.ts 在 THEMES 登记一条完整定义(下方 ThemeDef,含 term/search/cm)
 *   2. styles.css:token 住 :root 默认块(暗色)或 `:root[data-theme="xxx"]` 覆盖块
 *   3. index.html 内联脚本的 id 数组 + 首帧背景色规则
 *   term.tsx / editors.tsx / App.tsx 均从注册表读取,不再需要手动同步。
 */
import type { ITheme } from "@xterm/xterm";
import type { ISearchDecorationOptions } from "@xterm/addon-search";

/** CodeMirror 语法高亮的按主题色板(键名即语义,tag 映射在 editors.tsx 统一完成)。 */
export interface CmSyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  func: string;
  type: string;
  defVar: string;
}

/** 一条完整主题定义。CSS token 在 styles.css 的 data-theme 覆盖块里,这里只放 TS 侧需要的纯色。 */
export interface ThemeDef {
  id: string;
  /** 菜单显示名。 */
  label: string;
  /** 家族(主题菜单按此分组,如「Linear」)。 */
  family: string;
  /** 明暗属性(CM EditorView dark 标记等按此判定)。 */
  lum: "dark" | "light";
  /** xterm 终端配色(canvas 不吃 CSS 变量)。 */
  term: ITheme;
  /** 终端搜索高亮(xterm 要求纯 #RRGGBB)。 */
  search: ISearchDecorationOptions;
  /** CodeMirror 语法色。term.selectionBackground 同时复用为 CM 选中底色。 */
  cm: CmSyntaxColors;
}

/* ===== Linear·暗(默认)——近黑底 + 薰衣草交互色;终端光标/选中随交互色,
   ANSI 信号调色板青(RX)/琥珀(TX)为语义色,不随风格家族变。 ===== */
const LINEAR_TERM: ITheme = {
  background: "#060708",
  foreground: "#d6dbe4",
  cursor: "#4fd6c2",
  cursorAccent: "#060708",
  selectionBackground: "rgba(94,106,210,0.30)",
  black: "#060708",
  brightBlack: "#62666d",
  red: "#e5534b",
  brightRed: "#f2a65a",
  green: "#7ee787",
  brightGreen: "#9cf0a6",
  yellow: "#e3b341",
  brightYellow: "#f2cc60",
  blue: "#5ba3d0",
  brightBlue: "#7fbfdd",
  magenta: "#c792ea",
  brightMagenta: "#d6a8f0",
  cyan: "#4fd6c2",
  brightCyan: "#7be3d4",
  white: "#f7f8f8",
  brightWhite: "#ffffff",
};

const LINEAR_SEARCH: ISearchDecorationOptions = {
  matchBackground: "#2d3154",
  activeMatchBackground: "#4e57a8",
  activeMatchBorder: "#828fff",
  matchOverviewRuler: "#2d3154",
  activeMatchColorOverviewRuler: "#828fff",
};

const LINEAR_CM: CmSyntaxColors = {
  keyword: "#c792ea",
  string: "#e3b341",
  number: "#f2a65a",
  comment: "#62666d",
  func: "#4fd6c2",
  type: "#7fbfdd",
  defVar: "#7ee787",
};

/* ===== Linear·亮(纯白/冷灰底;终端光标与暗主题同语义——保持 RX 深青,
   选中/搜索高亮随薰衣草交互色,ANSI 为白底加深版) ===== */
const LINEAR_LIGHT_TERM: ITheme = {
  background: "#fbfbfc",
  foreground: "#2c2f36",
  cursor: "#0c7f73",
  cursorAccent: "#fbfbfc",
  selectionBackground: "rgba(94,106,210,0.18)",
  black: "#fbfbfc",
  brightBlack: "#8a8f98",
  red: "#c8392f",
  brightRed: "#b06a16",
  green: "#187a43",
  brightGreen: "#1f9352",
  yellow: "#9a6b0c",
  brightYellow: "#b07e0a",
  blue: "#2563a0",
  brightBlue: "#3b78b8",
  magenta: "#9b4d96",
  brightMagenta: "#a85aa6",
  cyan: "#0c7f73",
  brightCyan: "#0d9b8a",
  white: "#2c2f36",
  brightWhite: "#23262b",
};

const LINEAR_LIGHT_SEARCH: ISearchDecorationOptions = {
  matchBackground: "#dfe1f2",
  activeMatchBackground: "#bcc2ef",
  activeMatchBorder: "#5e6ad2",
  matchOverviewRuler: "#dfe1f2",
  activeMatchColorOverviewRuler: "#5e6ad2",
};

const LINEAR_LIGHT_CM: CmSyntaxColors = {
  keyword: "#9b4d96",
  string: "#9a6b0c",
  number: "#b06a16",
  comment: "#8b9099",
  func: "#0c7f73",
  type: "#2563a0",
  defVar: "#187a43",
};

/** 主题注册表(有序,toggle 按此循环;主题菜单按 family 分组展示)。
 *  as const 保住字面量联合类型(Theme = "linear" | "linear-light"),
 *  satisfies 只做结构校验、不拓宽类型。 */
export const THEMES = [
  {
    id: "linear",
    label: "Linear · 暗",
    family: "Linear",
    lum: "dark",
    term: LINEAR_TERM,
    search: LINEAR_SEARCH,
    cm: LINEAR_CM,
  },
  {
    id: "linear-light",
    label: "Linear · 亮",
    family: "Linear",
    lum: "light",
    term: LINEAR_LIGHT_TERM,
    search: LINEAR_LIGHT_SEARCH,
    cm: LINEAR_LIGHT_CM,
  },
] as const satisfies readonly ThemeDef[];

export type Theme = (typeof THEMES)[number]["id"];

/** 已下线的石墨主题 → Linear 的迁移表(老用户的 localStorage 还存着旧 id)。
 *  index.html 内联脚本持有一份等价映射(先于 bundle 执行,负责首帧迁移并回写
 *  localStorage);本表兜底 DOM 属性异常的场景。两处需同步维护。 */
const LEGACY_THEME_MAP: Record<string, Theme> = {
  dark: "linear",
  light: "linear-light",
};

/** 当前主题完整定义(需要 term/cm 配色时用这个,别再各自建映射表)。 */
export function themeDefOf(t: Theme): ThemeDef {
  const def = THEMES.find((d) => d.id === t);
  if (!def) throw new Error(`未知主题: ${t}`);
  return def;
}

const KEY = "serial-studio-theme";
type Listener = (t: Theme) => void;
const listeners = new Set<Listener>();

function isTheme(v: string): v is Theme {
  return THEMES.some((t) => t.id === v);
}

/** 跟随系统明暗偏好选默认主题。 */
function systemTheme(): Theme {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "linear-light"
    : "linear";
}

function readDom(): Theme {
  const t = document.documentElement.dataset.theme ?? "";
  if (isTheme(t)) return t;
  return LEGACY_THEME_MAP[t] ?? systemTheme();
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

/** 循环切换到注册表中的下一个主题(快捷键 theme.toggle 用;菜单之外的快速轮换)。 */
export function toggleTheme() {
  const i = THEMES.findIndex((t) => t.id === current);
  setTheme(THEMES[(i + 1) % THEMES.length].id); // findIndex 落空(-1)时 +1 恰回 0
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

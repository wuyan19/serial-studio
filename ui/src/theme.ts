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

/* ===== 其余家族的 term/search/cm 派生策略 =====
   ANSI 信号调色板(青=RX/琥珀=TX)与语法色是语义层,不随风格家族变——
   新主题按 lum 复用 Linear 基线,只覆写 background/foreground/selection;
   search 高亮随各主题的交互色(accent)走。 */

/** 暗色家族 term:覆写底/前景/选中(光标保持 RX 青)。 */
function darkTerm(bg: string, fg: string, selection: string): ITheme {
  return { ...LINEAR_TERM, background: bg, foreground: fg, cursorAccent: bg, selectionBackground: selection };
}

/** 亮色家族 term:覆写底/前景/选中(光标保持深 RX 青)。 */
function lightTerm(bg: string, fg: string, selection: string): ITheme {
  return { ...LINEAR_LIGHT_TERM, background: bg, foreground: fg, cursorAccent: bg, selectionBackground: selection };
}

/** search 高亮:match/active/border 三色 + overview ruler 复用前后两色。 */
function searchColors(match: string, active: string, border: string): ISearchDecorationOptions {
  return {
    matchBackground: match,
    activeMatchBackground: active,
    activeMatchBorder: border,
    matchOverviewRuler: match,
    activeMatchColorOverviewRuler: border,
  };
}

/** 主题注册表(有序,toggle 按此循环;主题菜单平铺按此顺序展示)。
 *  as const 保住字面量联合类型,satisfies 只做结构校验、不拓宽类型。
 *  新主题三处登记:此处 + styles.css token 块 + index.html 首帧脚本。 */
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
  {
    id: "apple",
    label: "Apple · 暗",
    family: "Apple",
    lum: "dark",
    term: darkTerm("#101012", "#f5f5f7", "rgba(41,151,255,0.30)"),
    search: searchColors("#17324f", "#23507e", "#4a9bff"),
    cm: LINEAR_CM,
  },
  {
    id: "apple-light",
    label: "Apple · 亮",
    family: "Apple",
    lum: "light",
    term: lightTerm("#ffffff", "#1d1d1f", "rgba(0,102,204,0.16)"),
    search: searchColors("#d8e6f6", "#b3d0f0", "#0066cc"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "raycast",
    label: "Raycast · 暗",
    family: "Raycast",
    lum: "dark",
    term: darkTerm("#050607", "#f4f4f6", "rgba(255,255,255,0.20)"),
    search: searchColors("#2a2c2e", "#46494c", "#6a6e72"),
    cm: LINEAR_CM,
  },
  {
    id: "raycast-light",
    label: "Raycast · 亮",
    family: "Raycast",
    lum: "light",
    term: lightTerm("#ffffff", "#171717", "rgba(23,23,23,0.12)"),
    search: searchColors("#e3e5e8", "#c9ccd1", "#8a8f96"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "superhuman",
    label: "Superhuman · 暗",
    family: "Superhuman",
    lum: "dark",
    term: darkTerm("#0b0a1a", "#ffffff", "rgba(201,180,250,0.25)"),
    search: searchColors("#33304d", "#554e8a", "#8f86c9"),
    cm: LINEAR_CM,
  },
  {
    id: "superhuman-light",
    label: "Superhuman · 亮",
    family: "Superhuman",
    lum: "light",
    term: lightTerm("#fdfdfc", "#292827", "rgba(27,25,56,0.16)"),
    search: searchColors("#e5e2ec", "#cbc6dd", "#6a5fc1"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "claude",
    label: "Claude · 暗",
    family: "Claude",
    lum: "dark",
    term: darkTerm("#141310", "#faf9f5", "rgba(204,120,92,0.28)"),
    search: searchColors("#3a2e26", "#6e4a35", "#cc785c"),
    cm: LINEAR_CM,
  },
  {
    id: "claude-light",
    label: "Claude · 亮",
    family: "Claude",
    lum: "light",
    term: lightTerm("#fbfaf6", "#141413", "rgba(204,120,92,0.20)"),
    search: searchColors("#f0e1d7", "#e2c3b0", "#a9583e"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "cursor",
    label: "Cursor · 亮",
    family: "Cursor",
    lum: "light",
    term: lightTerm("#fcfcfa", "#26251e", "rgba(245,78,0,0.18)"),
    search: searchColors("#f7e3d7", "#f0c4a8", "#f54e00"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "stripe",
    label: "Stripe · 亮",
    family: "Stripe",
    lum: "light",
    term: lightTerm("#fbfcfe", "#0d253d", "rgba(83,58,253,0.16)"),
    search: searchColors("#e4defc", "#cbc2f8", "#533afd"),
    cm: LINEAR_LIGHT_CM,
  },
  {
    id: "sentry",
    label: "Sentry · 暗",
    family: "Sentry",
    lum: "dark",
    term: darkTerm("#120d1e", "#ffffff", "rgba(194,239,78,0.22)"),
    search: searchColors("#2c3a18", "#4c6420", "#c2ef4e"),
    cm: LINEAR_CM,
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
  // data-lum 随行:styles.css 浅色家族共用层(信号色/组件特例)挂在这一属性上,
  // 免去每个浅色主题往十几条选择器里加 id(首帧脚本持有一份等价映射)。
  document.documentElement.dataset.lum = themeDefOf(t).lum;
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

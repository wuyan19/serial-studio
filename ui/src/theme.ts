/**
 * The workspace offers two themes. Historical palette definitions remain available
 * only to migrate saved identifiers by luminance and preserve internal type compatibility.
 * index.html performs the same migration before paint; this module synchronizes
 * terminal, search and editor colors with DOM attributes, storage and subscribers.
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

// Historical palettes remain registered so stored identifiers can migrate by luminance.
export const THEMES = [
  {
    id: "codex",
    label: "Codex · 暗",
    family: "Codex",
    lum: "dark",
    term: {
      background: "#1b1b1b", foreground: "#e0e0e0",
      cursor: "#e0e0e0", cursorAccent: "#1b1b1b",
      selectionBackground: "#294052",
      black: "#191918", brightBlack: "#a2a29a",
      red: "#e49c95", brightRed: "#efb3ac",
      green: "#92cba2", brightGreen: "#b5ddbe",
      yellow: "#e1b878", brightYellow: "#efd1a3",
      blue: "#a3bedb", brightBlue: "#c2d4e7",
      magenta: "#cbaaca", brightMagenta: "#ddc6dc",
      cyan: "#9bcac5", brightCyan: "#bbddd9",
      white: "#eeeee9", brightWhite: "#ffffff",
    },
    search: searchColors("#49493e", "#6d6d54", "#ceceab"),
    cm: {
      keyword: "#cbaaca", string: "#92cba2", number: "#e1b878",
      comment: "#a2a29a", func: "#a3bedb", type: "#9bcac5", defVar: "#eeeee9",
    },
  },
  {
    id: "codex-light",
    label: "Codex · 亮",
    family: "Codex",
    lum: "light",
    term: {
      background: "#ffffff", foreground: "#252524",
      cursor: "#252524", cursorAccent: "#ffffff",
      selectionBackground: "#dbe8f2",
      black: "#252524", brightBlack: "#656560",
      red: "#aa423b", brightRed: "#a53830",
      green: "#31734e", brightGreen: "#28653e",
      yellow: "#946217", brightYellow: "#80520c",
      blue: "#436b99", brightBlue: "#345c8a",
      magenta: "#875786", brightMagenta: "#764675",
      cyan: "#397471", brightCyan: "#2b6562",
      white: "#454542", brightWhite: "#252524",
    },
    search: searchColors("#ecebd2", "#dcd9a6", "#777349"),
    cm: {
      keyword: "#875786", string: "#31734e", number: "#946217",
      comment: "#656560", func: "#436b99", type: "#397471", defVar: "#252524",
    },
  },
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

export const APPEARANCE_THEMES = [
  { id: "codex", label: "深色", lum: "dark" },
  { id: "codex-light", label: "浅色", lum: "light" },
] as const;

// Keep this migration aligned with the pre-paint script in index.html.
const LEGACY_THEME_MAP: Record<string, Theme> = {
  dark: "codex",
  light: "codex-light",
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
    ? "codex-light"
    : "codex";
}

function readDom(): Theme {
  const t = document.documentElement.dataset.theme ?? "";
  if (isTheme(t)) return normalizeTheme(t);
  return LEGACY_THEME_MAP[t] ?? systemTheme();
}

let current: Theme = readDom();
if (document.documentElement.dataset.theme !== current) {
  document.documentElement.dataset.theme = current;
  document.documentElement.dataset.lum = themeDefOf(current).lum;
  try { localStorage.setItem(KEY, current); } catch { /* Storage may be disabled. */ }
}

export function getTheme(): Theme {
  return current;
}

export function normalizeTheme(t: Theme): Theme {
  return themeDefOf(t).lum === "light" ? "codex-light" : "codex";
}

export function setTheme(t: Theme) {
  t = normalizeTheme(t);
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

// Keyboard switching uses the same two choices as the appearance panel.
export function toggleTheme() {
  setTheme(current === "codex" ? "codex-light" : "codex");
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

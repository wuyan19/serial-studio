/** 壳层布局模式：标题栏「自定义布局」菜单的预设。
 *  四预设对应 IconLayout 四变体（用户参考图定稿）——侧栏是否在场由
 *  图形本身编码（左通高块/侧栏列 = 在场；纯行/列 = 隐藏，专注终端工作）。
 *  切换即时生效，localStorage 持久化（devicerack-layout）。 */
export type LayoutMode = "standard" | "term-bottom" | "rows" | "columns";

const LAYOUT_KEY = "devicerack-layout";

export interface LayoutPreset {
  mode: LayoutMode;
  label: string;
  hint: string;
}

/** 菜单呈现序（IconLayoutMain/IconLayout/IconLayoutRows/IconLayoutColumns 同序）。 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { mode: "standard", label: "标准", hint: "侧栏 + 主区 + 终端右栏" },
  { mode: "term-bottom", label: "底部终端", hint: "侧栏通高 + 主区上 + 终端下" },
  { mode: "rows", label: "上下分栏", hint: "主区上 + 终端下（隐藏侧栏）" },
  { mode: "columns", label: "左右分栏", hint: "主区与终端左右分栏，拖动调比例（隐藏侧栏）" },
];

const ALL: LayoutMode[] = ["standard", "term-bottom", "rows", "columns"];

export function loadLayoutMode(): LayoutMode {
  try {
    const v = localStorage.getItem(LAYOUT_KEY) as LayoutMode | null;
    if (v && ALL.includes(v)) return v;
  } catch {
    /* 损坏回退默认 */
  }
  return "standard";
}

export function saveLayoutMode(mode: LayoutMode) {
  try {
    localStorage.setItem(LAYOUT_KEY, mode);
  } catch {
    /* 存储不可用只丢偏好，不影响当次会话 */
  }
}

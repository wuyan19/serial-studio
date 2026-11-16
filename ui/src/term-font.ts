/**
 * 终端字号（全局，所有端口共用）。
 * Ctrl + +/-/0 在各终端的 attachCustomKeyEventHandler 里调用这里；
 * TermView 订阅变化，改 term.options.fontSize 并 fit() 重排。
 */
const KEY = "serial-studio-fontsize";
export const FONT_DEFAULT = 15;
/** 字号允许范围（设置页输入框 min/max 同源）。 */
export const FONT_MIN = 6;
export const FONT_MAX = 48;

type Listener = (n: number) => void;
const listeners = new Set<Listener>();

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) return Math.min(FONT_MAX, Math.max(FONT_MIN, n));
    }
  } catch {
    /* ignore */
  }
  return FONT_DEFAULT;
}

let current = load();

function syncUiFont(n: number) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--ui-font-size", `${Math.min(20, Math.max(12, n))}px`);
}

syncUiFont(current);

function clamp(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

export function getFontSize(): number {
  return current;
}

export function setFontSize(n: number) {
  if (!Number.isFinite(n)) return;
  const c = clamp(n);
  if (c === current) return;
  current = c;
  syncUiFont(current);
  try {
    localStorage.setItem(KEY, String(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(current));
}

export function zoomIn() {
  setFontSize(current + 1);
}
export function zoomOut() {
  setFontSize(current - 1);
}
export function resetFontSize() {
  setFontSize(FONT_DEFAULT);
}

export function subscribeFont(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

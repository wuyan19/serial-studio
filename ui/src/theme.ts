/**
 * 主题（亮/暗）模块。
 * 真 source of truth 是 <html data-theme>，由 index.html 内联脚本在首帧前写入（防闪烁）。
 * 这里只做：读取当前值、切换（写 localStorage + 改属性 + 通知订阅者）。
 * 订阅者：App 的切换按钮图标、TermView 的 xterm 配色。
 */
export type Theme = "dark" | "light";

const KEY = "serial-studio-theme";
type Listener = (t: Theme) => void;
const listeners = new Set<Listener>();

function readDom(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "dark";
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

export function toggleTheme() {
  setTheme(current === "dark" ? "light" : "dark");
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

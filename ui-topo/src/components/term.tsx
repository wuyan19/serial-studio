/** 终端视图：serial-studio term.tsx 的单终端简化移植（同一主题/fit/选中复制
 * 交互；去掉分组面板树、DOM reparent、快捷键系统——那是终端工具形态的复杂度）。
 * 写闸说明：浏览器会话是"人"，不经 MCP 闸；占用由人自行协调（占用中心可强收 AI）。 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { copyText } from "../lib";
import { getTheme, subscribe, themeDefOf } from "../theme";

const MONO_STACK =
  "'IBM Plex Mono', 'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace";

export interface TermHandle {
  write: (data: Uint8Array | string) => void;
  focus: () => void;
}

export default function TermView({
  port,
  onWrite,
  onResize,
  onReady,
}: {
  port: string;
  onWrite: (port: string, data: string) => void;
  onResize?: (port: string, cols: number, rows: number) => void;
  onReady?: (h: TermHandle) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: themeDefOf(getTheme()).term,
      allowProposedApi: true,
      scrollback: 10000,
      scrollOnUserInput: false,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // 选中即复制（hasSelection 守卫：取消选择不清剪贴板）
    const sel = term.onSelectionChange(() => {
      if (!term.hasSelection()) return;
      const text = term.getSelection();
      if (text) void copyText(text);
    });
    const disposable = term.onData((data) => {
      term.scrollToBottom();
      onWrite(port, data);
    });
    const fitAndReport = () => {
      try {
        fit.fit();
      } catch {
        /* 容器未可见 */
      }
      onResizeRef.current?.(port, term.cols, term.rows);
    };
    const timer = setTimeout(fitAndReport, 50);
    const ro = new ResizeObserver(fitAndReport);
    ro.observe(container);
    // 主题热切换：xterm canvas 不吃 CSS 变量，按注册表取纯色重应用
    const offTheme = subscribe((t) => term.options.theme === undefined || (term.options.theme = themeDefOf(t).term));
    onReady?.({
      write: (data) => term.write(data),
      focus: () => term.focus(),
    });
    term.focus();
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      sel.dispose();
      disposable.dispose();
      offTheme();
      term.dispose();
    };
  }, [port, onWrite, onReady]);

  return <div ref={containerRef} className="term-single" />;
}

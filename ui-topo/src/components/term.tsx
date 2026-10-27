/** 终端视图：serial-studio term.tsx 的单终端简化移植。
 *  回调一律经 ref 转发（老 app 的 onResizeRef 同款）——effect 依赖只有 [port]，
 *  父组件重渲染不得触发 xterm 重建：重建会丢 scrollback、抢回焦点（页面"无法
 *  操作"的元凶），端口表推送一來即风暴。 */
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
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onWriteRef.current = onWrite;
    onResizeRef.current = onResize;
    onReadyRef.current = onReady;
  });

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
      onWriteRef.current(port, data);
    });
    const fitAndReport = () => {
      try {
        fit.fit();
      } catch {
        /* 容器未可见（display:none 的非活动 tab） */
      }
      onResizeRef.current?.(port, term.cols, term.rows);
    };
    const timer = setTimeout(fitAndReport, 50);
    const ro = new ResizeObserver(fitAndReport);
    ro.observe(container);
    // 主题热切换：xterm 不吃 CSS 变量，按注册表取纯色重应用
    const offTheme = subscribe((t) => {
      term.options.theme = themeDefOf(t).term;
    });
    onReadyRef.current?.({
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
  }, [port]);

  return <div ref={containerRef} className="term-single" />;
}

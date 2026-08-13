import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm"; // xterm.css 经 styles.css 统一引入
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
import type {
  ActionId,
  ConnConfig,
  Group,
  Macro,
  MacroStep,
  PaneHalf,
  PortId,
  PortInfo,
  Script,
  ScriptParam,
  SerialConfig,
  ShortcutMap,
  SrvSettings,
  StepType,
  TermInstance,
} from "./types";
import { BAUD_RATES, downloadJson, isTauri, parsePortId, parseParamsFromCode } from "./lib";
import { getTheme, subscribe, type Theme } from "./theme";
import { getFontSize, subscribeFont, zoomIn, zoomOut, resetFontSize } from "./term-font";
import {
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  eventToCombo,
  formatCombo,
  getBindings,
  resetAll,
  resetBinding,
  setBinding,
  subscribeBindings,
} from "./shortcuts";
import {
  IconAlert,
  IconBolt,
  IconCode,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconCopy,
  IconExport,
  IconGear,
  IconGlobe,
  IconGrip,
  IconPlug,
  IconPlus,
  IconTrash,
} from "./icons";

// ===== 通用 =====

export function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      {children}
    </div>
  );
}

/** 裸 Esc 关闭对话框（无修饰符）。给仅靠按钮关闭、无 Enter 语义的通用对话框用。
 *  模态打开期间 App 全局 listener 已被抑制，不会与之冲突。 */
// Esc/Enter 走 capture:终端聚焦时 xterm 会在 bubble 阶段吃掉 Esc(About 无 autoFocus、
// 从终端用快捷键打开后 Esc 关不掉),capture 先于 xterm 触发,焦点在不在对话框里都能关。
export function useEscClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

/** 对话框通用键：Esc 关闭、回车触发主操作（同 AliasDialog 语义）。
 *  回车是 window 级监听，故点击输入框编辑后按回车仍能触发主操作（不依赖按钮焦点）。 */
export function useDialogKeys({ onClose, onEnter }: { onClose: () => void; onEnter?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && onEnter) {
        e.preventDefault();
        onEnter();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onEnter]);
}

/** 端口名展示：有别名时显「别名(真名)」，真名走 .port-label__raw 浅色；无别名仅显真名。
 *  端口行 / tab / 通道条共用，避免三处重复 JSX。 */
export function PortLabel({ name, alias }: { name: string; alias?: string }) {
  const a = alias?.trim();
  if (!a) return <span className="port-label">{name}</span>;
  return (
    <span className="port-label" title={`${a}（${name}）`}>
      {a}
      <span className="port-label__raw">({name})</span>
    </span>
  );
}

// ===== 终端视图 =====

/** xterm 主题：仪器风——teal(RX) 光标、graphite 画布，ANSI 色映射到信号调色板。 */
const TERM_THEME: ITheme = {
  background: "#0e1014",
  foreground: "#dde5ef",
  cursor: "#4fd6c2",
  cursorAccent: "#0e1014",
  selectionBackground: "rgba(79,214,194,0.22)",
  black: "#0e1014",
  brightBlack: "#5c6270",
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
  white: "#e6e9ef",
  brightWhite: "#ffffff",
};

const MONO_STACK =
  "'IBM Plex Mono', 'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace";

/** 亮色 xterm 配色：象牙底 + 深石墨字 + 深青光标。canvas 不吃 CSS 变量，故单独定义。 */
const TERM_THEME_LIGHT: ITheme = {
  background: "#fbfaf5",
  foreground: "#2c2f36",
  cursor: "#0c7f73",
  cursorAccent: "#fbfaf5",
  selectionBackground: "rgba(12,127,115,0.18)",
  black: "#fbfaf5",
  brightBlack: "#8b9099",
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

function termThemeFor(t: Theme): ITheme {
  return t === "light" ? TERM_THEME_LIGHT : TERM_THEME;
}

export function TermView({
  port,
  visible,
  focused,
  targetContainer,
  onWrite,
  onReady,
  disconnected,
  onReconnect,
}: {
  port: string;
  visible: boolean;
  focused: boolean;
  /** 所属 group 的终端容器：本组件根 div 用 appendChild 挪进去（DOM reparent）。
   *  跨 group 搬 tab 只换此目标、组件不重建、xterm 实例不动 → 保 scrollback。 */
  targetContainer: HTMLElement | null;
  onWrite: (port: string, data: string) => void;
  onReady: (inst: TermInstance | null) => void;
  /** 该端口是否处于设备断开态(单键 R 重连仅此态触发)。 */
  disconnected?: boolean;
  /** 单键 R 重连回调(TermView 在断开态拦截 R)。 */
  onReconnect?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // 断开态 + 重连回调经 ref:customKeyEventHandler 在 [port] effect 内,直接闭包 props 会 stale
  const disconnectedRef = useRef(disconnected ?? false);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => { disconnectedRef.current = disconnected ?? false; }, [disconnected]);
  useEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);

  // DOM reparent：把本根 div 挪到所属 group 的终端容器。targetContainer 变（跨 group 搬）→ 重挪。
  // 用 useLayoutEffect：在 paint 前挪，避免 term-pool 闪现；xterm 实例不重建，canvas 跟随根 div 移动。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && targetContainer && el.parentNode !== targetContainer) {
      targetContainer.appendChild(el);
    }
    return () => {
      // 卸载（或换 target 重 reparent）前把根 div 移回 term-pool：React 按 fiber 记忆的位置
      // (term-pool) removeChild，若此时 DOM 在 group 容器里会找不到节点 → 崩溃白屏。先归位再删。
      const el2 = containerRef.current;
      const pool = document.querySelector(".term-pool");
      if (el2 && pool && el2.parentNode !== pool) pool.appendChild(el2);
    };
  }, [targetContainer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: getFontSize(),
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: termThemeFor(getTheme()),
      allowProposedApi: true,
      scrollback: 10000,
      // 向上滚动(离开底部)后输入不再自动跳回底部：xterm 默认 scrollOnUserInput=true，
      // 会因任意 keydown(含单独按 Ctrl)把滚动位置打回最新。看最新输出用滚轮滚到底 / ⌘+End。
      scrollOnUserInput: false,
      minimumContrastRatio: 4.5, // WCAG AA：兜底所有 ANSI 着色文本对比度（提纯前景之外的第二道闸）
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);
    // 字体缩放：combo 实时读注册表（改键即时生效，免重建终端）。
    // terminal 作用域，不经全局 listener / 菜单；不匹配一律放行给 xterm 作串口输入。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const combo = eventToCombo(e);
      if (!combo) return true;
      const m = getBindings();
      if (combo === m["zoom.in"].combo) {
        e.preventDefault();
        zoomIn();
        return false;
      }
      if (combo === m["zoom.out"].combo) {
        e.preventDefault();
        zoomOut();
        return false;
      }
      if (combo === m["zoom.reset"].combo) {
        e.preventDefault();
        resetFontSize();
        return false;
      }
      // 单键 R 重连:仅断开态触发(connected 态 R 是普通串口输入,放行)
      if (disconnectedRef.current && combo === m["port.reconnect"].combo) {
        e.preventDefault();
        onReconnectRef.current?.();
        return false;
      }
      return true;
    });
    fitRef.current = fit;
    termRef.current = term;
    onReady({ term, fit, search });
    const disposable = term.onData((data) => {
      // 发命令(回车)后回到底部看回显：scrollOnUserInput=false 已停用"任意输入跳底"(连 Ctrl 也误触)，
      // 这里只对回车显式滚底；Ctrl 等修饰键单独按不再误触。滚到底后回显到达会自然跟随。
      if (data.includes("\r")) term.scrollToBottom();
      onWrite(port, data);
    });
    const timer = setTimeout(() => {
      try {
        fit.fit();
        if (focused) term.focus();
      } catch {
        /* 容器未可见 */
      }
    }, 50);
    return () => {
      clearTimeout(timer);
      disposable.dispose();
      term.dispose();
      fitRef.current = null;
      termRef.current = null;
      onReady(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // 主题切换 → 同步 xterm canvas 配色（canvas 不吃 CSS 变量）
  useEffect(() => {
    return subscribe((t) => {
      if (termRef.current) termRef.current.options.theme = termThemeFor(t);
    });
  }, []);

  // 字号变化（Ctrl + +/-/0）→ 应用到本终端并 fit() 重排列数
  useEffect(() => {
    return subscribeFont((n) => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontSize = n;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    });
  }, []);

  // 聚焦本终端（聚焦 group 的活动 tab）：fit 重排列 + 抢焦点
  useEffect(() => {
    if (focused && fitRef.current) {
      const timer = setTimeout(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [focused]);

  // 容器尺寸变化（窗口缩放、分栏拖动、兄弟 group 坍缩）→ 重排可见终端。
  // 替代原「仅 active 挂 window resize」：分栏下多个终端同时可见，window resize 抓不到分栏尺寸变化。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!visible) return; // display:none 时尺寸为 0，fit 会算错/抛
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  return <div ref={containerRef} className="termview-root" style={{ position: "absolute", inset: 0, display: visible ? "block" : "none" }} />;
}

// ===== editor group（一个「标签栏 + 终端区」分栏格子） =====

/** 计算拖拽落点相对容器的四半区（扩宏 DnD rect 中点到二维：|dx|/w vs |dy|/h 判主方向）。 */
function dropHalfOf(clientX: number, clientY: number, el: HTMLElement): PaneHalf {
  const r = el.getBoundingClientRect();
  const dx = (clientX - r.left) - r.width / 2;
  const dy = (clientY - r.top) - r.height / 2;
  return Math.abs(dx) / r.width > Math.abs(dy) / r.height
    ? (dx > 0 ? "right" : "left")
    : (dy > 0 ? "down" : "up");
}

/** 一个分栏格子：自己的标签栏 + 终端区（模型 = VS Code 的 editor group）。
 *  受控视图——端口数据与生命周期在 App，本组件不持有。
 *  TermView 由 App 经 DOM reparent 挪入终端容器（不在此直渲染），跨 group 搬 tab 不重建、保 scrollback。
 *  终端区拖拽用原生事件（reparent 后合成事件不冒泡到此容器）。 */
export function GroupView({
  group,
  focused,
  aliasEditTab,
  aliasOf,
  sourceLabelOf,
  disconnectedOf,
  onReconnectTab,
  onSwitchTab,
  onCloseTab,
  onRenameTab,
  onCommitAlias,
  onCancelAlias,
  onFocusGroup,
  onWrite,
  onReady,
  searchOpen,
  activeTerm,
  onCloseSearch,
  onDragOverHalf,
  onDragLeave,
  onDropHalf,
  onDropOnTabs,
  dropHint,
  termContainerRef,
}: {
  group: Group;
  focused: boolean;
  aliasEditTab: { port: string } | null;
  aliasOf: (port: string) => string | undefined;
  /** Tab 来源标识（多设备时非本地端口后缀设备昵称/地址）；undefined = 不显示。 */
  sourceLabelOf?: (port: string) => string | undefined;
  /** 该端口是否处于"设备断开"态(灰显 + 显示重连按钮)。 */
  disconnectedOf?: (port: string) => boolean;
  /** 重连断开的 tab。 */
  onReconnectTab?: (port: string) => void;
  onSwitchTab: (port: string) => void;
  onCloseTab: (port: string) => void;
  onRenameTab: (port: string) => void;
  onCommitAlias: (port: string, alias: string) => void;
  onCancelAlias: () => void;
  onFocusGroup: () => void;
  onWrite: (port: string, data: string) => void;
  onReady: (port: string, inst: TermInstance | null) => void;
  searchOpen: boolean;
  activeTerm: TermInstance | undefined;
  onCloseSearch: () => void;
  /** 拖拽悬停在 group 终端区：上报 groupId + 半区（高亮）。 */
  onDragOverHalf: (groupId: string, half: PaneHalf) => void;
  /** 拖拽离开 / 结束：清高亮。 */
  onDragLeave: () => void;
  /** 拖拽落到 group 终端区半区：创建新 group 并分裂。 */
  onDropHalf: (port: string, srcGroupId: string, dstGroupId: string, half: PaneHalf) => void;
  /** 当前拖拽高亮提示（{overGroupId, overHalf} | null）。 */
  dropHint: { overGroupId: string; overHalf: PaneHalf } | null;
  /** 拖 tab 到本 group 标签栏：迁移 port 归属到本 group。 */
  onDropOnTabs: (port: string, srcGroupId: string, dstGroupId: string) => void;
  /** 终端容器 DOM 就绪/卸载上报（App 把 TermView 经 DOM reparent 挪入，跨 group 搬 tab 保 scrollback）。 */
  termContainerRef: (el: HTMLDivElement | null) => void;
}) {
  const termRef = useRef<HTMLDivElement>(null);
  // 拖拽回调走 ref：listener 只挂一次（[group.id]），避 prop 每渲染变化导致 stale
  const dndRef = useRef({ onDragOverHalf, onDragLeave, onDropHalf, onFocusGroup });
  dndRef.current = { onDragOverHalf, onDragLeave, onDropHalf, onFocusGroup };
  useLayoutEffect(() => {
    const el = termRef.current;
    if (!el) return;
    termContainerRef(el); // 容器就绪上报（卸载清），App 据此 reparent TermView
    // 点终端区聚焦本 group：reparent 后 TermView 的合成 mousedown 不冒泡到此（同 DnD），用原生监听
    const onDown = () => dndRef.current.onFocusGroup();
    el.addEventListener("mousedown", onDown);
    // 原生 DnD：reparent 后 TermView DOM 在此容器，但合成事件不冒泡到此（React 树父是 App/池），必须原生监听
    const onOver = (ev: DragEvent) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      dndRef.current.onDragOverHalf(group.id, dropHalfOf(ev.clientX, ev.clientY, el));
    };
    const onLeave = () => dndRef.current.onDragLeave();
    const onDropEv = (ev: DragEvent) => {
      ev.preventDefault();
      const raw = ev.dataTransfer?.getData("text/x-port") ?? "";
      if (raw) {
        try {
          const { port, src } = JSON.parse(raw) as { port: string; src: string };
          dndRef.current.onDropHalf(port, src, group.id, dropHalfOf(ev.clientX, ev.clientY, el));
        } catch {
          /* ignore */
        }
      }
      dndRef.current.onDragLeave();
    };
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDropEv);
    return () => {
      termContainerRef(null);
      // 卸载前把 reparent 进来的 TermView 根 div 移回 term-pool：否则本容器删除会带走它们，
      // React 随后卸载 TermView 时 DOM 已不在预期父节点 → 崩溃白屏
      const pool = document.querySelector(".term-pool");
      if (pool) el.querySelectorAll<HTMLElement>(".termview-root").forEach((t) => pool.appendChild(t));
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDropEv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);
  return (
    <div className="group" data-focused={focused} onMouseDownCapture={onFocusGroup}>
      <div
        className="group__tabs tab-bar"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/x-port")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData("text/x-port");
          if (raw) {
            try {
              const { port, src } = JSON.parse(raw) as { port: string; src: string };
              onDropOnTabs(port, src, group.id);
            } catch {
              /* ignore */
            }
          }
        }}
      >
        {group.ports.length === 0 && <span className="tab-bar__empty">未打开端口</span>}
        {group.ports.map((port) => {
          const isActive = port === group.activePort;
          const editingThis = aliasEditTab?.port === port;
          const portName = parsePortId(port).name;
          const src = sourceLabelOf?.(port);
          const disconnected = disconnectedOf?.(port) ?? false;
          return (
            <div
              key={port}
              className="tab"
              data-active={isActive}
              data-disconnected={disconnected ? "true" : undefined}
              data-editing={editingThis ? "true" : undefined}
              draggable={!editingThis}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/x-port", JSON.stringify({ port, src: group.id }));
                e.dataTransfer.setData("text/plain", port); // 部分 webview 需 text/plain 才进 drop
              }}
              onDragEnd={onDragLeave}
              onClick={() => {
                if (!editingThis) onSwitchTab(port);
              }}
              onDoubleClick={() => onRenameTab(port)}
              title={`切换 ${portName}${src ? " · " + src : ""}（双击改名）`}
            >
              <span className="tab__dot" />
              <span className="tab__name">
                {editingThis ? (
                  <InlineAliasInput
                    initial={aliasOf(port) ?? ""}
                    placeholder={`为 ${portName} 设置别名`}
                    onCommit={(alias) => onCommitAlias(port, alias)}
                    onCancel={onCancelAlias}
                  />
                ) : (
                  <>
                    <PortLabel name={portName} alias={aliasOf(port)} />
                    {src && <span className="tab__src">{src}</span>}
                  </>
                )}
              </span>
              <span
                className="tab__btn tab__btn--close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(port);
                }}
                title={`关闭 ${portName}`}
              >
                <IconClose />
              </span>
              {disconnected && (
                <span
                  className="tab__btn tab__btn--reconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReconnectTab?.(port);
                  }}
                  title={`重连 ${portName} (${formatCombo(getBindings()["port.reconnect"].combo)})`}
                >
                  <IconPlug />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div ref={termRef} className="group__term term-area">
        {/* TermView 由 App 经 DOM reparent(appendChild)挪入此容器（不在本组件渲染），
            跨 group 搬 tab 不重建、保 scrollback。拖拽用原生事件（见 useLayoutEffect）。 */}
        {group.ports.length === 0 && (
          <div className="term-empty">
            <IconPlug className="term-empty__icon" />
            <div>从左侧 PORTS 打开一个串口开始收发</div>
          </div>
        )}
        {focused && searchOpen && activeTerm?.search && (
          <SearchBar searchAddon={activeTerm.search} term={activeTerm.term} onClose={onCloseSearch} />
        )}
        {/* 拖拽落点四半区高亮 */}
        {dropHint?.overGroupId === group.id && <div className="group__dropzone" data-half={dropHint.overHalf} />}
      </div>
    </div>
  );
}

// ===== 终端内搜索（Ctrl+F）=====

/** 搜索高亮配色（xterm 要求纯 #RRGGBB，故按主题各给一组，跟着 token 的青系）。 */
function searchDecorations(t: Theme): ISearchDecorationOptions {
  if (t === "light") {
    return {
      matchBackground: "#cce3df",
      activeMatchBackground: "#7fc7bd",
      activeMatchBorder: "#0c7f73",
      matchOverviewRuler: "#cce3df",
      activeMatchColorOverviewRuler: "#0c7f73",
    };
  }
  return {
    matchBackground: "#1c4a45",
    activeMatchBackground: "#11837a",
    activeMatchBorder: "#4fd6c2",
    matchOverviewRuler: "#1c4a45",
    activeMatchColorOverviewRuler: "#4fd6c2",
  };
}

export function SearchBar({
  searchAddon,
  term,
  onClose,
}: {
  searchAddon: SearchAddon;
  term: Terminal;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const doSearch = useCallback(
    (dir: "next" | "prev", incremental = false) => {
      if (!query) {
        searchAddon.clearDecorations();
        setIndex(0);
        setCount(0);
        setError(false);
        return;
      }
      const opts = {
        regex,
        caseSensitive,
        wholeWord,
        incremental,
        decorations: searchDecorations(getTheme()),
      };
      try {
        if (dir === "next") {
          // 无既有命中时，把选区种子播到当前视口顶部：addon 的 findNext 默认从 row 0
          // （scrollback 最开头）起搜，这里让它从"当前可见窗口"起搜，符合直觉。
          // 该 select 在同一次同步调用内被 addon 读到后立即 clearSelection 清掉，不会闪现。
          if (!term.getSelectionPosition()) {
            term.select(0, term.buffer.active.viewportY, 1);
          }
          searchAddon.findNext(query, opts);
        } else {
          searchAddon.findPrevious(query, opts);
        }
        setError(false);
      } catch {
        setError(true); // 多半是非法正则
      }
    },
    [query, regex, caseSensitive, wholeWord, searchAddon, term]
  );

  // 输入/选项变化 → 重新搜索（增量）
  useEffect(() => {
    doSearch("next", true);
  }, [doSearch]);

  // 主题切换 → 重绘高亮（配色随主题）
  useEffect(() => subscribe(() => doSearch("next", true)), [doSearch]);

  // 命中计数
  useEffect(() => {
    const d = searchAddon.onDidChangeResults((e) => {
      setIndex(e.resultIndex);
      setCount(e.resultCount);
    });
    return () => d.dispose();
  }, [searchAddon]);

  // 打开即聚焦输入
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 关闭/卸载时清掉高亮与选区，恢复终端原状
  useEffect(() => {
    return () => {
      try {
        searchAddon.clearDecorations();
      } catch {
        /* addon 可能正随终端一起销毁 */
      }
    };
  }, [searchAddon]);

  const next = () => {
    doSearch("next");
    inputRef.current?.focus();
  };
  const prev = () => {
    doSearch("prev");
    inputRef.current?.focus();
  };

  const countText = !query ? "" : count === 0 ? "无匹配" : index < 0 ? `${count}+` : `${index + 1} / ${count}`;

  return (
    <div className="searchbar">
      <button className="searchbar__toggle" data-on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="区分大小写">
        Aa
      </button>
      <button className="searchbar__toggle" data-on={regex} onClick={() => setRegex((v) => !v)} title="正则表达式">
        .*
      </button>
      <button className="searchbar__toggle" data-on={wholeWord} onClick={() => setWholeWord((v) => !v)} title="整词">
        W
      </button>
      <input
        ref={inputRef}
        className={`searchbar__input${error ? " searchbar__input--err" : ""}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="搜索终端…"
        spellCheck={false}
      />
      <span className="searchbar__count">{countText}</span>
      <button className="searchbar__btn" onClick={prev} title="上一个 (Shift+Enter)">
        <IconChevronUp />
      </button>
      <button className="searchbar__btn" onClick={next} title="下一个 (Enter)">
        <IconChevronDown />
      </button>
      <button className="searchbar__btn searchbar__close" onClick={onClose} title="关闭 (Esc)">
        <IconClose />
      </button>
    </div>
  );
}

// ===== 串口配置对话框 =====

export function SerialConfigDialog({
  port,
  config,
  initialAlias = "",
  onChange,
  onConfirm,
  onCancel,
}: {
  port: string;
  config: SerialConfig;
  /** 打开时携带的别名初值（端口已有别名则回填，便于编辑）。 */
  initialAlias?: string;
  onChange: (c: SerialConfig) => void;
  onConfirm: (c: SerialConfig, alias: string) => void;
  onCancel: () => void;
}) {
  useEscClose(onCancel);
  // 别名是端口语义（每端口独立），用内部状态；config 仍是受控（跨端口沿用）。
  // 调用方 key={port} 保证换端口时重挂、状态重置。
  const [alias, setAlias] = useState(initialAlias);
  const openRef = useRef<HTMLButtonElement>(null);
  // 默认聚焦「打开」：用默认串口参数时直接回车即开，免点鼠标。
  useEffect(() => {
    openRef.current?.focus();
  }, []);
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconPlug /> OPEN PORT
        </h3>
        <div className="dialog__sub">{port}</div>
        <ConfigRow label="别名">
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="可选，描述此端口连接的设备" className="field" />
        </ConfigRow>
        <ConfigRow label="波特率">
          <select value={config.baud_rate} onChange={(e) => onChange({ ...config, baud_rate: Number(e.target.value) })} className="field-select">
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </ConfigRow>
        <ConfigRow label="数据位">
          <select value={config.data_bits} onChange={(e) => onChange({ ...config, data_bits: e.target.value })} className="field-select">
            <option value="eight">8</option>
            <option value="seven">7</option>
            <option value="six">6</option>
            <option value="five">5</option>
          </select>
        </ConfigRow>
        <ConfigRow label="停止位">
          <select value={config.stop_bits} onChange={(e) => onChange({ ...config, stop_bits: e.target.value })} className="field-select">
            <option value="one">1</option>
            <option value="two">2</option>
          </select>
        </ConfigRow>
        <ConfigRow label="校验">
          <select value={config.parity} onChange={(e) => onChange({ ...config, parity: e.target.value })} className="field-select">
            <option value="none">None</option>
            <option value="odd">Odd</option>
            <option value="even">Even</option>
          </select>
        </ConfigRow>
        <ConfigRow label="流控">
          <select value={config.flow_control} onChange={(e) => onChange({ ...config, flow_control: e.target.value })} className="field-select">
            <option value="none">None</option>
            <option value="software">Software (XON/XOFF)</option>
            <option value="hardware">Hardware (RTS/CTS)</option>
          </select>
        </ConfigRow>
        <ConfigRow label="换行符">
          <select value={config.line_ending} onChange={(e) => onChange({ ...config, line_ending: e.target.value })} className="field-select">
            <option value="crlf">CRLF (\r\n) — Windows/AT</option>
            <option value="lf">LF (\n) — Linux/Unix</option>
            <option value="cr">CR (\r)</option>
          </select>
        </ConfigRow>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button ref={openRef} className="btn btn--primary" onClick={() => onConfirm(config, alias)}>
            打开
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 别名 inline 编辑 =====

/** 原地（inline）编辑端口别名：替换 PortLabel 显示，不弹模态。
 *  挂载即聚焦 + 全选；Enter / blur 提交，Esc 取消。值未变则仅关闭、不写盘。
 *  与旧 AliasDialog 同语义（空串=清除别名），键盘逻辑搬自其 keydown。
 *  调用方做「编辑态」条件渲染：editing ? <InlineAliasInput/> : <PortLabel/>。 */
export function InlineAliasInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (alias: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false); // 防 Enter/Esc 与 blur 重复收尾
  const armedRef = useRef(false); // 聚焦稳定后才响应 blur，跳过挂载/事件链里的误 blur

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // 下一帧再聚焦：点铅笔/双击的事件链未走完时立即 focus() 易被随后的焦点归位打断
    const id = requestAnimationFrame(() => {
      el.focus();
      el.select();
      armedRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const finish = (mode: "commit" | "cancel") => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (mode === "cancel") {
      onCancel();
      return;
    }
    const trimmed = value.trim();
    // 未改值：仅关闭，不写盘 / 不触发 meta 广播
    if (trimmed === initial.trim()) onCancel();
    else onCommit(trimmed);
  };

  return (
    <input
      ref={inputRef}
      className="alias-inline"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      // 点击不冒泡到 .port-item / .tab，避免编辑中触发切换端口
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish("commit");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish("cancel");
        }
      }}
      onBlur={() => {
        if (armedRef.current) finish("commit");
      }}
    />
  );
}

/** 分组标题行：折叠按钮 + 组名(可 inline 重命名) + 计数 + ⋯ 菜单(重命名/解散)。
 *  宏/脚本侧栏共用，封装组级交互；成员列表由调用方各自渲染。
 *  head 为 div（内含 ⋯ button 与 inline input，避免 button 嵌 button）——同 .port-group__head 模式。
 *  局部自管理 menuOpen/renaming 两个 UI 状态，不上升调用方。 */
export function GroupHead({
  name,
  count,
  collapsed,
  onToggle,
  onRename,
  onDissolve,
  menuHidden = false,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (newName: string) => void;
  onDissolve: () => void;
  /** 隐藏 ⋯ 菜单（「未分组」是聚合组——成员 group 字段为 undefined，重命名/解散无意义） */
  menuHidden?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);

  // 菜单/重命名态：点 head 外部收起（InlineAliasInput 的 blur 已自行提交，这里仅兜底关 UI）。
  useEffect(() => {
    if (!menuOpen && !renaming) return;
    const onDown = (e: MouseEvent) => {
      if (headRef.current && !headRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setRenaming(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, renaming]);

  return (
    <div className="macro-group__head" ref={headRef} onClick={renaming ? undefined : onToggle}>
      <span className="macro-group__caret">{collapsed ? "▶" : "▼"}</span>
      {renaming ? (
        <InlineAliasInput
          initial={name}
          placeholder="分组名"
          onCommit={(n) => {
            setRenaming(false);
            onRename(n);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className="macro-group__name">{name}</span>
      )}
      <span className="macro-group__count">{count}</span>
      {!renaming && !menuHidden && (
        <button
          className="macro-group__menu"
          title="分组操作"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div className="group-menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="group-menu__item"
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            重命名组
          </button>
          <button
            className="group-menu__item group-menu__item--danger"
            onClick={() => {
              setMenuOpen(false);
              onDissolve();
            }}
          >
            解散组
          </button>
        </div>
      )}
    </div>
  );
}

// ===== 宏批量导出对话框 =====

/** 多选导出宏：勾选若干（或全选）→ 导出单个 JSON（{名: 宏}，可再导入闭环）。
 *  对比编辑器内的单个导出，这里支持批量/全选。Enter 导出 / Esc 取消。 */
export function ExportMacrosDialog({
  macros,
  onConfirm,
  onCancel,
}: {
  macros: Record<string, Macro>;
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}) {
  const names = Object.keys(macros);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const all = names.length > 0 && selected.size === names.length;
  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleAll = () => setSelected(all ? new Set() : new Set(names));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && selected.size > 0) {
        e.preventDefault();
        onConfirm([...selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onConfirm, onCancel]);
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconExport /> EXPORT MACROS
        </h3>
        <div className="dialog__sub">勾选要导出的宏，导出为单个 JSON（可再导入）</div>
        <div className="export-list">
          <label className="export-list__all">
            <input type="checkbox" checked={all} onChange={toggleAll} />
            <span>{all ? "取消全选" : "全选"}</span>
            <span className="export-list__count">
              {selected.size}/{names.length}
            </span>
          </label>
          {names.map((name) => (
            <label key={name} className="export-list__item">
              <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
              <span className="export-list__name">{name}</span>
            </label>
          ))}
        </div>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn--primary"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            导出{selected.size > 0 ? ` ${selected.size} 个` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 多选导出脚本：勾选若干（或全选）→ 导出单个 JSON（{名: 脚本}，可再导入闭环）。
 *  镜像 ExportMacrosDialog。Enter 导出 / Esc 取消。 */
export function ExportScriptsDialog({
  scripts,
  onConfirm,
  onCancel,
}: {
  scripts: Record<string, Script>;
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}) {
  const names = Object.keys(scripts);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const all = names.length > 0 && selected.size === names.length;
  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleAll = () => setSelected(all ? new Set() : new Set(names));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && selected.size > 0) {
        e.preventDefault();
        onConfirm([...selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onConfirm, onCancel]);
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconExport /> EXPORT SCRIPTS
        </h3>
        <div className="dialog__sub">勾选要导出的脚本，导出为单个 JSON（可再导入）</div>
        <div className="export-list">
          <label className="export-list__all">
            <input type="checkbox" checked={all} onChange={toggleAll} />
            <span>{all ? "取消全选" : "全选"}</span>
            <span className="export-list__count">
              {selected.size}/{names.length}
            </span>
          </label>
          {names.map((name) => (
            <label key={name} className="export-list__item">
              <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
              <span className="export-list__name">{name}</span>
            </label>
          ))}
        </div>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn--primary"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            导出{selected.size > 0 ? ` ${selected.size} 个` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 设置面板 =====

export function SettingsPanel({
  connConfig,
  srvSettings,
  onConnChange,
  onSaveSrv,
  showServer,
  onOpenShortcuts,
  onClose,
}: {
  connConfig: ConnConfig;
  srvSettings: SrvSettings | null;
  onConnChange: (c: ConnConfig) => void;
  onSaveSrv: (s: SrvSettings) => void;
  showServer: boolean;
  onOpenShortcuts: () => void;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<ConnConfig>(connConfig);
  const [srv, setSrv] = useState<SrvSettings | null>(srvSettings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSrv(srvSettings);
  }, [srvSettings]);

  /** 应用：本地模式存服务设置并打「已应用」标；远程客户端模式应用连接。按钮和回车都走这里。 */
  const apply = () => {
    if (!showServer) {
      onConnChange(conn);
    } else if (srv) {
      onSaveSrv(srv);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  // 同 AliasDialog：默认聚焦首个输入框可直接键入；回车（任意焦点）触发主操作。
  useDialogKeys({ onClose, onEnter: apply });

  // 置于内容与按钮行之间（本地模式在 Telnet 端口下），两分支共用，避免重复。
  const shortcutEntry = (
    <button type="button" className="shortcut-entry" onClick={onOpenShortcuts}>
      <span>键盘快捷键</span>
      <span className="shortcut-entry__hint">自定义 / 改键</span>
    </button>
  );

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGear /> SETTINGS
        </h3>

        {!showServer && (
          <>
            <div className="dialog__group-label">连接（前端 → 服务器）</div>
            <ConfigRow label="主机">
              <input autoFocus value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} className="field" />
            </ConfigRow>
            <ConfigRow label="端口">
              <input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} className="field" />
            </ConfigRow>
            <p className="dialog__hint">改连别的远程 Serial Studio 服务</p>
            {shortcutEntry}
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onClose}>
                关闭
              </button>
              <button className="btn btn--primary" onClick={apply}>
                应用并重连
              </button>
            </div>
          </>
        )}

        {showServer && (
          <>
            <div className="dialog__group-label">服务器监听（热重启生效）</div>
            {srv ? (
              <>
                <ConfigRow label="监听地址">
                  <input autoFocus value={srv.ws_host} onChange={(e) => setSrv({ ...srv, ws_host: e.target.value })} className="field" />
                </ConfigRow>
                <ConfigRow label="WS 端口">
                  <input type="number" value={srv.ws_port} onChange={(e) => setSrv({ ...srv, ws_port: Number(e.target.value) })} className="field" />
                </ConfigRow>
                <ConfigRow label="Telnet 端口">
                  <input type="number" value={srv.telnet_port} onChange={(e) => setSrv({ ...srv, telnet_port: Number(e.target.value) })} className="field" />
                </ConfigRow>
                <ConfigRow label="远程脚本">
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={srv.enable_scripting}
                      onChange={(e) => setSrv({ ...srv, enable_scripting: e.target.checked })}
                    />
                    <span>允许远程执行 JS 脚本</span>
                    <span
                      title="默认关闭:服务器无认证,开启后任何能连到端口的客户端可执行脚本(沙箱仅限串口原语,无文件/网络访问)。暴露到非信任网络前,务必绑定 127.0.0.1 或加防火墙/VPN。"
                      style={{ cursor: "help" }}
                    >
                      ⚠
                    </span>
                  </label>
                </ConfigRow>
                {shortcutEntry}
                <div className="btn-row">
                  {saved && <span className="btn--save-pulse">已应用</span>}
                  <button className="btn btn--ghost" onClick={onClose}>
                    关闭
                  </button>
                  <button
                    className="btn btn--primary"
                    onClick={apply}
                  >
                    应用
                  </button>
                </div>
              </>
            ) : (
              <div style={{ color: "var(--ink-faint)" }}>加载中…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ===== 快捷键改键对话框 =====

/** 列表展示顺序（global 在前、terminal 在后，常用动作靠上）。
 *  注意:新增 ActionId 时除了同步 types.ts 的 ActionId 联合与 shortcuts.ts 的
 *  DEFAULT_BINDINGS/ACTION_LABELS,也要加到这里——改键对话框只渲染此列表,
 *  漏加则该动作在改键页不可见(快捷键仍生效,只是无法在此改键)。 */
const SHORTCUT_ORDER: ActionId[] = [
  "search.open",
  "macro.palette",
  "script.palette",
  "port.palette",
  "theme.toggle",
  "port.refresh",
  "port.close-active",
  "tab.next",
  "tab.prev",
  "activity.toggle-ports",
  "activity.toggle-macros",
  "activity.toggle-scripts",
  "settings.open",
  "about.open",
  "remote.open",
  "zoom.in",
  "zoom.out",
  "zoom.reset",
  "port.reconnect",
];

/** 快捷键改键对话框：逐行展示动作 + 当前组合，点键帽进入录制；行内 / 全部重置。
 *  模态打开时 App 的全局 listener 已被抑制，这里的录制 listener 独占 keydown。
 *  录制中：读下一组非纯修饰符 keydown → setBinding 校验；Esc 取消录制。
 *  非录制：Esc 关闭对话框。 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [map, setMap] = useState<ShortcutMap>(() => getBindings());
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState("");
  // Web 页面端(!isTauri)只隐藏 remote.open(已处远程,再开远程无意义);其余均显示
  const order = isTauri() ? SHORTCUT_ORDER : SHORTCUT_ORDER.filter((a) => a !== "remote.open");

  useEffect(() => subscribeBindings(setMap), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recording) {
        e.preventDefault();
        e.stopPropagation();
        const combo = eventToCombo(e);
        if (!combo) return; // 纯修饰符，等主键
        if (combo === "escape") {
          setRecording(null);
          setError("");
          return;
        }
        const r = setBinding(recording, combo);
        if (r.ok) {
          setRecording(null);
          setError("");
        } else {
          setError(r.reason); // 保持录制，让用户重按
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onClose]);

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--shortcuts" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGear /> SHORTCUTS
        </h3>
        <div className="dialog__sub">点键帽录制，按下新组合；Esc 取消录制</div>

        <div className="shortcut-list">
          {order.map((action) => {
            const b = map[action];
            const isRec = recording === action;
            const isDefault = b.combo === DEFAULT_BINDINGS[action].combo;
            return (
              <div className="shortcut-row" key={action}>
                <span className="shortcut-row__label">{ACTION_LABELS[action]}</span>
                <button
                  type="button"
                  className={"kbd" + (isRec ? " kbd--rec" : "")}
                  onClick={() => {
                    setRecording(action);
                    setError("");
                  }}
                >
                  {isRec ? "按下新组合…" : formatCombo(b.combo)}
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="重置默认"
                  disabled={isDefault}
                  onClick={() => {
                    resetBinding(action);
                    setError("");
                  }}
                >
                  ↺
                </button>
              </div>
            );
          })}
          {/* tab.select 是一族键（Ctrl+Alt+1..9，0→末个），不可改键——静态说明行 */}
          <div className="shortcut-row shortcut-row--fixed">
            <span className="shortcut-row__label">{ACTION_LABELS["tab.select"]}</span>
            <span className="kbd kbd--fixed">{formatCombo("mod+alt+1")}…9</span>
            <span className="shortcut-row__hint">固定</span>
          </div>
        </div>

        {error && <p className="editor-error">{error}</p>}

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <button
            className="btn btn--ghost"
            onClick={() => {
              resetAll();
              setError("");
            }}
          >
            全部重置
          </button>
          <button className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 宏命令面板（Ctrl+O）=====

/** 模糊匹配：查询字符按序出现在 target 里即命中（大小写不敏感）。
 *  返回 {score, first}：score = 匹配字符间间隙累加（越小越紧凑），first = 首个命中下标（越靠前越好）。 */
function fuzzyMatch(query: string, target: string): { score: number; first: number } | null {
  if (!query) return { score: 0, first: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -1;
  let first = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first === -1) first = ti;
      else score += ti - last - 1;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? { score, first: first === -1 ? 0 : first } : null;
}

/** 宏命令面板：顶部搜索框 + 模糊过滤的宏列表，方向键选择，回车执行。
 *  模态打开时 App 的全局 listener 已被抑制；这里在输入框上自处理方向键 / 回车 / Esc。 */
export function MacroPalette({
  macros,
  activePort,
  onRun,
  onClose,
}: {
  macros: Record<string, Macro>;
  activePort: string;
  onRun: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { name: string; score: number; first: number }[] = [];
    for (const name of Object.keys(macros)) {
      const m = fuzzyMatch(query, name);
      if (m) matched.push({ name, score: m.score, first: m.first });
    }
    matched.sort(
      (a, b) => a.score - b.score || a.first - b.first || a.name.localeCompare(b.name)
    );
    return matched.map((x) => x.name);
  }, [macros, query]);

  // 查询变化 → 回到首项、清提示
  useEffect(() => {
    setSelected(0);
    setHint("");
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (name: string) => {
    if (!activePort) {
      setHint("先打开一个端口再运行宏");
      return;
    }
    onRun(name);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const name = filtered[selected] ?? filtered[0];
      if (name) commit(name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索宏…（${Object.keys(macros).length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配宏</div>}
          {filtered.map((name, i) => (
            <button
              type="button"
              key={name}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(name)}
            >
              <span className="palette__name">{name}</span>
              {macros[name].description && (
                <span className="palette__desc">{macros[name].description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="palette__footer">
          {hint ? (
            <span className="palette__hint">{hint}</span>
          ) : activePort ? (
            <span>↑↓ 选择 · 回车运行</span>
          ) : (
            <span className="palette__hint palette__hint--faint">未打开端口</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== 脚本选择面板（Ctrl+B）=====
/** 脚本选择面板：模糊搜索脚本，方向键选择，回车运行。镜像 MacroPalette。 */
export function ScriptPalette({
  scripts,
  activePort,
  onRun,
  onClose,
}: {
  scripts: Record<string, Script>;
  activePort: string;
  onRun: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { name: string; score: number; first: number }[] = [];
    for (const name of Object.keys(scripts)) {
      const m = fuzzyMatch(query, name);
      if (m) matched.push({ name, score: m.score, first: m.first });
    }
    matched.sort(
      (a, b) => a.score - b.score || a.first - b.first || a.name.localeCompare(b.name)
    );
    return matched.map((x) => x.name);
  }, [scripts, query]);

  // 查询变化 → 回到首项、清提示
  useEffect(() => {
    setSelected(0);
    setHint("");
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (name: string) => {
    if (!activePort) {
      setHint("先打开一个端口再运行脚本");
      return;
    }
    onRun(name);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const name = filtered[selected] ?? filtered[0];
      if (name) commit(name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索脚本…（${Object.keys(scripts).length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配脚本</div>}
          {filtered.map((name, i) => (
            <button
              type="button"
              key={name}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(name)}
            >
              <span className="palette__name">{name}</span>
              {scripts[name].description && (
                <span className="palette__desc">{scripts[name].description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="palette__footer">
          {hint ? (
            <span className="palette__hint">{hint}</span>
          ) : activePort ? (
            <span>↑↓ 选择 · 回车运行</span>
          ) : (
            <span className="palette__hint palette__hint--faint">未打开端口</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== 串口选择面板（Ctrl+I）=====

/** 串口选择面板：模糊搜索端口，方向键选择，回车打开（onSelect 走与点端口行同一流程）。 */
export function PortPalette({
  ports,
  onSelect,
  onClose,
}: {
  ports: (PortInfo & { pid: PortId })[];
  onSelect: (pid: PortId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { pid: PortId; score: number; first: number }[] = [];
    for (const p of ports) {
      const hay = p.alias ? `${p.alias} ${p.name}` : p.name;
      const m = fuzzyMatch(query, hay);
      if (m) matched.push({ pid: p.pid, score: m.score, first: m.first });
    }
    matched.sort((a, b) => a.score - b.score || a.first - b.first || a.pid.localeCompare(b.pid));
    return matched.map((x) => x.pid);
  }, [ports, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const byPid = useMemo(() => {
    const m: Record<string, PortInfo> = {};
    for (const p of ports) m[p.pid] = p;
    return m;
  }, [ports]);

  const commit = (pid: PortId) => {
    onSelect(pid);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pid = filtered[selected] ?? filtered[0];
      if (pid) commit(pid);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索串口…（${ports.length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配串口</div>}
          {filtered.map((pid, i) => (
            <button
              type="button"
              key={pid}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(pid)}
            >
              <span className="palette__name">
                <PortLabel name={byPid[pid]?.name ?? pid} alias={byPid[pid]?.alias} />
              </span>
            </button>
          ))}
        </div>
        <div className="palette__footer">
          <span>↑↓ 选择 · 回车打开</span>
        </div>
      </div>
    </div>
  );
}

// ===== 宏编辑器 =====

export function newStep(type: StepType): MacroStep {
  switch (type) {
    case "send":
      return { type: "send", data: "", format: "text", auto_newline: true };
    case "delay":
      return { type: "delay", ms: 500 };
    case "expect":
      return { type: "expect", pattern: "", timeout_ms: 3000 };
    case "clear":
      return { type: "clear" };
  }
}

export function validateMacro(m: Macro): string | null {
  if (m.steps.length === 0) return "至少需要一个步骤";
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i];
    const tag = `步骤 ${i + 1}`;
    switch (s.type) {
      case "send":
        if (!s.data.trim()) return `${tag}：send 数据不能为空`;
        break;
      case "delay":
        if (!s.ms || s.ms <= 0) return `${tag}：delay 毫秒须 > 0`;
        break;
      case "expect":
        if (!s.pattern.trim()) return `${tag}：expect 匹配模式不能为空`;
        if (!s.timeout_ms || s.timeout_ms <= 0) return `${tag}：expect 超时须 > 0`;
        break;
    }
  }
  return null;
}

const STEP_TAG: Record<StepType, string> = { send: "SEND", delay: "DELAY", expect: "EXPECT", clear: "CLEAR" };

function StepGlyph({ type }: { type: StepType }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "send":
      return (
        <svg {...common}>
          <path d="M4 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case "delay":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="7.5" />
          <path d="M12 9.5v3.6l2.4 1.5" />
          <path d="M9.5 3.5h5" />
        </svg>
      );
    case "expect":
      return (
        <svg {...common}>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      );
    case "clear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M6.5 6.5l11 11" />
        </svg>
      );
  }
}

export function MacroEditor({
  name,
  macro,
  error,
  isNew,
  groups,
  onName,
  onMacroChange,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  macro: Macro;
  error: string;
  isNew: boolean;
  groups: string[];
  onName: (s: string) => void;
  onMacroChange: (m: Macro) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  useEscClose(onCancel);
  const setDesc = (description: string) => onMacroChange({ ...macro, description });
  const setGroup = (group: string) => onMacroChange({ ...macro, group: group || undefined });
  const setStep = (i: number, s: MacroStep) => {
    const steps = macro.steps.slice();
    steps[i] = s;
    onMacroChange({ ...macro, steps });
  };
  const addStep = (type: StepType) => onMacroChange({ ...macro, steps: [...macro.steps, newStep(type)] });
  const removeStep = (i: number) => onMacroChange({ ...macro, steps: macro.steps.filter((_, j) => j !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= macro.steps.length) return;
    const steps = macro.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onMacroChange({ ...macro, steps });
  };

  const duplicateStep = (i: number) => {
    const steps = macro.steps.slice();
    steps.splice(i + 1, 0, JSON.parse(JSON.stringify(steps[i])) as MacroStep);
    onMacroChange({ ...macro, steps });
  };

  // 拖拽排序（HTML5 DnD）。落点按指针在上/下半区决定 before/after。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overAfter, setOverAfter] = useState(false);
  const resetDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
    setOverAfter(false);
  };
  const onStepDragStart = (_e: React.DragEvent, i: number) => setDragIndex(i);
  const onStepDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOverIndex(i);
    setOverAfter(e.clientY - rect.top > rect.height / 2);
  };
  const onStepDrop = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    if (dragIndex === null) {
      resetDrag();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    const steps = macro.steps.slice();
    const [moved] = steps.splice(dragIndex, 1);
    let at = i + (after ? 1 : 0);
    if (dragIndex < at) at -= 1;
    at = Math.max(0, Math.min(at, steps.length));
    steps.splice(at, 0, moved);
    onMacroChange({ ...macro, steps });
    resetDrag();
  };
  const dropPosFor = (i: number): "before" | "after" | null => {
    if (dragIndex === null || overIndex !== i) return null;
    return overAfter ? "after" : "before";
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--macro" onClick={(e) => e.stopPropagation()}>
        <div className="macro-editor__head">
          <h3 className="dialog__title">
            <IconBolt /> MACRO
          </h3>
          <div className="dialog__sub">{isNew ? "新增宏" : name}</div>
          <ConfigRow label="名称">
            <input value={name} onChange={(e) => onName(e.target.value)} className="field" />
          </ConfigRow>
          <ConfigRow label="描述">
            <input value={macro.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" className="field" />
          </ConfigRow>
          <ConfigRow label="分组">
            <input value={macro.group ?? ""} list="macro-groups" onChange={(e) => setGroup(e.target.value)} placeholder="可选" className="field" />
            <datalist id="macro-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </ConfigRow>
        </div>

        <div className="macro-editor__scroll">
          <div className="dialog__group-label" style={{ marginTop: 6 }}>
            步骤
          </div>
        {macro.steps.length === 0 && <p className="sidebar__empty">无步骤（点下方添加）</p>}
        {macro.steps.map((s, i) => (
          <StepEditor
            key={i}
            step={s}
            index={i}
            total={macro.steps.length}
            onChange={(ns) => setStep(i, ns)}
            onRemove={() => removeStep(i)}
            onMoveUp={() => moveStep(i, -1)}
            onMoveDown={() => moveStep(i, 1)}
            onDuplicate={() => duplicateStep(i)}
            isDragging={dragIndex === i}
            dropPos={dropPosFor(i)}
            onDragStart={(e) => onStepDragStart(e, i)}
            onDragOver={(e) => onStepDragOver(e, i)}
            onDrop={(e) => onStepDrop(e, i)}
            onDragEnd={resetDrag}
          />
        ))}

        <div className="add-step-row">
          <button className="add-step" data-kind="send" onClick={() => addStep("send")}>
            <IconPlus /> 发送
          </button>
          <button className="add-step" data-kind="delay" onClick={() => addStep("delay")}>
            <IconPlus /> 延时
          </button>
          <button className="add-step" data-kind="expect" onClick={() => addStep("expect")}>
            <IconPlus /> 等待
          </button>
          <button className="add-step" data-kind="clear" onClick={() => addStep("clear")}>
            <IconPlus /> 清空
          </button>
        </div>

        {error && (
          <div className="editor-error">
            <IconAlert /> {error}
          </div>
        )}

        <details>
          <summary className="json-summary">JSON 预览（只读）</summary>
          <pre className="json-preview">{JSON.stringify(macro, null, 2)}</pre>
        </details>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn--ghost btn--icon"
              onClick={async () => {
                const n = name.trim() || "macro";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: macro });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button className="btn btn--danger btn--icon" onClick={onDelete} title="删除">
                <IconTrash />
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--ghost" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn--primary" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脚本编辑器：JS 代码编辑（textarea），结构/样式镜像 MacroEditor。 */
export function ScriptEditor({
  name,
  script,
  error,
  isNew,
  groups,
  onName,
  onScriptChange,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  script: Script;
  error: string | null;
  isNew: boolean;
  groups: string[];
  onName: (v: string) => void;
  onScriptChange: (s: Script) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  useEscClose(onCancel);
  const setDesc = (description: string) => onScriptChange({ ...script, description });
  const setGroup = (group: string) => onScriptChange({ ...script, group: group || undefined });
  const setCode = (code: string) => {
    // code 含 // @param 声明 → 自动解析填参数区(AI 生成自包含脚本,粘贴即用)。无声明则不动 params。
    const parsed = parseParamsFromCode(code);
    onScriptChange(parsed ? { ...script, code, params: parsed } : { ...script, code });
  };
  const setParams = (params: ScriptParam[]) => onScriptChange({ ...script, params });
  const setParam = (i: number, p: ScriptParam) => {
    const params = (script.params ?? []).slice();
    params[i] = p;
    setParams(params);
  };
  const addParam = () => setParams([...(script.params ?? []), { name: "", type: "string" }]);
  const removeParam = (i: number) => setParams((script.params ?? []).filter((_, j) => j !== i));

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--macro" onClick={(e) => e.stopPropagation()}>
        <div className="macro-editor__head">
          <h3 className="dialog__title">
            <IconCode /> SCRIPT
          </h3>
          <div className="dialog__sub">{isNew ? "新增脚本" : name}</div>
          <ConfigRow label="名称">
            <input value={name} onChange={(e) => onName(e.target.value)} className="field" />
          </ConfigRow>
          <ConfigRow label="描述">
            <input value={script.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" className="field" />
          </ConfigRow>
          <ConfigRow label="分组">
            <input value={script.group ?? ""} list="script-groups" onChange={(e) => setGroup(e.target.value)} placeholder="可选" className="field" />
            <datalist id="script-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </ConfigRow>
        </div>

        <div className="macro-editor__scroll">
          <div className="dialog__group-label" style={{ marginTop: 6 }}>
            代码
          </div>
          <div className="script-editor__hint">await send(data, [port]) · await expect(pattern, ms, [port]) · await clear([port]) · await sleep(ms) · log(data)</div>
          <div className="script-editor__hint">[port] 可选,缺省为当前活动端口,可指定其它已打开端口(跨多串口操作)</div>
          <textarea
            value={script.code}
            onChange={(e) => setCode(e.target.value)}
            className="field script-editor__code"
            spellCheck={false}
            placeholder="// 在此编写 JS 脚本…"
            style={{
              fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
              minHeight: 300,
              resize: "vertical",
              width: "100%",
            }}
          />

          <div className="dialog__group-label" style={{ marginTop: 12 }}>
            参数(运行时收集,脚本用 args.键名 读取)
          </div>
          <div className="script-editor__hint">string=文本框;select=下拉(options 每行一个)。无参数则直接运行不弹窗。</div>
          {(script.params ?? []).map((p, i) => (
            <ParamEditor key={i} param={p} onChange={(np) => setParam(i, np)} onRemove={() => removeParam(i)} />
          ))}
          <button className="btn btn--ghost macro-editor__add" onClick={addParam} title="新增参数">
            <IconPlus /> 新增参数
          </button>

        {error && (
          <div className="editor-error">
            <IconAlert /> {error}
          </div>
        )}

        <details>
          <summary className="json-summary">JSON 预览（只读）</summary>
          <pre className="json-preview">{JSON.stringify(script, null, 2)}</pre>
        </details>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn--ghost btn--icon"
              onClick={async () => {
                const n = name.trim() || "script";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: script });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button className="btn btn--danger btn--icon" onClick={onDelete} title="删除">
                <IconTrash />
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--ghost" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn--primary" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脚本参数编辑行:name / 标签 / 类型(string|select) / 缺省 / select 选项。 */
function ParamEditor({ param, onChange, onRemove }: {
  param: ScriptParam;
  onChange: (p: ScriptParam) => void;
  onRemove: () => void;
}) {
  const isSelect = param.type === "select";
  return (
    <div className="param-editor">
      <input className="field param-editor__name" value={param.name}
        onChange={(e) => onChange({ ...param, name: e.target.value })} placeholder="name(args 取此键)" />
      <input className="field param-editor__label" value={param.label ?? ""}
        onChange={(e) => onChange({ ...param, label: e.target.value || undefined })} placeholder="标签(可选)" />
      <select className="field param-editor__type" value={param.type}
        onChange={(e) => onChange({ ...param, type: e.target.value as "string" | "select" })}>
        <option value="string">string</option>
        <option value="select">select</option>
      </select>
      <input className="field param-editor__default" value={param.default ?? ""}
        onChange={(e) => onChange({ ...param, default: e.target.value || undefined })} placeholder="缺省值(可选)" />
      <button className="btn btn--danger btn--icon" onClick={onRemove} title="删除参数"><IconTrash /></button>
      {isSelect && (
        <textarea className="field param-editor__options" rows={2}
          value={(param.options ?? []).join("\n")}
          onChange={(e) => onChange({ ...param, options: e.target.value.split("\n") })}
          placeholder="选项(每行一个)" />
      )}
    </div>
  );
}

function StepEditor({
  step,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  isDragging,
  dropPos,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  step: MacroStep;
  index: number;
  total: number;
  onChange: (s: MacroStep) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  isDragging: boolean;
  dropPos: "before" | "after" | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const changeType = (type: StepType) => {
    if (type === step.type) return;
    onChange(newStep(type));
  };

  const cardRef = useRef<HTMLDivElement>(null);
  const onGripDragStart = (e: React.DragEvent) => {
    // 必须写 dataTransfer，否则部分浏览器/webview 会取消拖拽
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 14, 14);
    onDragStart(e);
  };

  return (
    <div
      ref={cardRef}
      className="step-card"
      data-kind={step.type}
      data-dragging={isDragging ? "true" : undefined}
      data-drop={dropPos ?? undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="step-head">
        <span
          className="step-grip"
          title="拖动排序"
          draggable
          onDragStart={onGripDragStart}
          onDragEnd={onDragEnd}
        >
          <IconGrip />
        </span>
        <span className="step-num">#{String(index + 1).padStart(2, "0")}</span>
        <span className="step-tag">
          <StepGlyph type={step.type} />
          {STEP_TAG[step.type]}
        </span>
        <select value={step.type} onChange={(e) => changeType(e.target.value as StepType)} className="field-select" style={{ flex: "0 0 auto", width: 92 }}>
          <option value="send">发送</option>
          <option value="delay">延时</option>
          <option value="expect">等待</option>
          <option value="clear">清空</option>
        </select>
        <div className="step-head__spacer" />
        <div className="step-actions">
          <button onClick={onDuplicate} title="复制" className="mini-btn">
            <IconCopy />
          </button>
          <button onClick={onMoveUp} disabled={index === 0} title="上移" className="mini-btn">
            <IconChevronUp />
          </button>
          <button onClick={onMoveDown} disabled={index === total - 1} title="下移" className="mini-btn">
            <IconChevronDown />
          </button>
          <button onClick={onRemove} title="删除" className="mini-btn mini-btn--danger">
            <IconClose />
          </button>
        </div>
      </div>
      <div className="step-body">
        {step.type === "send" && (
          <>
            <textarea value={step.data} onChange={(e) => onChange({ ...step, data: e.target.value })} placeholder="发送内容" rows={1} className="field-textarea" />
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
              <label className="inline-label">
                格式
                <select value={step.format} onChange={(e) => onChange({ ...step, format: e.target.value })} className="field-select" style={{ marginLeft: 6, flex: "0 0 auto", width: 74 }}>
                  <option value="text">text</option>
                  <option value="hex">hex</option>
                </select>
              </label>
              <label className="inline-label">
                <input type="checkbox" checked={step.auto_newline} onChange={(e) => onChange({ ...step, auto_newline: e.target.checked })} />
                自动换行（按端口设置）
              </label>
            </div>
          </>
        )}
        {step.type === "delay" && (
          <label className="inline-label">
            等待
            <input type="number" value={step.ms} onChange={(e) => onChange({ ...step, ms: Number(e.target.value) })} min={1} className="field" style={{ display: "inline-block", width: 84, margin: "0 6px" }} />
            毫秒
          </label>
        )}
        {step.type === "expect" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
            <label className="inline-label" style={{ flex: 1, minWidth: 140, flexDirection: "column", alignItems: "stretch" }}>
              等待匹配
              <input value={step.pattern} onChange={(e) => onChange({ ...step, pattern: e.target.value })} placeholder="正则 / 子串" className="field" style={{ display: "block", marginTop: 4 }} />
            </label>
            <label className="inline-label">
              超时
              <input type="number" value={step.timeout_ms} onChange={(e) => onChange({ ...step, timeout_ms: Number(e.target.value) })} min={1} className="field" style={{ display: "inline-block", width: 74, margin: "0 6px" }} />
              ms
            </label>
          </div>
        )}
        {step.type === "clear" && <div className="step-body__note">清空接收缓冲区</div>}
      </div>
    </div>
  );
}

// ===== 活动栏 / 关于 / 远程 =====

export function ActivityIcon({ icon, title, active, onClick }: { icon: React.ReactNode; title: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title} data-active={active} className="act-icon" aria-label={title}>
      {icon}
    </button>
  );
}

export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  useEscClose(onClose);
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="about">
          <div className="about__mark">
            <IconPlug />
          </div>
          <h3 className="about__name">Serial Studio</h3>
          <p className="about__version">版本 {version || "…"}</p>
          <p className="about__tagline">
            多形态串口通信工具
            <br />
            <span className="pip">本地 / 远程</span> 双模式 · Tauri + WebSocket
          </p>
          <button className="btn btn--primary" onClick={onClose} autoFocus>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 脚本编写指南(SKILL 全文):查看 + 一键复制给外部 Agent(Claude/Cursor 等)。
 *  纯文本展示(等宽、pre-wrap);复制的是 SKILL.md 原文,粘给 Agent 即完整 skill。 */
export function ScriptSkillDialog({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  useEscClose(onClose);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板 API 失败(罕见,如非安全上下文)静默:<pre> 仍可手动选文复制
    }
  };
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--macro" onClick={(e) => e.stopPropagation()}>
        <div className="macro-editor__head">
          <h3 className="dialog__title">脚本编写指南</h3>
          <div className="dialog__sub">
            SKILL 全文 —— 复制给外部 Agent(Claude / Cursor 等),它即可为你生成 Serial Studio 脚本
          </div>
        </div>
        <div className="macro-editor__scroll">
          <pre className="script-skill__pre">{text}</pre>
        </div>
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <button className="btn btn--primary" onClick={copy}>
            <IconCopy /> {copied ? "已复制 ✓" : "复制给外部 Agent"}
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteDialog({ input, onChange, onConfirm, onCancel }: {
  input: { host: string; port: number; nickname: string };
  onChange: (v: { host: string; port: number; nickname: string }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useDialogKeys({ onClose: onCancel, onEnter: onConfirm });
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGlobe /> 添加远程设备
        </h3>
        <div className="dialog__sub">连接远程 Serial Studio 服务</div>
        <ConfigRow label="地址">
          <input autoFocus value={input.host} onChange={(e) => onChange({ ...input, host: e.target.value })} placeholder="192.168.1.50" className="field" />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={input.port} onChange={(e) => onChange({ ...input, port: Number(e.target.value) })} className="field" />
        </ConfigRow>
        <ConfigRow label="昵称">
          <input value={input.nickname} onChange={(e) => onChange({ ...input, nickname: e.target.value })} placeholder="可选，如「实验室机械臂」" className="field" />
        </ConfigRow>
        <p className="dialog__hint">将作为远程设备卡加入串口列表，展开即按需连接。</p>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

/** 运行时参数收集:按脚本声明 params 渲染表单(string→输入框、select→下拉),确认回调 args。 */
export function ScriptRunParamsDialog({ scriptName, params, onConfirm, onCancel }: {
  scriptName: string;
  params: ScriptParam[];
  onConfirm: (args: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) init[p.name] = p.default ?? (p.options?.find((o) => o) ?? "");
    return init;
  });
  useDialogKeys({ onClose: onCancel, onEnter: () => onConfirm(values) });
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title"><IconCode /> 运行参数</h3>
        <div className="dialog__sub">{scriptName}</div>
        {params.map((p) => (
          <ConfigRow key={p.name} label={p.label || p.name}>
            {p.type === "select" ? (
              <select className="field" value={values[p.name] ?? ""}
                onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}>
                {(p.options ?? []).filter((o) => o).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="field" value={values[p.name] ?? ""}
                onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
            )}
          </ConfigRow>
        ))}
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button className="btn btn--primary" onClick={() => onConfirm(values)}>运行</button>
        </div>
      </div>
    </div>
  );
}

// ===== 确认弹窗（替代浏览器原生 confirm，统一仪器风）=====

export function ConfirmDialog({
  title,
  icon,
  message,
  confirmText = "确定",
  cancelText = "取消",
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  icon?: React.ReactNode;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Enter 确认 / Esc 取消——与搜索框一致的键盘语义。遮罩不关闭（防误触，同其它对话框）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          {icon ?? <IconAlert />} {title}
        </h3>
        <div className="dialog__sub">{message}</div>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={`btn ${tone === "danger" ? "btn--danger" : "btn--primary"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

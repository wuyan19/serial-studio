/** 终端区：xterm 实例池（TermView，DOM reparent 跨 group 保 scrollback）、
editor group（标签栏 + 终端区 + 拖拽分栏）、终端内搜索条。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { Group, PaneHalf, ShortcutMap, TermInstance } from "../types";
import { copyText, displayPortName, readClipboardText } from "../lib";
import { getTheme, subscribe, themeDefOf, type Theme } from "../theme";
import { getFontSize, subscribeFont, zoomIn, zoomOut, resetFontSize } from "../term-font";
import { eventToCombo, formatCombo, getBindings, subscribeBindings } from "../shortcuts";
import { IconChevronDown, IconChevronUp, IconClose, IconPlug } from "../icons";
import { InlineAliasInput, PortLabel } from "./primitives";
import { ContextMenu, type ContextMenuItem } from "./context-menu";

// ===== 终端视图 =====

// xterm 配色在 theme.ts 注册表里集中定义(canvas 不吃 CSS 变量,只能给纯色);
// 此处仅按当前主题取定义,不再持有本地映射表——新增主题无需改本文件。
const MONO_STACK =
  "'IBM Plex Mono', 'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace";

function termThemeFor(t: Theme) {
  return themeDefOf(t).term;
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
  recbar,
  recCtl,
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
  /** 底部记录条(local 形态才有;undefined = 不渲染)。 */
  recbar?: TermRecBar;
  /** 记录条显隐控制(右键菜单项;undefined = 该形态无记录条,菜单不含此项)。 */
  recCtl?: { visible: boolean; toggle: () => void };
}) {
  // 根 div = reparent 单元(DOM 在 term-pool 与 group 容器间搬移);内层才是 xterm open
  // 容器——根改 flex column 后底部要给记录条留位,xterm 必须住在 flex:1 的内层里。
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /** 右键菜单锚点(null = 关闭)。坐标为 viewport 系,ContextMenu 组件 fixed 定位直接用。 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 断开态 + 重连回调经 ref:customKeyEventHandler 在 [port] effect 内,直接闭包 props 会 stale
  const disconnectedRef = useRef(disconnected ?? false);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => { disconnectedRef.current = disconnected ?? false; }, [disconnected]);
  useEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);

  // DOM reparent：把本根 div 挪到所属 group 的终端容器。targetContainer 变（跨 group 搬）→ 重挪。
  // 用 useLayoutEffect：在 paint 前挪，避免 term-pool 闪现；xterm 实例不重建，canvas 跟随根 div 移动。
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el && targetContainer && el.parentNode !== targetContainer) {
      targetContainer.appendChild(el);
    }
    return () => {
      // 卸载（或换 target 重 reparent）前把根 div 移回 term-pool：React 按 fiber 记忆的位置
      // (term-pool) removeChild，若此时 DOM 在 group 容器里会找不到节点 → 崩溃白屏。先归位再删。
      const el2 = rootRef.current;
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
      rightClickSelectsWord: true, // PuTTY 式右键选词（选中即复制配合，双通道取词）
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
    // 选中即复制（VS Code copyOnSelection 同款）：拖选/双击/右键选词一完成就写系统剪贴板。
    // hasSelection 守卫：取消选择（点空白）触发同一事件，此时不动剪贴板（否则被清空）。
    const selDisposable = term.onSelectionChange(() => {
      if (!term.hasSelection()) return;
      const text = term.getSelection();
      if (text) void copyText(text);
    });
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
    // Web 字体(Plex Mono)晚于终端就位时,字符格尺寸随重测改变而容器尺寸不变——
    // RO 不触发、xterm 也不自动 refit,终端会以旧格尺寸的高度溢出容器(曾盖住底部通道条)。
    // 字体批次就位后补一次 fit;alive 防卸载后迟到回调。
    let alive = true;
    const refit = () => {
      if (!alive) return;
      try {
        fit.fit();
      } catch {
        /* 容器未可见 */
      }
    };
    document.fonts?.addEventListener("loadingdone", refit);
    document.fonts?.ready.then(refit);
    return () => {
      alive = false;
      document.fonts?.removeEventListener("loadingdone", refit);
      clearTimeout(timer);
      disposable.dispose();
      selDisposable.dispose();
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

  // 右键菜单项:复制(选中时)/粘贴/记录条显隐。xterm 的选词监听在 .xterm 元素上
  // 先触发,这里只接管"弹什么菜单"(preventDefault 掉 WebView 默认菜单)。
  const openCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };
  const buildCtxItems = (): ContextMenuItem[] => {
    const sel = termRef.current?.getSelection() ?? "";
    const items: ContextMenuItem[] = [
      { label: "复制", disabled: !sel, onSelect: () => void copyText(sel) },
      {
        label: "粘贴",
        onSelect: () => {
          void readClipboardText().then((text) => {
            if (text) onWrite(port, text);
          });
        },
      },
    ];
    if (recCtl) {
      items.push({ sep: true }, { label: recCtl.visible ? "隐藏 记录条" : "显示 记录条", onSelect: recCtl.toggle });
    }
    return items;
  };

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

  return (
    <div
      ref={rootRef}
      className="termview-root"
      onContextMenu={openCtxMenu}
      style={{
        position: "absolute",
        inset: 0,
        display: visible ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      {/* xterm open 容器:占满根内剩余空间(记录条占底部);fit() 量测的是此层尺寸 */}
      <div ref={containerRef} className="termview-term" style={{ flex: "1 1 auto", minHeight: 0 }} />
      {recbar && <RecBar bar={recbar} />}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildCtxItems()}
          onClose={(reason) => {
            setCtxMenu(null);
            // Escape 关闭时把焦点还给终端(点菜单项不抢焦,无需善后;点外则尊重用户去向)
            if (reason === "escape") termRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}


// ===== 终端记录落盘条 =====

/** 记录条渲染模型 + 动作(App 组装;local 形态才有)。 */
export interface TermRecBar {
  state: "idle" | "recording" | "paused" | "error";
  /** 已选文件完整路径(idle 为空串,输入框只读展示)。 */
  path: string;
  /** 默认建议文件名(idle 态 placeholder)。 */
  defaultName: string;
  error?: string;
  /** 打开原生保存对话框选位置(选中即开始记录)。 */
  onSelect: () => void;
  /** 记录中 → 暂停;暂停/错误 → 继续(同一文件追加)。 */
  onToggle: () => void;
}

const RECBAR_STATE_LABEL: Record<TermRecBar["state"], string> = {
  idle: "未在记录",
  recording: "记录中",
  paused: "已暂停",
  error: "记录出错",
};

function RecBar({ bar }: { bar: TermRecBar }) {
  const active = bar.state !== "idle";
  return (
    <div className="recbar" data-state={bar.state}>
      <span
        className="recbar__dot"
        title={bar.error ?? RECBAR_STATE_LABEL[bar.state]}
        aria-label={RECBAR_STATE_LABEL[bar.state]}
      />
      <input
        className="recbar__input"
        value={active ? bar.path : ""}
        placeholder={bar.defaultName}
        readOnly
        title={bar.error ?? (active ? bar.path : `建议文件名:${bar.defaultName}`)}
        spellCheck={false}
        aria-label="记录文件路径"
      />
      {bar.state === "error" && <span className="recbar__err">{bar.error}</span>}
      <button
        className="recbar__btn"
        onClick={bar.onSelect}
        title={
          active
            ? "更换记录文件(当前文件收尾保存)"
            : "选择记录文件位置,开始实时写入收到的数据"
        }
      >
        {active ? "更改…" : "开始记录…"}
      </button>
      {active && bar.state !== "error" && (
        <button
          className="recbar__btn recbar__btn--toggle"
          onClick={bar.onToggle}
          title={bar.state === "recording" ? "暂停记录(数据不再写入)" : "继续记录(追加到当前文件)"}
        >
          {bar.state === "recording" ? "⏸ 暂停" : "▶ 继续"}
        </button>
      )}
    </div>
  );
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
  // 空状态快捷键提示用:跟随改键(只在有空 tab 的格子短暂存在,订阅成本可忽略)
  const [bindings, setBindings] = useState<ShortcutMap>(() => getBindings());
  useEffect(() => subscribeBindings(setBindings), []);
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
          const portName = displayPortName(port); // 多级复合键也只显示串口名(设备归属由 source 标签表达)
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
            {/* 快捷键提示:用当前实际绑定(改键后跟随)。用 <kbd> 元素吃 .term-empty kbd
                现成样式——span.kbd 会撞上改键对话框 .kbd 基类的 min-width:96px 被撑爆 */}
            <div className="term-empty__hint">
              <span><kbd>{formatCombo(bindings["port.palette"].combo)}</kbd> 串口面板</span>
              <span><kbd>{formatCombo(bindings["macro.palette"].combo)}</kbd> 宏</span>
              <span><kbd>{formatCombo(bindings["script.palette"].combo)}</kbd> 脚本</span>
            </div>
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


// ===== 终端内搜索（Ctrl+F） =====

/** 搜索高亮配色(xterm 要求纯 #RRGGBB)——同样收编进 theme.ts 注册表,按主题取定义。 */
function searchDecorations(t: Theme) {
  return themeDefOf(t).search;
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
      <button className="searchbar__toggle" data-on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="区分大小写" aria-label="区分大小写" aria-pressed={caseSensitive}>
        Aa
      </button>
      <button className="searchbar__toggle" data-on={regex} onClick={() => setRegex((v) => !v)} title="正则表达式" aria-label="正则表达式" aria-pressed={regex}>
        .*
      </button>
      <button className="searchbar__toggle" data-on={wholeWord} onClick={() => setWholeWord((v) => !v)} title="整词" aria-label="整词匹配" aria-pressed={wholeWord}>
        W
      </button>
      <input
        ref={inputRef}
        className={`searchbar__input${error ? " searchbar__input--err" : ""}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="off"
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
      <button className="searchbar__btn" onClick={prev} title="上一个 (Shift+Enter)" aria-label="上一个匹配">
        <IconChevronUp />
      </button>
      <button className="searchbar__btn" onClick={next} title="下一个 (Enter)" aria-label="下一个匹配">
        <IconChevronDown />
      </button>
      <button className="searchbar__btn searchbar__close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭搜索">
        <IconClose />
      </button>
    </div>
  );
}


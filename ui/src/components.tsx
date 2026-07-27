import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm"; // xterm.css 经 styles.css 统一引入
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
import type {
  ConnConfig,
  Macro,
  MacroStep,
  SerialConfig,
  SrvSettings,
  StepType,
  TermInstance,
} from "./types";
import { BAUD_RATES, downloadJson } from "./lib";
import { getTheme, subscribe, type Theme } from "./theme";
import { getFontSize, subscribeFont, zoomIn, zoomOut, resetFontSize } from "./term-font";
import {
  IconAlert,
  IconBolt,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconCopy,
  IconEdit,
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
  foreground: "#c9d2e0",
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
  foreground: "#3a3d44",
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
  white: "#3a3d44",
  brightWhite: "#23262b",
};

function termThemeFor(t: Theme): ITheme {
  return t === "light" ? TERM_THEME_LIGHT : TERM_THEME;
}

export function TermView({
  port,
  active,
  onWrite,
  onReady,
}: {
  port: string;
  active: boolean;
  onWrite: (port: string, data: string) => void;
  onReady: (inst: TermInstance | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

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
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);
    // Ctrl + +/-/0 缩放字体（仅本终端聚焦时拦截，不抢输入框焦点）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey)) return true;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
        return false;
      }
      if (e.key === "-") {
        e.preventDefault();
        zoomOut();
        return false;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetFontSize();
        return false;
      }
      return true;
    });
    fitRef.current = fit;
    termRef.current = term;
    onReady({ term, fit, search });
    const disposable = term.onData((data) => onWrite(port, data));
    const timer = setTimeout(() => {
      try {
        fit.fit();
        term.focus();
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

  useEffect(() => {
    if (active && fitRef.current) {
      const timer = setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0, display: active ? "block" : "none" }} />;
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

export function SearchBar({ searchAddon, onClose }: { searchAddon: SearchAddon; onClose: () => void }) {
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
        if (dir === "next") searchAddon.findNext(query, opts);
        else searchAddon.findPrevious(query, opts);
        setError(false);
      } catch {
        setError(true); // 多半是非法正则
      }
    },
    [query, regex, caseSensitive, wholeWord, searchAddon]
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
  // 别名是端口语义（每端口独立），用内部状态；config 仍是受控（跨端口沿用）。
  // 调用方 key={port} 保证换端口时重挂、状态重置。
  const [alias, setAlias] = useState(initialAlias);
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
          <button className="btn btn--primary" onClick={() => onConfirm(config, alias)}>
            打开
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 别名编辑对话框 =====

/** 设置端口别名的小对话框（复用 ConfirmDialog 风格）。空串提交 = 清除别名。
 *  Enter 确定 / Esc 取消；遮罩不关闭（同其它对话框，防误触）。 */
export function AliasDialog({
  port,
  initial = "",
  onConfirm,
  onCancel,
}: {
  port: string;
  initial?: string;
  onConfirm: (alias: string) => void;
  onCancel: () => void;
}) {
  const [alias, setAlias] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(alias);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alias, onConfirm, onCancel]);
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconEdit /> ALIAS
        </h3>
        <div className="dialog__sub">{port}</div>
        <ConfigRow label="别名">
          <input
            ref={inputRef}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="可选，描述此端口连接的设备"
            className="field"
          />
        </ConfigRow>
        <p className="dialog__hint">留空清除别名。同名别名会从其它端口转移到此端口。</p>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => onConfirm(alias)}>
            确定
          </button>
        </div>
      </div>
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

// ===== 设置面板 =====

export function SettingsPanel({
  connConfig,
  srvSettings,
  onConnChange,
  onSaveSrv,
  showServer,
  onClose,
}: {
  connConfig: ConnConfig;
  srvSettings: SrvSettings | null;
  onConnChange: (c: ConnConfig) => void;
  onSaveSrv: (s: SrvSettings) => void;
  showServer: boolean;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<ConnConfig>(connConfig);
  const [srv, setSrv] = useState<SrvSettings | null>(srvSettings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSrv(srvSettings);
  }, [srvSettings]);

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
              <input value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} className="field" />
            </ConfigRow>
            <ConfigRow label="端口">
              <input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} className="field" />
            </ConfigRow>
            <p className="dialog__hint">改连别的远程 Serial Studio 服务</p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onClose}>
                关闭
              </button>
              <button className="btn btn--primary" onClick={() => onConnChange(conn)}>
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
                  <input value={srv.ws_host} onChange={(e) => setSrv({ ...srv, ws_host: e.target.value })} className="field" />
                </ConfigRow>
                <ConfigRow label="WS 端口">
                  <input type="number" value={srv.ws_port} onChange={(e) => setSrv({ ...srv, ws_port: Number(e.target.value) })} className="field" />
                </ConfigRow>
                <ConfigRow label="Telnet 端口">
                  <input type="number" value={srv.telnet_port} onChange={(e) => setSrv({ ...srv, telnet_port: Number(e.target.value) })} className="field" />
                </ConfigRow>
                <div className="btn-row">
                  {saved && <span className="btn--save-pulse">已应用</span>}
                  <button className="btn btn--ghost" onClick={onClose}>
                    关闭
                  </button>
                  <button
                    className="btn btn--primary"
                    onClick={() => {
                      onSaveSrv(srv);
                      setSaved(true);
                      setTimeout(() => setSaved(false), 3000);
                    }}
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
  onName: (s: string) => void;
  onMacroChange: (m: Macro) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const setDesc = (description: string) => onMacroChange({ ...macro, description });
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
      <div className="dialog dialog--med" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconBolt /> MACRO
        </h3>
        <div className="dialog__sub">{isNew ? "新增宏" : name}</div>
        <ConfigRow label="名称">
          <input value={name} onChange={(e) => onName(e.target.value)} disabled={!isNew} className="field" style={{ opacity: isNew ? 1 : 0.5 }} />
        </ConfigRow>
        <ConfigRow label="描述">
          <input value={macro.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" className="field" />
        </ConfigRow>

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
          <button className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteDialog({ input, onChange, onConfirm, onCancel }: {
  input: { host: string; port: number };
  onChange: (v: { host: string; port: number }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGlobe /> REMOTE
        </h3>
        <div className="dialog__sub">连接远程服务</div>
        <ConfigRow label="地址">
          <input value={input.host} onChange={(e) => onChange({ ...input, host: e.target.value })} placeholder="192.168.1.50" className="field" autoFocus />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={input.port} onChange={(e) => onChange({ ...input, port: Number(e.target.value) })} className="field" />
        </ConfigRow>
        <p className="dialog__hint">将在新窗口连接远程 Serial Studio 服务，本地窗口保留。</p>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            连接
          </button>
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

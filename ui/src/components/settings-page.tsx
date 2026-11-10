/**
 * Compact two-column settings keep the existing service, shortcut and update behavior.
 * Search spans categories; selecting a category returns to that category's full list.
 * The capture listener preserves the existing Escape priority and update-close guard.
 */
import { useEffect, useRef, useState } from "react";
import type { ActionId, ConnConfig, ShortcutMap, SrvSettings } from "../types";
import { isTauri } from "../lib";
import {
  ACTION_LABELS, DEFAULT_BINDINGS, eventToCombo, formatCombo,
  getBindings, resetAll, resetBinding, setBinding, subscribeBindings,
} from "../shortcuts";
import { APPEARANCE_THEMES, getTheme, setTheme, subscribe, type Theme } from "../theme";
import { FONT_MAX, FONT_MIN, getFontSize, setFontSize, subscribeFont } from "../term-font";
import {
  checkUpdate, downloadAndInstall, isLocalDesktop, openReleasesPage,
  openRepoPage, REPO_URL, supportsAutoInstall, type Update, type UpdateStatus,
} from "../updater";
import { overlayClose, useDialogA11y } from "./primitives";
import { IconCheck, IconClose, IconGear, IconInfo, IconKeyboard, IconPlug, IconShirt, IconWinMax, IconWinRestore } from "../icons";
import {
  buildSettingsCategories, filterSettings,
  type FilteredCategory, type SettingItemDef, type SettingsCategoryId,
} from "./settings-registry";

import "./settings-page.css";

const CATEGORY_ICONS = { connection: <IconGear />, appearance: <IconShirt />, shortcuts: <IconKeyboard />, about: <IconInfo /> };

export function SettingsPage({
  initialCategory,
  version,
  connConfig,
  srvSettings,
  srvFailed,
  onRetrySrv,
  onConnChange,
  onSaveSrv,
  showServer,
  onClose,
}: {
  /** 打开时落到的分类（齿轮菜单/快捷键入口各自指定） */
  initialCategory: SettingsCategoryId;
  version: string;
  connConfig: ConnConfig;
  srvSettings: SrvSettings | null;
  /** get_settings 失败(srvSettings 为 null 时区分「加载中」与「失败」)。 */
  srvFailed?: boolean;
  onRetrySrv?: () => void;
  /** 应用前端连接（Web/远程模式）。不关页：反馈走本页「已应用」脉冲 + 重连结果 toast。 */
  onConnChange: (c: ConnConfig) => void;
  onSaveSrv: (s: SrvSettings) => void;
  showServer: boolean;
  onClose: () => void;
}) {
  const [active, setActive] = useState<SettingsCategoryId>(initialCategory);
  const [query, setQuery] = useState("");
  /** 最大化 ⇄ 紧凑：紧凑=居中卡片 880×680（默认打开），最大化=94vw×90vh。 */
  const [max, setMax] = useState(false);
  // 外观（原皮肤子菜单）：订阅即得最新值，下拉/输入框受控
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => subscribe(setThemeState), []);
  const [fontSize, setFontSizeState] = useState(getFontSize);
  const [fontDraft, setFontDraft] = useState(() => String(getFontSize()));
  const fontInputRef = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      subscribeFont((n) => {
        setFontSizeState(n);
        // 输入框正在编辑时不覆盖草稿（否则打字中途被 clamp 回写吞字）；失焦后由 blur 归一化
        if (document.activeElement !== fontInputRef.current) setFontDraft(String(n));
      }),
    [],
  );
  // 连接（原 SettingsPanel 逻辑）
  const [conn, setConn] = useState<ConnConfig>(connConfig);
  const [srv, setSrv] = useState<SrvSettings | null>(srvSettings);
  useEffect(() => {
    setSrv(srvSettings);
  }, [srvSettings]);
  const [saved, setSaved] = useState(false);
  // 快捷键（原 ShortcutsDialog 逻辑）
  const [map, setMap] = useState<ShortcutMap>(() => getBindings());
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeBindings(setMap), []);
  // 关于（原 AboutDialog 逻辑；仅本地桌面渲染更新区）
  const local = isLocalDesktop();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [update, setUpdate] = useState<Update | null>(null);

  /** 应用：本地模式存服务设置；远程客户端模式应用连接。按钮统一走这里。 */
  const apply = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    if (!showServer) onConnChange(conn);
    else if (srv) onSaveSrv(srv);
  };

  /** 打开脚本日志目录(后端不存在则先建);失败静默,不打断设置页。 */
  const openLogDir = () => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_script_log_dir");
      } catch {
        /* ignore */
      }
    })();
  };

  async function onCheck() {
    setStatus({ state: "checking" });
    const { status: s, update: u } = await checkUpdate();
    setStatus(s);
    setUpdate(u);
  }

  async function onInstall() {
    if (!update) return;
    setStatus({ state: "downloading", percent: 0 });
    const s = await downloadAndInstall(update, (p) =>
      setStatus({ state: "downloading", percent: p }),
    );
    setStatus(s);
  }

  // 键盘：window capture 统一裁决（同原 ShortcutsDialog 的优先级链模式）。
  // 帮助浮层不能单独 useEscClose——双 window 监听会有先后序问题，必须在此统一裁决。
  const downloading = status.state === "downloading" || status.state === "downloadComplete";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && helpOpen) {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
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
        // 裸退格 = 清除该动作的快捷键；带修饰符的组合(mod+alt+backspace)仍是普通候选
        if (combo === "backspace") {
          setBinding(recording, ""); // 空 combo = 解绑，validateCombo 恒放行
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
        if (downloading) return; // 更新流程中不关页（进度指示消失会误暗示已取消）
        e.preventDefault();
        e.stopImmediatePropagation();
        // VS Code 语义：先清搜索词，再关页
        if (query) setQuery("");
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, helpOpen, query, downloading, onClose]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDialogA11y(dialogRef, searchRef);

  const categories = buildSettingsCategories(showServer);
  const filtered = filterSettings(query, categories);
  const queryActive = query.trim().length > 0;
  const visible = queryActive ? filtered : filtered.filter((c) => c.id === active);
  const hitCount = (c: FilteredCategory) =>
    c.items.length + c.shortcutGroups.reduce((s, g) => s + g.actions.length, 0);

  return (
    /* 遮罩按下关闭（所有改动即改即存/显式应用，无未保存丢失顾虑；更新下载中禁止关） */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose, () => downloading)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置" className={"dialog dialog--max dlg-settings" + (max ? "" : " dlg-settings--compact")} onClick={(e) => e.stopPropagation()}>
        {/* 标题条：标题居左、最大化/还原+关闭居右（对照 VS Code 设置窗口的紫条） */}
        <div className="dlg-settings__titlebar">
          <span className="dlg-settings__titlebar-title"><IconGear /> 设置</span>
          <div className="dlg-settings__actions">
            <button
              className="dlg-settings__btn"
              title={max ? "还原" : "最大化"}
              aria-label={max ? "还原" : "最大化"}
              onClick={() => setMax((v) => !v)}
            >
              {max ? <IconWinRestore /> : <IconWinMax />}
            </button>
            <button className="dlg-settings__btn" title="关闭" aria-label="关闭" onClick={onClose}>
              <IconClose />
            </button>
          </div>
        </div>
        <div className="dlg-settings__toolbar">
          <input
            ref={searchRef}
            className="field dlg-settings__search"
            placeholder="搜索设置…"
            aria-label="搜索设置"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="off"
            spellCheck={false}
          />
          {recording && <span className="dlg-settings__recording">按下新组合…（Backspace 清除 · Esc 取消）</span>}
        </div>
        <div className="dlg-settings__body">
          <nav className="dlg-settings__toc" aria-label="设置分类">
            {filtered.map((c) => (
              <button
                key={c.id}
                className="dlg-settings__toc-item"
                aria-current={!queryActive && c.id === active ? "page" : undefined}
                data-active={!queryActive && c.id === active ? "true" : undefined}
                onClick={() => { setQuery(""); setActive(c.id); }}
              >
                {CATEGORY_ICONS[c.id]}<span>{c.label}</span>
                {queryActive && <span className="dlg-settings__toc-count">{hitCount(c)}</span>}
              </button>
            ))}
          </nav>
          <div className="dlg-settings__list">
            {visible.map((c) => (
              <section key={c.id} className="dlg-settings__cat" data-cat={c.id}>
                <h2 className="dlg-settings__cat-title">{c.label}</h2>
                <p className="dlg-settings__cat-desc">{c.description}</p>

                {c.id === "connection" && showServer && !srv && (
                  srvFailed ? (
                    <div className="dlg-settings__srv-state">
                      服务器配置加载失败
                      <button className="btn" onClick={onRetrySrv}>重试</button>
                    </div>
                  ) : (
                    <div className="dlg-settings__srv-state">加载中…</div>
                  )
                )}

                {/* 普通条目行；快捷键/关于的整块自定义渲染不走这里（避免空行重复） */}
                {c.items
                  .filter((it) => it.control !== "about-block" && !it.control.startsWith("shortcut-"))
                  .map((item) => (
                    <SettingRow key={item.id} item={item}>
                      {renderControl(item)}
                    </SettingRow>
                  ))}

                {/* 快捷键分组渲染（条目本身已在 shortcutGroups 过滤，跳过普通条目循环） */}
                {c.shortcutGroups.length > 0 && (
                  <>
                    <div className="dlg-settings__cat-tools">
                      <button
                        className="mini-btn"
                        onMouseDown={(e) => e.preventDefault() /* 不抢焦点 */}
                        onClick={() => setHelpOpen((v) => !v)}
                        title="快捷键操作说明"
                        aria-label="快捷键操作说明"
                        aria-expanded={helpOpen}
                      >
                        <IconInfo /> 说明
                      </button>
                      {/* 浮层锚在本行(position:relative)内,渲染在按钮旁而非页面级——
                          页面级渲染会以设置页根为定位祖先,飘到整页右上角 */}
                      {helpOpen && <ShortcutsHelpPanel onClose={() => setHelpOpen(false)} />}
                    </div>
                    {c.shortcutGroups.map((g) => (
                      <div key={g.title} className="settings-shortcut-group">
                        <h4 className="settings-group-title">{g.title}</h4>
                        {g.actions.map((action) => renderShortcutRow(action))}
                      </div>
                    ))}
                    {error && <p className="editor-error">{error}</p>}
                    <div className="dlg-settings__cat-footer">
                      <button
                        className="btn btn--ghost"
                        onClick={() => {
                          resetAll();
                          setError("");
                        }}
                      >
                        全部重置
                      </button>
                    </div>
                  </>
                )}

                {/* 连接分类尾部：应用区（服务器监听 / 前端连接共用 saved 脉冲） */}
                {c.id === "connection" && (!showServer || !!srv) && (
                  <div className="dlg-settings__cat-footer">
                    {saved && <span className="btn--save-pulse">已应用</span>}
                    <button className="btn btn--primary" onClick={apply}>
                      {showServer ? "应用" : "应用并重连"}
                    </button>
                  </div>
                )}

                {/* 关于分类：整块自定义（版本/仓库/更新） */}
                {c.id === "about" && (
                  <div className="settings-about">
                    <div className="about">
                      <div className="about__mark"><IconPlug /></div>
                      <h3 className="about__name">Serial Studio</h3>
                      <p className="about__version">版本 {version || "…"}</p>
                      <p className="about__tagline">
                        多形态串口通信工具
                        <br />
                        本地 / 远程 双模式 · Tauri + MCP & WebSocket
                        <br />
                        MCP Url http://IP:PORT/mcp
                      </p>
                      <p className="about__repo">
                        {/* Tauri webview 内直接导航会顶掉应用页面 → 拦下交给 opener 开系统浏览器；
                            Web 模式是普通浏览器，走原生 <a> 新标签即可 */}
                        <a
                          href={REPO_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => {
                            if (isTauri()) {
                              e.preventDefault();
                              void openRepoPage();
                            }
                          }}
                        >
                          {REPO_URL}
                        </a>
                      </p>
                      {local && (
                        <div className="about__update">
                          {status.state === "idle" && (
                            <button className="btn btn--primary" onClick={onCheck}>检查更新</button>
                          )}
                          {status.state === "checking" && <p className="about__update-msg">检查中…</p>}
                          {status.state === "upToDate" && <p className="about__update-msg">已是最新版本</p>}
                          {status.state === "available" && (
                            <div className="about__update-available">
                              <p>发现新版本 {status.version}</p>
                              {supportsAutoInstall() ? (
                                <button className="btn btn--primary" onClick={onInstall}>下载并重启</button>
                              ) : (
                                /* macOS 未公证：自动安装后 Gatekeeper 拦到打不开 → 只引导手动下载 */
                                <button className="btn btn--primary" onClick={openReleasesPage}>前往下载</button>
                              )}
                            </div>
                          )}
                          {status.state === "downloading" && (
                            <div className="about__update-progress">
                              <div className="about__progress">
                                <div className="about__progress-fill" style={{ width: `${status.percent ?? 0}%` }} />
                              </div>
                              <p className="about__update-msg">下载中… {status.percent ?? 0}%</p>
                            </div>
                          )}
                          {status.state === "downloadComplete" && (
                            <p className="about__update-msg">下载完成，即将重启…</p>
                          )}
                          {status.state === "failed" && (
                            <div className="about__update-available">
                              <p className="about__update-msg">更新失败：{status.message}</p>
                              <button className="btn" onClick={openReleasesPage}>前往下载</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // ===== 控件分发（闭包持有各域 state，不抽组件） =====

  function renderControl(item: SettingItemDef) {
    switch (item.control) {
      case "theme-select":
        return (
          <div className="settings-theme-choices" role="group" aria-label="颜色主题">
            {APPEARANCE_THEMES.map((choice) => (
              <button
                key={choice.id}
                className="settings-theme-choice"
                aria-pressed={theme === choice.id}
                onClick={() => setTheme(choice.id)}
              >
                <span className={`settings-theme-preview settings-theme-preview--${choice.lum}`} aria-hidden="true"><i /><b /></span>
                <span>{choice.label}{theme === choice.id && <IconCheck />}</span>
              </button>
            ))}
          </div>
        );
      case "font-size-input":
        return (
          <input
            ref={fontInputRef}
            type="number"
            min={FONT_MIN}
            max={FONT_MAX}
            value={fontDraft}
            onChange={(e) => {
              const v = e.target.value;
              setFontDraft(v);
              const n = Number(v);
              // 合法值即时生效（setFontSize 内部 clamp 6–48，订阅回写 fontSize 状态）
              if (v.trim() !== "" && Number.isInteger(n) && n > 0) setFontSize(n);
            }}
            onBlur={() => setFontDraft(String(fontSize))} // 失焦归一化为 clamp 后的当前值
            className="field dlg-settings__num"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      case "srv-text":
        return (
          <input
            value={srv?.ws_host ?? ""}
            onChange={(e) => srv && setSrv({ ...srv, ws_host: e.target.value })}
            className="field dlg-settings__text"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      case "srv-number": {
        const key: "ws_port" | "telnet_port" = item.id === "srv.ws_port" ? "ws_port" : "telnet_port";
        return (
          <input
            type="number"
            value={srv?.[key] ?? ""}
            onChange={(e) => srv && setSrv({ ...srv, [key]: Number(e.target.value) })}
            className="field dlg-settings__num"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      }
      case "srv-checkbox-scripting":
        return (
          <label className="dlg-settings__check">
            <input
              type="checkbox"
              checked={srv?.enable_scripting ?? false}
              onChange={(e) => srv && setSrv({ ...srv, enable_scripting: e.target.checked })}
            />
            <span>允许远程执行 JS 脚本</span>
            <span className="dlg-settings__warn" title="服务器无认证，开启后任何已连接的客户端都可执行脚本（可读写本机文件）。">⚠</span>
          </label>
        );
      case "srv-checkbox-log":
        return (
          <>
            <label className="dlg-settings__check">
              <input
                type="checkbox"
                checked={srv?.script_log_to_disk ?? false}
                onChange={(e) => srv && setSrv({ ...srv, script_log_to_disk: e.target.checked })}
              />
              <span>log 输出自动落盘</span>
              <span className="dlg-settings__warn" title="脚本的运行日志（log函数的输出）自动落盘到 script-logs 目录。">⚠</span>
            </label>
            {/* 直达日志目录,不依赖开关状态(后端不存在则先建) */}
            <button className="btn btn--ghost dlg-settings__minor-btn" onClick={openLogDir}>
              打开目录
            </button>
          </>
        );
      case "conn-text":
        return (
          <input
            value={conn.host}
            onChange={(e) => setConn({ ...conn, host: e.target.value })}
            className="field dlg-settings__text"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      case "conn-number":
        return (
          <input
            type="number"
            value={conn.port}
            onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })}
            className="field dlg-settings__num"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      case "shortcut-action":
      case "shortcut-fixed":
      case "about-block":
        return null; // 整块自定义渲染（快捷键分组 / 关于块），不走 SettingRow 控件位
      default:
        return null;
    }
  }

  /** 快捷键行（原 ShortcutsDialog 行渲染迁入；tab.select 是固定键族，渲染说明行） */
  function renderShortcutRow(action: ActionId) {
    if (action === "tab.select") {
      return (
        <div className="shortcut-row shortcut-row--fixed" key={action}>
          <span className="shortcut-row__label">{ACTION_LABELS[action]}</span>
          <span className="kbd kbd--fixed">{formatCombo("mod+alt+1")}…9</span>
          <span className="shortcut-row__hint">固定</span>
        </div>
      );
    }
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
          aria-label={`重置「${ACTION_LABELS[action]}」为默认键`}
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
  }
}

/** 设置行：VS Code 同构——粗体名 + 说明 + 控件（children）。 */
function SettingRow({ item, children }: { item: SettingItemDef; children: React.ReactNode }) {
  return (
    <div className="settings-row" data-setting={item.id}>
      <div className="settings-row__name">{item.label}</div>
      {item.description && <div className="settings-row__desc">{item.description}</div>}
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

/** 快捷键操作说明浮层（原 ShortcutsDialog 的 ShortcutsHelpPanel 迁入）：
 *  复用脚本编辑器 script-help 的浮层样式。键盘关闭由 SettingsPage 的统一
 *  Esc 优先级链裁决，此处不做键盘处理。 */
function ShortcutsHelpPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref);
  return (
    <>
      {/* 点击面板外(对话框内区域)关闭；同时挡住行区域——帮助开着时点行先关帮助 */}
      <div className="script-help__backdrop" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="快捷键操作说明" className="script-help">
        <div className="script-help__head">
          <span>速查</span>
          <button className="banner__close" onClick={onClose} aria-label="关闭帮助">
            <IconClose />
          </button>
        </div>
        <div className="script-help__row">点击键帽 → 录制新组合</div>
        <div className="script-help__row">录制中 <code>Backspace</code> 清除 / <code>Esc</code> 取消</div>
        <div className="script-help__row">组合须含 Ctrl/⌘ 或 Alt（重连除外）</div>
        <div className="script-help__row">冲突 / 保留键会被拒绝</div>
        <div className="script-help__row"><code>↺</code> 恢复默认 · 「全部重置」恢复全部</div>
      </div>
    </>
  );
}

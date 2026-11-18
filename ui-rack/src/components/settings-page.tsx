/**
 * 设置页（自 serial-studio ui 的 VS Code 式设置移植：搜索 + 分类目录 + 声明式条目）。
 * devicerack 裁剪：无快捷键/更新器/前端连接模式；新增租约条目；服务设置走 /api/settings。
 * Escape 优先级链（VS Code 语义）：先清搜索词，再关页。
 */
import { useEffect, useRef, useState } from "react";
import { THEMES, getTheme, setTheme, subscribe, type Theme } from "../theme";
import { api, type ServerSettings } from "../api";
import { useDialogA11y } from "../primitives";
import { overlayClose } from "./dialogs";
import { AccessSettings } from "./access-settings";
import { IconCheck, IconClose, IconGear, IconInfo, IconLock, IconServer, IconShirt, IconTopology, IconWinMax, IconWinRestore } from "../icons";
import {
  buildSettingsCategories,
  filterSettings,
  type SettingItemDef,
  type SettingsCategoryId,
} from "./settings-registry";

import "./settings-page.css";

const CATEGORY_ICONS = { service: <IconServer />, "remote-access": <IconLock />, appearance: <IconShirt />, about: <IconInfo /> };

export function SettingsPage({
  version,
  settings,
  onClose,
}: {
  version: string;
  settings: ServerSettings | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState<SettingsCategoryId>("service");
  const [query, setQuery] = useState("");
  /** 最大化 ⇄ 紧凑：紧凑=居中卡片（默认打开），最大化=94vw×90vh。 */
  const [max, setMax] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => subscribe(setThemeState), []);
  const [srv, setSrv] = useState<ServerSettings | null>(settings);
  useEffect(() => setSrv(settings), [settings]);
  const [saved, setSaved] = useState(false);

  const apply = () => {
    if (!srv) return;
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    void apiSave(srv);
  };
  const apiSave = async (s: ServerSettings) => {
    try {
      const next = await api.saveSettings(s);
      setSrv(next);
    } catch {
      /* 保存失败静默——错误提示后续接状态栏消息 */
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // VS Code 语义：先清搜索词，再关页
        if (query) setQuery("");
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query, onClose]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDialogA11y(dialogRef, searchRef);

  const categories = buildSettingsCategories();
  const filtered = filterSettings(query, categories);
  const queryActive = query.trim().length > 0;
  const visible = queryActive ? filtered : filtered.filter((c) => c.id === active);
  const hitCount = (c: (typeof filtered)[number]) => c.items.length;

  return (
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className={"dialog dialog--max dlg-settings" + (max ? "" : " dlg-settings--compact")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dlg-settings__titlebar">
          <span className="dlg-settings__titlebar-title">
            <IconGear /> 设置
          </span>
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
        </div>
        <div className="dlg-settings__body">
          <nav className="dlg-settings__toc" aria-label="设置分类">
            {filtered.map((c) => (
              <button
                key={c.id}
                className="dlg-settings__toc-item"
                aria-current={!queryActive && c.id === active ? "page" : undefined}
                data-active={!queryActive && c.id === active ? "true" : undefined}
                onClick={() => {
                  setQuery("");
                  setActive(c.id);
                }}
              >
                {CATEGORY_ICONS[c.id]}
                <span>{c.label}</span>
                {queryActive && <span className="dlg-settings__toc-count">{hitCount(c)}</span>}
              </button>
            ))}
          </nav>
          <div className="dlg-settings__list">
            {visible.map((c) => (
              <section key={c.id} className="dlg-settings__cat" data-cat={c.id}>
                <h2 className="dlg-settings__cat-title">{c.label}</h2>
                <p className="dlg-settings__cat-desc">{c.description}</p>

                {c.id === "service" && !srv && <div className="dlg-settings__srv-state">服务器配置加载中…</div>}

                {c.items
                  .filter((it) => it.control !== "about-block")
                  .map((item) =>
                    item.control === "srv-access" ? (
                      <AccessSettings key={item.id} />
                    ) : (
                      <SettingRow key={item.id} item={item}>
                        {renderControl(item)}
                      </SettingRow>
                    ),
                  )}

                {c.id === "service" && !!srv && (
                  <div className="dlg-settings__cat-footer">
                    {saved && <span className="btn--save-pulse">已应用</span>}
                    <button className="btn btn--primary" onClick={apply}>
                      应用
                    </button>
                  </div>
                )}

                {c.id === "about" && (
                  <div className="settings-about">
                    <div className="about">
                      <div className="about__mark">
                        <IconTopology />
                      </div>
                      <h3 className="about__name">devicerack</h3>
                      <p className="about__version">版本 {version || "…"}</p>
                      <p className="about__tagline">
                        网络设备管理平台 · 设备/拓扑/占用
                        <br />
                        MCP Url {location.origin}/mcp
                      </p>
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

  function renderControl(item: SettingItemDef) {
    switch (item.control) {
      case "theme-select":
        return (
          <div className="settings-theme-choices" role="group" aria-label="颜色主题">
            {THEMES.map((choice) => (
              <button
                key={choice.id}
                className="settings-theme-choice"
                aria-pressed={theme === choice.id}
                onClick={() => setTheme(choice.id)}
              >
                <span className={`settings-theme-preview settings-theme-preview--${choice.lum}`} aria-hidden="true">
                  <i />
                  <b />
                </span>
                <span>
                  {choice.label}
                  {theme === choice.id && <IconCheck />}
                </span>
              </button>
            ))}
          </div>
        );
      case "srv-readonly":
        return (
          <input
            readOnly
            value={
              item.id === "srv.ws_host"
                ? srv?.ws_host ?? ""
                : String(srv?.ws_port ?? "")
            }
            className="field dlg-settings__text"
            autoCapitalize="off"
            spellCheck={false}
            title="监听参数由进程启动时的 --host/--port 决定"
          />
        );
      case "srv-checkbox-scripting":
        return (
          <label className="dlg-settings__check">
            <input
              type="checkbox"
              checked={srv?.enable_scripting ?? false}
              onChange={(e) => srv && setSrv({ ...srv, enable_scripting: e.target.checked })}
            />
            <span>允许执行 JS 脚本</span>
            <span className="dlg-settings__warn" title="启用后已连接的 Agent/客户端可执行脚本（可读写本机文件）。">
              ⚠
            </span>
          </label>
        );
      case "lease-number": {
        const key = item.id === "lease.ttl_minutes" ? "ttl_minutes" : "max_ttl_minutes";
        return (
          <input
            type="number"
            min={1}
            value={srv?.lease?.[key] ?? ""}
            onChange={(e) =>
              srv && setSrv({ ...srv, lease: { ...srv.lease, [key]: Number(e.target.value) } })
            }
            className="field dlg-settings__num"
            autoCapitalize="off"
            spellCheck={false}
          />
        );
      }
      case "lease-checkbox":
        return (
          <label className="dlg-settings__check">
            <input
              type="checkbox"
              checked={srv?.lease?.enable_gate ?? true}
              onChange={(e) =>
                srv && setSrv({ ...srv, lease: { ...srv.lease, enable_gate: e.target.checked } })
              }
            />
            <span>写操作须持租约</span>
          </label>
        );
      case "about-block":
        return null; // 整块自定义渲染
      default:
        return null;
    }
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

/** 对话框族：串口配置、宏/脚本批量导出、设置面板、快捷键改键、关于（含在线更新）、
脚本指南、添加远程设备、脚本运行参数收集、通用确认弹窗。 */
import { useEffect, useRef, useState } from "react";
import type { ActionId, ConnConfig, Macro, Script, ScriptParam, SerialConfig, ShortcutMap, SrvSettings } from "../types";
import { BAUD_RATES, isTauri } from "../lib";
import { ACTION_LABELS, DEFAULT_BINDINGS, eventToCombo, formatCombo, getBindings, resetAll, resetBinding, setBinding, subscribeBindings } from "../shortcuts";
import { checkUpdate, downloadAndInstall, isLocalDesktop, openReleasesPage, supportsAutoInstall, type Update, type UpdateStatus } from "../updater";
import { IconAlert, IconCode, IconCopy, IconExport, IconGear, IconGlobe, IconPlug } from "../icons";
import { ConfigRow, useDialogKeys, useEscClose } from "./primitives";

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
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="可选，描述此端口连接的设备" className="field" autoCapitalize="off" spellCheck={false} />
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


// ===== 宏/脚本批量导出对话框 =====

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
              <input autoFocus value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} className="field" autoCapitalize="off" spellCheck={false} />
            </ConfigRow>
            <ConfigRow label="端口">
              <input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} className="field" autoCapitalize="off" spellCheck={false} />
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
                  <input autoFocus value={srv.ws_host} onChange={(e) => setSrv({ ...srv, ws_host: e.target.value })} className="field" autoCapitalize="off" spellCheck={false} />
                </ConfigRow>
                <ConfigRow label="WS 端口">
                  <input type="number" value={srv.ws_port} onChange={(e) => setSrv({ ...srv, ws_port: Number(e.target.value) })} className="field" autoCapitalize="off" spellCheck={false} />
                </ConfigRow>
                <ConfigRow label="Telnet 端口">
                  <input type="number" value={srv.telnet_port} onChange={(e) => setSrv({ ...srv, telnet_port: Number(e.target.value) })} className="field" autoCapitalize="off" spellCheck={false} />
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


// ===== 关于 / 脚本指南 / 远程 / 参数收集 =====
export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  useEscClose(onClose);
  const local = isLocalDesktop(); // 仅本地桌面模式渲染检查更新（Web/远程窗口不显示）
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [update, setUpdate] = useState<Update | null>(null);

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
            <span className="pip">本地 / 远程</span> 双模式 · Tauri + MCP & WebSocket
            <br />
            <span className="pip">MCP Url</span> http://IP:PORT/mcp
          </p>

          {local && (
            <div className="about__update">
              {status.state === "idle" && (
                <button className="btn" onClick={onCheck}>检查更新</button>
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
                  <p className="about__update-msg">下载中 {status.percent ?? 0}%</p>
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
          <input autoFocus value={input.host} onChange={(e) => onChange({ ...input, host: e.target.value })} placeholder="192.168.1.50" className="field" autoCapitalize="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={input.port} onChange={(e) => onChange({ ...input, port: Number(e.target.value) })} className="field" autoCapitalize="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="昵称">
          <input value={input.nickname} onChange={(e) => onChange({ ...input, nickname: e.target.value })} placeholder="可选，如「实验室机械臂」" className="field" autoCapitalize="off" spellCheck={false} />
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
                onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} autoCapitalize="off" spellCheck={false} />
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


// ===== 确认弹窗（替代浏览器原生 confirm，统一仪器风） =====

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


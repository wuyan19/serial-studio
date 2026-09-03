/** 对话框族：串口配置、宏/脚本批量导出、设置面板、快捷键改键、关于（含在线更新）、
脚本指南、添加远程设备、远程设备详情、脚本运行参数收集、通用确认弹窗。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionId, ConnConfig, Macro, PortInfo, RemoteDevice, Script, ScriptParam, SerialConfig, ShortcutMap, SrvSettings } from "../types";
import { BAUD_RATES, copyText, displayPortName, isTauri, prefillRunValues } from "../lib";
import { ACTION_LABELS, DEFAULT_BINDINGS, eventToCombo, formatCombo, getBindings, resetAll, resetBinding, setBinding, subscribeBindings } from "../shortcuts";
import { checkUpdate, downloadAndInstall, isLocalDesktop, openReleasesPage, openRepoPage, REPO_URL, supportsAutoInstall, type Update, type UpdateStatus } from "../updater";
import { IconAlert, IconCode, IconCopy, IconExport, IconGear, IconGlobe, IconKeyboard, IconPlug } from "../icons";
import { ConfigRow, useDialogA11y, useDialogKeys, useEscClose } from "./primitives";
import { marked } from "marked";

/** 遮罩点击关闭的统一判定:必须 mousedown 起点就是遮罩本身。
 *  不能用 onClick——框内选字拖到遮罩上松手时,click 会派发到公共祖先(恰是遮罩),
 *  target 判断防不住,误关丢选区。mousedown 判定是标准方案(react-modal 同款)。 */
function overlayClose(e: React.MouseEvent, onClose: () => void, guard?: () => boolean) {
  if (e.target !== e.currentTarget) return; // 按下点在对话框内
  if (guard?.()) return; // 上下文不允许关(如下载进行中)
  onClose();
}

// ===== marked 安全配置(脚本指南 Markdown 预览) =====
// SKILL 文本并非始终可信:local 模式来自二进制内嵌文档,但远程窗口/Web 模式下
// 经 transport 取自所连 ss-server(默认无认证),恶意/被劫持的远端可返回任意文本。
// marked 默认放行内联 HTML → 直接 innerHTML 即注入(远程窗口带 Tauri IPC 特权)。
// 这里剥离一切 HTML 块/内联,链接 href 仅放行 http(s)/mailto/#/相对锚点。
marked.use({
  async: false,
  renderer: {
    html: () => "",
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return /^(https?:|mailto:|#)/i.test(href ?? "") ? `<a href="${href}">${text}</a>` : text;
    },
  },
});

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
  // 键盘走 window 级监听而非按钮焦点:双击端口行弹框时,第二次 click 的 mousedown
  // 默认行为会把焦点从「打开」按钮抢到 body,焦点方案下 Enter 直接失灵。
  useDialogKeys({ onClose: onCancel, onEnter: () => onConfirm(config, alias) });
  // 别名是端口语义（每端口独立），用内部状态；config 仍是受控（跨端口沿用）。
  // 调用方 key={port} 保证换端口时重挂、状态重置。
  const [alias, setAlias] = useState(initialAlias);
  const [baud, setBaud] = useState(String(config.baud_rate));
  // 波特率自由输入态(初始:现值不在常用档里则直接进入,如重开 250000 的端口)
  const [customBaud, setCustomBaud] = useState(() => !BAUD_RATES.includes(config.baud_rate));
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="打开串口" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconPlug /> OPEN PORT
        </h3>
        <div className="dialog__sub">{port}</div>
        <ConfigRow label="别名">
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="可选，留空清除" className="field" autoCapitalize="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="波特率">
          {/* 常用档 select + 「自定义…」切自由输入(如 250000,WS2812/DMX 常用)。
              datalist 会被已填值前缀过滤、天然不给全列表,故不用。
              自由输入的 string 态承接中间态,仅合法正整数上抛;失焦非法则回退下拉并恢复上个合法值。 */}
          {customBaud ? (
            <>
              <input
                autoFocus
                inputMode="numeric"
                value={baud}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setBaud(v);
                  const n = Number(v);
                  if (v !== "" && Number.isInteger(n) && n > 0) onChange({ ...config, baud_rate: n });
                }}
                onBlur={() => {
                  const n = Number(baud);
                  if (!(baud !== "" && Number.isInteger(n) && n > 0)) {
                    setCustomBaud(false);
                    setBaud(String(config.baud_rate));
                  }
                }}
                placeholder="如 250000"
                className="field"
                autoCapitalize="off"
                spellCheck={false}
              />
              {/* 合法自定义值也要有回下拉的出口(下方 select 有动态 option 兜住显示) */}
              <button type="button" className="mini-btn" title="回到常用档下拉" aria-label="回到常用档下拉" onClick={() => setCustomBaud(false)}>↺</button>
            </>
          ) : (
            <select
              value={config.baud_rate}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  setCustomBaud(true);
                } else {
                  setBaud(e.target.value);
                  onChange({ ...config, baud_rate: Number(e.target.value) });
                }
              }}
              className="field-select"
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              {/* 现值不在常用档(如自定义后回退/重开 250000 端口):动态 option 兜住,
                  否则 select 无匹配项渲染空白、显示与实际不符 */}
              {!BAUD_RATES.includes(config.baud_rate) && (
                <option value={config.baud_rate}>{config.baud_rate}（自定义）</option>
              )}
              <option value="custom">自定义…</option>
            </select>
          )}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    /* 遮罩按下关闭(勾选列表误点代价低,重开即可;Esc/Enter 键盘语义不变) */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onCancel)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="导出宏" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
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
  const scriptDialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(scriptDialogRef);
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div ref={scriptDialogRef} role="dialog" aria-modal="true" aria-label="导出脚本" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
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
  srvFailed,
  onRetrySrv,
  onConnChange,
  onSaveSrv,
  showServer,
  onClose,
}: {
  connConfig: ConnConfig;
  srvSettings: SrvSettings | null;
  /** get_settings 失败(srvSettings 为 null 时区分「加载中」与「失败」)。 */
  srvFailed?: boolean;
  onRetrySrv?: () => void;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
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
                      title="默认关闭:服务器无认证,开启后任何能连到端口的客户端可执行脚本——脚本可读宿主机文件(任意路径,暂无白名单),无写入/网络访问。暴露到非信任网络前,务必绑定 127.0.0.1 或加防火墙/VPN。"
                      style={{ cursor: "help" }}
                    >
                      ⚠
                    </span>
                  </label>
                </ConfigRow>
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
            ) : srvFailed ? (
              <div style={{ color: "var(--danger)", display: "flex", alignItems: "center", gap: 10 }}>
                服务器配置加载失败
                <button className="btn" onClick={onRetrySrv}>重试</button>
              </div>
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

/** 分组卡片展示(两列手工配平:左列 = 前两组,右列 = 后三组)。
 *  注意:新增 ActionId 时除了同步 types.ts 的 ActionId 联合与 shortcuts.ts 的
 *  DEFAULT_BINDINGS/ACTION_LABELS,也要加进对应组——改键对话框只渲染这些组,
 *  漏加则该动作在改键页不可见(快捷键仍生效,只是无法在此改键)。
 *  tab.select 特殊:一族固定键(Ctrl+Alt+1..9),落在「标签页」组渲染为说明行。 */
const SHORTCUT_GROUPS: { title: string; items: ActionId[] }[] = [
  {
    title: "面板与搜索",
    items: [
      "search.open",
      "macro.palette",
      "script.palette",
      "port.palette",
      "activity.toggle-ports",
      "activity.toggle-macros",
      "activity.toggle-scripts",
    ],
  },
  {
    title: "端口与设备",
    items: ["port.refresh", "port.close-active", "port.reconnect", "remote.open"],
  },
  { title: "标签页", items: ["tab.next", "tab.prev", "tab.select"] },
  { title: "显示与外观", items: ["zoom.in", "zoom.out", "zoom.reset", "theme.toggle"] },
  { title: "应用", items: ["settings.open", "about.open"] },
];

/** 快捷键改键对话框：分 5 组卡片两列展示动作 + 当前组合，点键帽进入录制；行内 / 全部重置。
 *  模态打开时 App 的全局 listener 已被抑制，这里的录制 listener 独占 keydown。
 *  录制中：读下一组非纯修饰符 keydown → setBinding 校验；Esc 取消录制。
 *  非录制：Esc 关闭对话框。 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [map, setMap] = useState<ShortcutMap>(() => getBindings());
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState("");
  // Web 页面端(!isTauri)只隐藏 remote.open(已处远程,再开远程无意义);其余均显示
  const groups = SHORTCUT_GROUPS.map((g) => ({
    ...g,
    items: isTauri() ? g.items : g.items.filter((a) => a !== "remote.open"),
  }));
  // 两列配平:左列(7+4 行)≈ 右列(3+4+2 行 + 多一个卡片头)
  const columns: { title: string; items: ActionId[] }[][] = [
    [groups[0], groups[1]],
    [groups[2], groups[3], groups[4]],
  ];

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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    /* 遮罩按下关闭(改键即改即存,无"未保存丢失"顾虑;Esc 语义不变) */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="键盘快捷键" className="dialog dialog--med dialog--shortcuts" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconKeyboard /> SHORTCUTS
        </h3>

        <div className="shortcut-list">
          {columns.map((col, ci) => (
            <div className="shortcut-col" key={ci}>
              {col.map((g) => (
                <section className="shortcut-group" key={g.title}>
                  <h4 className="shortcut-group__title">{g.title}</h4>
                  {g.items.map((action) => {
                    if (action === "tab.select") {
                      // tab.select 是一族键(Ctrl+Alt+1..9,0→末个),不可改键——静态说明行
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
                  })}
                </section>
              ))}
            </div>
          ))}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    /* 遮罩按下关闭(local 模式的更新流程是有状态操作:下载中/下载完成禁止遮罩关——
     * 否则进度指示消失而 downloadAndInstall 仍在跑,应用会在用户以为已取消的时刻突然重启) */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose, () => status.state === "downloading" || status.state === "downloadComplete")}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="关于 Serial Studio" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="about">
          <div className="about__mark">
            <IconPlug />
          </div>
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
          {/* Web/远程模式没有更新区(仅 local 渲染)——保留一个关闭按钮,
              否则对话框内零可聚焦元素,Tab 被圈闭逻辑吞掉,键盘用户只剩不可见的 Esc 出口 */}
          {!local && (
            <button className="btn btn--primary" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 脚本编写指南(SKILL 全文):查看 + 一键复制给外部 Agent(Claude/Cursor 等)。
 *  默认 Markdown 预览(阅读),可切原文(等宽 pre-wrap,核对 Markdown 源);
 *  复制的始终是 SKILL.md 原文,粘给 Agent 即完整 skill。 */
export function ScriptSkillDialog({
  text,
  failed,
  onRetry,
  onClose,
}: {
  text: string | null;
  /** 拉取失败(null 时区分「加载中」与「失败」)。 */
  failed?: boolean;
  onRetry?: () => void;
  onClose: () => void;
}) {
  useEscClose(onClose);
  const [copied, setCopied] = useState(false);
  const [raw, setRaw] = useState(false); // true=原文,默认 Markdown 预览
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  // 只依赖 text 缓存——App 高频重渲染(串口收发)不重复 parse;安全性见模块头 marked.use
  const html = useMemo(
    () => (text ? marked.parse(text, { async: false }) : ""),
    [text]
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板 API 失败(罕见,如非安全上下文)静默:<pre> 仍可手动选文复制
    }
  };
  return (
    /* 遮罩按下关闭(纯阅读无输入;Esc 同) */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="脚本编写指南" className="dialog dialog--wide dialog--macro" onClick={(e) => e.stopPropagation()}>
        <div className="macro-editor__head">
          <h3 className="dialog__title">脚本编写指南</h3>
          <div className="dialog__sub">
            SKILL 全文
          </div>
        </div>
        <div className="macro-editor__scroll">
          {failed ? (
            <div style={{ padding: "24px 8px", textAlign: "center" }}>
              <p style={{ color: "var(--danger)", margin: "0 0 12px" }}>指南加载失败，请检查连接后重试。</p>
              <button className="btn" onClick={onRetry}>重试</button>
            </div>
          ) : raw ? (
            <pre className="script-skill__pre">{text ?? "加载中…"}</pre>
          ) : (
            <div
              className="script-skill__md"
              dangerouslySetInnerHTML={{ __html: html || "<p>加载中…</p>" }}
            />
          )}
        </div>
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--primary" onClick={copy} disabled={failed || !text}>
              <IconCopy /> {copied ? "已复制 ✓" : "复制全文"}
            </button>
            <button className="btn btn--ghost" onClick={() => setRaw((v) => !v)} disabled={failed || !text}>
              {raw ? "Markdown 预览" : "查看原文"}
            </button>
          </div>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteDialog({ input, onChange, onConfirm, onCancel, existing }: {
  input: { host: string; port: number; nickname: string };
  onChange: (v: { host: string; port: number; nickname: string }) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 已存在设备地址列表（"host:port"），用于重复拦截 */
  existing: string[];
}) {
  const host = input.host.trim();
  const dup = host !== "" && existing.includes(`${host}:${input.port}`);
  const invalid = host === "" || dup;
  // Enter 是 window 级监听,不看按钮 disabled——主操作必须自带校验,否则键盘路径绕过拦截
  useDialogKeys({ onClose: onCancel, onEnter: () => { if (!invalid) onConfirm(); } });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="添加远程设备" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGlobe /> 添加远程设备
        </h3>
        <div className="dialog__sub">连接远程 Serial Studio 服务</div>
        <ConfigRow label="地址">
          <input autoFocus value={input.host} onChange={(e) => onChange({ ...input, host: e.target.value })} placeholder="192.168.1.50" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={input.port} onChange={(e) => onChange({ ...input, port: Number(e.target.value) })} className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="昵称">
          <input value={input.nickname} onChange={(e) => onChange({ ...input, nickname: e.target.value })} placeholder="可选，如「实验室机械臂」" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        {dup && (
          <p className="dialog__hint" style={{ color: "var(--danger)" }}>
            已存在同地址设备 {host}:{input.port}，无需重复添加。
          </p>
        )}
        <p className="dialog__hint">将作为远程设备卡加入串口列表，展开即按需连接。</p>
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={onConfirm} disabled={invalid} title={host === "" ? "请填写设备地址" : undefined}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

/** 远程设备详情：只读信息卡（地址/昵称/设备 ID/连接状态/远端端口），地址与 ID 可一键复制。
 *  数据由 App 每 render 注入（按 id 实时查找）——弹窗开着时昵称/在线态/端口变化即时刷新；
 *  设备被删除时 App 侧查无此 id 即不再渲染，弹窗自然消失。 */
export function RemoteDetailDialog({ dev, online, ports, onClose }: {
  dev: RemoteDevice;
  /** WS 就绪三态：undefined=连接中（与侧栏设备卡状态点同源）。 */
  online?: boolean;
  ports: PortInfo[];
  onClose: () => void;
}) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  const [copied, setCopied] = useState<"addr" | "id" | null>(null);
  // 双按钮共用一个 copied 态:后点的清掉前一个的定时器,否则旧 timer 提前抹掉新按钮的"已复制"
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(copyTimer.current ?? undefined), []);
  const copy = async (tag: "addr" | "id", text: string) => {
    // copyText 带 execCommand 兜底(Web-LAN 形态 http 非安全上下文无 navigator.clipboard);
    // 失败仍静默:值区已入 user-select 白名单,可手动选文复制
    if (!(await copyText(text))) return;
    setCopied(tag);
    clearTimeout(copyTimer.current ?? undefined);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };
  const copyBtn = (tag: "addr" | "id", text: string, title: string) => (
    <button
      className="btn btn--ghost"
      onClick={() => void copy(tag, text)}
      title={title}
      aria-label={copied === tag ? `已复制：${text}` : `${title}（${text}）`}
    >
      <IconCopy /> {copied === tag ? "已复制 ✓" : "复制"}
    </button>
  );
  // 三态与侧栏设备卡状态点同构:在线=绿 / 离线=红 / 连接中=灰
  const status =
    online === true ? (
      <><span className="dot on" /> 在线</>
    ) : online === false ? (
      <><span className="dot off" /> 离线</>
    ) : (
      <><span className="dot" /> 连接中…</>
    );
  // 端口可见性与侧栏设备卡空态同一套语义：离线=未连接，连接中无快照，在线列出远端口名
  const portsText =
    online === undefined
      ? "连接中…"
      : online === false
        ? "未连接"
        : ports.length === 0
          ? "无可用端口"
          : ports.map((p) => displayPortName(p.name)).join(" · ");
  return (
    /* 遮罩按下关闭（纯只读信息，无输入；Esc 同） */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`设备详情 ${dev.nickname?.trim() || `${dev.host}:${dev.port}`}`} className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGlobe /> 设备详情
        </h3>
        <div className="dialog__sub">{dev.nickname?.trim() || `${dev.host}:${dev.port}`}</div>
        <ConfigRow label="地址">
          <span className="detail-row">
            <span className="detail-row__value">{dev.host}:{dev.port}</span>
            {copyBtn("addr", `${dev.host}:${dev.port}`, "复制地址")}
          </span>
        </ConfigRow>
        <ConfigRow label="昵称">
          <span className="detail-row">
            <span className="detail-row__value">{dev.nickname?.trim() || "未设置"}</span>
          </span>
        </ConfigRow>
        <ConfigRow label="设备 ID">
          <span className="detail-row">
            <span className="detail-row__value">{dev.id}</span>
            {copyBtn("id", dev.id, "复制设备 ID")}
          </span>
        </ConfigRow>
        <ConfigRow label="状态">{status}</ConfigRow>
        <ConfigRow label="端口">{portsText}</ConfigRow>
        <p className="dialog__hint">设备 ID 是该设备的稳定标识（MCP 寻址等用途），重连/改名不变。</p>
        <div className="btn-row">
          <button className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 运行时参数收集:按脚本声明 params 渲染表单(string/file→输入框(file 带浏览)、
 *  select→下拉),确认回调 args。预填上次运行的值(initialValues,App 侧 localStorage
 *  缓存)——二次运行只改要动的参数;行内 ↺ / 底部「全部重置」回到声明默认(与快捷键
 *  对话框同款交互,↺ 变淡即已是默认,扫一眼就知道哪些参数被改过)。 */
export function ScriptRunParamsDialog({ scriptName, params, initialValues, onConfirm, onCancel }: {
  scriptName: string;
  params: ScriptParam[];
  /** 上次运行的实际参数(localStorage 缓存);无缓存(首次/清库)时全按声明默认。 */
  initialValues?: Record<string, string>;
  onConfirm: (args: Record<string, string>) => void;
  onCancel: () => void;
}) {
  // defaults 与 values 拆开:前者是重置目标(声明默认),后者随预填/编辑变化
  const defaults = useMemo(() => prefillRunValues(params, undefined), [params]);
  const [values, setValues] = useState<Record<string, string>>(() => prefillRunValues(params, initialValues));
  const setOne = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));
  // file 参数"浏览":原生文件选择框(tauri command + rfd);Web/远程窗形态手输路径,不显示按钮
  const [browseErr, setBrowseErr] = useState("");
  const browseFile = async (name: string) => {
    setBrowseErr("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const picked = (await invoke("pick_open_file")) as string | null;
      if (picked) setOne(name, picked);
    } catch (e) {
      // rfd 取消返回 null 走上面;到这里是调用真失败(如命令未注册)——提示后仍可手输路径
      setBrowseErr(String(e));
    }
  };
  useDialogKeys({ onClose: onCancel, onEnter: () => onConfirm(values) });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`运行参数 ${scriptName}`} className="dialog dialog--narrow run-params" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title"><IconCode /> 运行参数</h3>
        <div className="dialog__sub">{scriptName}</div>
        {params.map((p) => (
          <ConfigRow key={p.name} label={p.label || p.name}>
            {p.type === "select" ? (
              <select className="field" value={values[p.name] ?? ""}
                onChange={(e) => setOne(p.name, e.target.value)}>
                {(p.options ?? []).filter((o) => o).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <>
                <input className="field" value={values[p.name] ?? ""}
                  onChange={(e) => setOne(p.name, e.target.value)} autoCapitalize="off" spellCheck={false} />
                {p.type === "file" && isTauri() && (
                  <button type="button" className="mini-btn" title="浏览文件"
                    aria-label={`浏览选择「${p.label || p.name}」文件`}
                    onClick={() => void browseFile(p.name)}>
                    …
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="mini-btn"
              title="重置默认"
              aria-label={`重置「${p.label || p.name}」为默认值`}
              disabled={values[p.name] === defaults[p.name]}
              onClick={() => setOne(p.name, defaults[p.name])}
            >
              ↺
            </button>
          </ConfigRow>
        ))}
        {browseErr && (
          <div className="dialog__sub" role="alert">浏览失败: {browseErr}(可手动输入路径)</div>
        )}
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <button className="btn btn--ghost" onClick={() => setValues(defaults)}>恢复默认</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--ghost" onClick={onCancel}>取消</button>
            <button className="btn btn--primary" onClick={() => onConfirm(values)}>运行</button>
          </div>
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
  confirmText,
  cancelText = "取消",
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  icon?: React.ReactNode;
  message: React.ReactNode;
  /** 动词式按钮文案（「删除」「解散」…），必填以防退化为泛化「确定」。 */
  confirmText: string;
  cancelText?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Enter 确认 / Esc 取消——与搜索框一致的键盘语义。遮罩不关闭（防误触，同其它对话框）。
  // danger（删除/强关等破坏性操作）Enter 落到取消:连击回车不该直接执行不可恢复动作。
  // 键盘走 useDialogKeys(栈仲裁:叠在编辑器上时只响栈顶,不再与下层 Esc 监听双触发)。
  useDialogKeys({ onClose: onCancel, onEnter: () => (tone === "danger" ? onCancel() : onConfirm()) });
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // danger 时初始焦点在「取消」(经 useDialogA11y 的 initialFocus,而非 autoFocus——后者会
  // 污染 prev 捕获,导致确认框关闭后焦点丢 body、逃出仍在的编辑器)
  useDialogA11y(dialogRef, tone === "danger" ? cancelRef : undefined);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-label={title} className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          {icon ?? <IconAlert />} {title}
        </h3>
        <div className="dialog__sub">{message}</div>
        <div className="btn-row">
          <button ref={cancelRef} className="btn btn--ghost" onClick={onCancel}>
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


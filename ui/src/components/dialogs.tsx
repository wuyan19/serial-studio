/** 对话框族：串口配置、宏/脚本批量导出、脚本指南、添加远程设备、
远程设备详情、脚本运行参数收集、通用确认弹窗。设置/快捷键/关于已并入 settings-page.tsx。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Macro, PortInfo, RemoteDevice, Script, ScriptParam, SerialConfig, SshAuth, SshHost, SshOpenError, SshTestState } from "../types";
import { BAUD_RATES, copyText, displayPortName, isTauri, prefillRunValues } from "../lib";
import { IconAlert, IconCode, IconCopy, IconExport, IconGlobe, IconPlug, IconSsh } from "../icons";
import { ConfigRow, overlayClose, useDialogA11y, useDialogKeys, useEscClose } from "./primitives";
import { marked } from "marked";

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
        <ConfigRow label="自动换行符">
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
        <div className="dialog__sub">勾选要导出的宏（可再导入）</div>
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
        <div className="dialog__sub">勾选要导出的脚本（可再导入）</div>
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


// ===== 脚本指南 / 远程 / 参数收集 =====
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

/** 通用设备详情（remote ss / SSH / 本机）：只读信息卡，值可复制。
 *  数据由 App 每 render 归一化注入（按 id 实时查找）——弹窗开着时变化即时刷新；
 *  设备被删时 App 侧查无此 id 即不再渲染，弹窗自然消失。 */
export interface DeviceDetailInfo {
  icon: "globe" | "ssh" | "plug";
  /** 弹窗副标题（设备名）。 */
  label: string;
  /** 信息行（copy=true 的行带复制按钮）。 */
  rows: { label: string; value: string; copy?: boolean }[];
  /** 就绪三态：undefined=连接中（与侧栏设备卡状态点同源）；本机恒 true。
   *  SSH 等无连接态语义的设备用 statusNode 覆盖，不落此三态。 */
  online?: boolean;
  /** 状态行覆盖（SSH：空闲/活动会话；级联设备：透传 online）。提供则忽略 online 三态。 */
  statusNode?: React.ReactNode;
  ports: PortInfo[];
  /** 端口行文本覆盖。提供则忽略 online 三态推导（连接中/未连接）。 */
  portsText?: string;
  hint?: string;
}

export function DeviceDetailDialog({ info, onClose }: {
  info: DeviceDetailInfo;
  onClose: () => void;
}) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  const [copied, setCopied] = useState<number | null>(null);
  // 多按钮共用一个 copied 态:后点的清掉前一个的定时器,否则旧 timer 提前抹掉新按钮的"已复制"
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(copyTimer.current ?? undefined), []);
  const copy = async (tag: number, text: string) => {
    // copyText 带 execCommand 兜底(Web-LAN 形态 http 非安全上下文无 navigator.clipboard);
    // 失败仍静默:值区已入 user-select 白名单,可手动选文复制
    if (!(await copyText(text))) return;
    setCopied(tag);
    clearTimeout(copyTimer.current ?? undefined);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };
  const copyBtn = (tag: number, text: string, title: string) => (
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
    info.online === true ? (
      <><span className="dot on" /> 在线</>
    ) : info.online === false ? (
      <><span className="dot off" /> 离线</>
    ) : (
      <><span className="dot" /> 连接中…</>
    );
  // 端口可见性与侧栏设备卡空态同一套语义：离线=未连接，连接中无快照，在线列出端口名
  const portsText =
    info.online === undefined
      ? "连接中…"
      : info.online === false
        ? "未连接"
        : info.ports.length === 0
          ? "无可用端口"
          : info.ports.map((p) => displayPortName(p.name)).join(" · ");
  const icon =
    info.icon === "globe" ? <IconGlobe /> : info.icon === "ssh" ? <IconSsh /> : <IconPlug />;
  return (
    /* 遮罩按下关闭（纯只读信息，无输入；Esc 同） */
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`设备详情 ${info.label}`} className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          {icon} 设备详情
        </h3>
        <div className="dialog__sub">{info.label}</div>
        {info.rows.map((r, i) => (
          <ConfigRow key={r.label} label={r.label}>
            <span className="detail-row">
              <span className="detail-row__value">{r.value}</span>
              {r.copy === true && copyBtn(i, r.value, `复制${r.label}`)}
            </span>
          </ConfigRow>
        ))}
        <ConfigRow label="状态">{info.statusNode ?? status}</ConfigRow>
        <ConfigRow label="端口">{info.portsText ?? portsText}</ConfigRow>
        {info.hint && <p className="dialog__hint">{info.hint}</p>}
        <div className="btn-row">
          <button className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 端口/端点详情：只读信息卡（端口键/属主设备/类别/状态/配置），值可复制。
 *  数据由 App 每 render 归一化注入（按 pid 实时查行）——弹窗开着时状态变化即时
 *  刷新；行消失（设备删除）时 App 侧查无即不再渲染，弹窗自然消失。 */
export interface PortDetailInfo {
  icon: "plug" | "ssh";
  /** 弹窗副标题（端点显示名）。 */
  label: string;
  /** 信息行（copy=true 的行带复制按钮）。 */
  rows: { label: string; value: string; copy?: boolean }[];
  hint?: string;
}

export function PortDetailDialog({ info, onClose }: {
  info: PortDetailInfo;
  onClose: () => void;
}) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  const [copied, setCopied] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(copyTimer.current ?? undefined), []);
  const copy = async (tag: number, text: string) => {
    if (!(await copyText(text))) return;
    setCopied(tag);
    clearTimeout(copyTimer.current ?? undefined);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };
  const copyBtn = (tag: number, text: string, title: string) => (
    <button
      className="btn btn--ghost"
      onClick={() => void copy(tag, text)}
      title={title}
      aria-label={copied === tag ? `已复制：${text}` : `${title}（${text}）`}
    >
      <IconCopy /> {copied === tag ? "已复制 ✓" : "复制"}
    </button>
  );
  return (
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`端口详情 ${info.label}`} className="dialog dialog--med" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          {info.icon === "ssh" ? <IconSsh /> : <IconPlug />} 端口详情
        </h3>
        <div className="dialog__sub">{info.label}</div>
        {info.rows.map((r, i) => (
          <ConfigRow key={r.label} label={r.label}>
            <span className="detail-row">
              <span className="detail-row__value">{r.value}</span>
              {r.copy === true && copyBtn(i, r.value, `复制${r.label}`)}
            </span>
          </ConfigRow>
        ))}
        {info.hint && <p className="dialog__hint">{info.hint}</p>}
        <div className="btn-row">
          <button className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== SSH device management =====

/** 认证方式短标签（管理表/详情共用）。 */
export function sshAuthLabel(auth: SshAuth): string {
  return auth.type === "key" ? "密钥" : auth.type === "agent" ? "Agent" : "密码";
}

/** SSH 管理弹窗：设备 CRUD + 测试连接（列表视图）⇄ 表单视图（添加/编辑）单弹窗切换。
 *  只管设备，不提供连接——连接（开终端会话）是 PORTS 面板的事。
 *  右键「编辑设备」等不经列表的直达编辑走 SshEditDialog（独立弹窗），不进这里。
 *  Esc 语义随视图走：列表 = 关闭弹窗，表单 = 返回列表。 */
export function SshManagerDialog({
  hosts,
  testOf,
  onCommit,
  onDelete,
  onTest,
  onClose,
}: {
  hosts: SshHost[];
  testOf: (id: string) => SshTestState | undefined;
  /** 保存设备（isNew 区分添加/编辑；新建时 id 为空串，App 负责生成 UUID）。 */
  onCommit: (host: SshHost, isNew: boolean) => void;
  onDelete: (host: SshHost) => void;
  onTest: (host: SshHost) => void;
  onClose: () => void;
}) {
  // 表单只在管理列表内部切换(添加/编辑行按钮);右键等直达编辑走独立的 SshEditDialog
  const [form, setForm] = useState<null | { mode: "add" } | { mode: "edit"; host: SshHost }>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(5);
  const pageCount = Math.max(1, Math.ceil(hosts.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageHosts = hosts.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  // 列表视图 Esc 关弹窗；表单视图开着时本监听让位（表单自己的 Esc=返回列表，对话框栈仲裁）
  useEscClose(() => {
    if (form === null) onClose();
    else setForm(null);
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <>
      {/* 列表常驻挂载,表单作为第二层 overlay 叠上(子页深度感:列表在底下变暗,
          添加/返回无塌掉重建的闪烁)。右键等直达编辑不经这里,走独立的 SshEditDialog
          ——双模态叠加的观感问题只存在于直达路径,列表内部叠加是自然的。 */}
      <div className="dialog-overlay">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="SSH 设备"
          className="dialog dialog--med"
          onMouseDown={(e) => overlayClose(e, onClose)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog__head-row">
            <h3 className="dialog__title">
              <IconSsh /> SSH 设备
            </h3>
            <button className="mini-btn" onClick={() => setForm({ mode: "add" })} title="添加 SSH 设备">
              ＋ 添加
            </button>
          </div>
          {hosts.length === 0 ? (
            <p className="dialog__hint ssh-table__empty">暂无 SSH 设备，点「＋ 添加」创建。</p>
          ) : (
            <div className="ssh-table">
              <div className="ssh-table__row ssh-table__head">
                <span>设备</span>
                <span>认证</span>
                <span>测试</span>
                <span>操作</span>
              </div>
              {pageHosts.map((h) => {
                const test = testOf(h.id);
                const tst = test?.status;
                const testText = tst === "testing" ? "…" : tst === "ok" ? "✓" : tst === "fail" ? "✗" : "—";
                return (
                  <div key={h.id} className="ssh-table__row">
                    <span className="ssh-table__dev" title={`${h.username}@${h.host}:${h.port}`}>
                      <span className="ssh-table__name">{h.nickname?.trim() || `${h.username}@${h.host}`}</span>
                      <span className="ssh-table__addr">
                        {h.username}@{h.host}:{h.port}
                      </span>
                    </span>
                    <span className="ssh-table__auth">{sshAuthLabel(h.auth)}</span>
                    <span className={`ssh-table__status${tst === "ok" ? " ok" : ""}${tst === "fail" ? " bad" : ""}`} title={tst === "ok" ? "可达" : test?.message}>
                      {testText}
                    </span>
                    <span className="ssh-table__actions">
                      <button className="mini-btn" onClick={() => setForm({ mode: "edit", host: h })}>
                        编辑
                      </button>
                      <button className="mini-btn" onClick={() => onTest(h)} disabled={tst === "testing"}>
                        测试
                      </button>
                      <button className="mini-btn mini-btn--danger" onClick={() => onDelete(h)}>
                        删除
                      </button>
                    </span>
                    {tst === "fail" && test?.message && <span className="ssh-table__error" role="status">{test.message}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {hosts.length > 0 && <nav className="ssh-pagination" aria-label="SSH 设备分页">
            <span className="ssh-pagination__total">共 {hosts.length} 台</span>
            <label className="ssh-pagination__size">每页
              <select aria-label="每页设备数" value={pageSize} onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}>
                {[5, 10, 20].map(size => <option key={size} value={size}>{size} 台</option>)}
              </select>
            </label>
            <div className="ssh-pagination__pages">
              <button type="button" className="ssh-pagination__button" aria-label="上一页" title="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button>
              <span className="ssh-pagination__position" aria-live="polite" aria-atomic="true">第 {currentPage + 1} / {pageCount} 页</span>
              <button type="button" className="ssh-pagination__button" aria-label="下一页" title="下一页" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>›</button>
            </div>
          </nav>}
          <div className="btn-row">
            <button className="btn btn--primary" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
      {form && (
        <SshHostForm
          initial={form.mode === "edit" ? form.host : null}
          existing={hosts}
          onBack={() => setForm(null)}
          backLabel="返回"
          onSave={(h) => {
            onCommit(h, form.mode === "add");
            setForm(null); // 回列表,可见更新后的行
          }}
        />
      )}
    </>
  );
}

/** 独立 SSH 设备编辑弹窗：右键「编辑设备」/认证失败弹窗的「编辑设备」直达入口。
 *  表单被两处复用（管理列表内部切换 + 此处的独立打开），故从管理弹窗拆出——
 *  这里无列表可返，取消 = 关闭，保存 = 提交并关闭；用户意图是改这一台，不是浏览。 */
export function SshEditDialog({
  host,
  existing,
  onCommit,
  onClose,
}: {
  host: SshHost;
  existing: SshHost[];
  onCommit: (host: SshHost, isNew: boolean) => void;
  onClose: () => void;
}) {
  return (
    <SshHostForm
      initial={host}
      existing={existing}
      onBack={onClose}
      backLabel="关闭"
      onSave={(h) => {
        onCommit(h, false);
        onClose();
      }}
    />
  );
}

/** SSH 设备表单：添加/编辑共用。编辑态密码留空 = 沿用已存密码（不回显）；
 *  地址重复内联拦截（Enter 是 window 级监听，主操作必须自带校验防键盘路径绕过）。 */
function SshHostForm({
  initial,
  existing,
  onBack,
  backLabel,
  onSave,
}: {
  /** 编辑时的原设备；添加为 null。 */
  initial: SshHost | null;
  /** 既有设备（重复地址校验；编辑时排除自身）。 */
  existing: SshHost[];
  onBack: () => void;
  /** 左侧退出按钮文案：落点是回列表传「返回」，直接关弹窗传「关闭」。 */
  backLabel: string;
  onSave: (host: SshHost) => void;
}) {
  const isEdit = initial !== null;
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [nickname, setNickname] = useState(initial?.nickname ?? "");
  const [authType, setAuthType] = useState<SshAuth["type"]>(initial?.auth.type ?? "key");
  const [keyPath, setKeyPath] = useState(
    initial?.auth.type === "key" ? initial.auth.keyPath : "~/.ssh/id_ed25519",
  );
  const [password, setPassword] = useState("");
  // 编辑且原认证为密码时才有已存密码；切到密码方式且无存货则必须输入
  const savedPassword = initial?.auth.type === "password" ? initial.auth.password : "";
  const others = existing.filter((h) => h.id !== initial?.id);
  const dup = host.trim() !== "" && others.some((h) => h.host === host.trim() && h.port === port);
  const missingPassword = authType === "password" && password === "" && savedPassword === "";
  const invalid =
    host.trim() === "" ||
    username.trim() === "" ||
    (authType === "key" && keyPath.trim() === "") ||
    missingPassword ||
    dup;
  const save = () => {
    if (invalid) return;
    const auth: SshAuth =
      authType === "key"
        ? { type: "key", keyPath: keyPath.trim() }
        : authType === "agent"
          ? { type: "agent" }
          : { type: "password", password: password !== "" ? password : savedPassword };
    onSave({
      id: initial?.id ?? "",
      host: host.trim(),
      port,
      username: username.trim(),
      nickname: nickname.trim() || undefined,
      auth,
      // 端点不随设备表单编辑（v1 只读）；编辑保留原值，新建给默认
      endpoints: initial?.endpoints ?? [{ name: "shell", type: "shell" }],
    });
  };
  useDialogKeys({ onClose: onBack, onEnter: save });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "编辑 SSH 设备" : "添加 SSH 设备"}
        className="dialog dialog--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="dialog__title">
          <IconSsh /> {isEdit ? "编辑 SSH 设备" : "添加 SSH 设备"}
        </h3>
        <div className="dialog__sub">远程主机的 SSH 终端</div>
        <ConfigRow label="主机">
          <input
            autoFocus
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.100"
            className="field"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </ConfigRow>
        <ConfigRow label="端口">
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
            className="field"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </ConfigRow>
        <ConfigRow label="用户名">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root"
            className="field"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </ConfigRow>
        <ConfigRow label="昵称">
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="可选，如「车间网关」"
            className="field"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </ConfigRow>
        <ConfigRow label="认证">
          <div className="seg" role="radiogroup" aria-label="认证方式">
            <button type="button" className="seg__btn" data-on={authType === "key"} onClick={() => setAuthType("key")}>
              密钥
            </button>
            <button type="button" className="seg__btn" data-on={authType === "agent"} onClick={() => setAuthType("agent")}>
              Agent
            </button>
            <button type="button" className="seg__btn" data-on={authType === "password"} onClick={() => setAuthType("password")}>
              密码
            </button>
          </div>
        </ConfigRow>
        {authType === "key" && (
          <ConfigRow label="密钥路径">
            <input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
              className="field"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
            />
          </ConfigRow>
        )}
        {authType === "password" && (
          <>
            <ConfigRow label="密码">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={savedPassword ? "已保存，留空不变" : "输入密码"}
                className="field"
                autoComplete="new-password"
              />
            </ConfigRow>
            <p className="dialog__hint">密码以明文保存，请确保存储位置受控。</p>
          </>
        )}
        {dup && (
          <p className="dialog__hint" style={{ color: "var(--danger)" }}>
            已存在同地址设备 {host.trim()}:{port}，无需重复添加。
          </p>
        )}
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onBack}>
            {backLabel}
          </button>
          <button className="btn btn--primary" onClick={save} disabled={invalid} title={host.trim() === "" ? "请填写主机地址" : undefined}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== SSH open 失败交互闭环（认证重输 / 指纹确认） =====

/** 认证失败重输闭环:密码方式→输入+更新勾选+立即重试;密钥/Agent 方式→提示+编辑入口。
 *  失败详情不上(标题+host 身份已足);method 差异等诊断信息留在 App 的 toast 里。 */
export function SshAuthDialog({
  host,
  operation = "connect",
  onRetryPassword,
  onEdit,
  onCancel,
}: {
  host: SshHost;
  operation?: "connect" | "test";
  onRetryPassword: (password: string, updateSaved: boolean) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const isPassword = host.auth.type === "password";
  const [password, setPassword] = useState("");
  const [updateSaved, setUpdateSaved] = useState(true);
  const canRetry = isPassword && password !== "";
  const confirm = () => {
    if (canRetry) onRetryPassword(password, operation === "test" || updateSaved);
  };
  useDialogKeys({ onClose: onCancel, onEnter: confirm });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="SSH 认证失败" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconSsh /> SSH 认证失败
        </h3>
        <div className="dialog__sub">{host.username}@{host.host}:{host.port}</div>
        {isPassword ? (
          <>
            <ConfigRow label="密码">
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="重新输入密码"
                className="field"
                autoComplete="new-password"
              />
            </ConfigRow>
            {operation !== "test" && <label className="ssh-dialog__check">
              <input type="checkbox" checked={updateSaved} onChange={(e) => setUpdateSaved(e.target.checked)} />
              同时更新已保存的密码
            </label>}
            <p className="dialog__hint">{operation === "test" ? "保存新密码后重新测试，不打开终端。" : "勾选更新时先保存新密码，再重新连接。"}</p>
          </>
        ) : (
          <>
            <p className="dialog__hint">
              {host.auth.type === "key"
                ? `密钥认证被服务器拒绝(${(host.auth as { keyPath: string }).keyPath})。`
                : "SSH Agent 中没有该服务器接受的密钥。"}
              可改用密码认证,或更新密钥后重试。
            </p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--primary" onClick={onEdit}>编辑设备</button>
            </div>
          </>
        )}
        {isPassword && (
          <div className="btn-row">
            <button className="btn btn--ghost" onClick={onCancel}>取消</button>
            <button className="btn btn--primary" onClick={confirm} disabled={!canRetry}>{operation === "test" ? "保存并重新测试" : "重试连接"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 指纹确认:首连(unknown,普通确认)与变更(changed,红色严重警告)双模式。 */
export function SshTrustDialog({
  host,
  error,
  operation = "connect",
  onTrust,
  onCancel,
}: {
  host: SshHost;
  error: Extract<SshOpenError, { kind: "host_key_unknown" | "host_key_changed" }>;
  operation?: "connect" | "test";
  onTrust: () => void;
  onCancel: () => void;
}) {
  const changed = error.kind === "host_key_changed";
  useDialogKeys({ onClose: onCancel });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={changed ? "SSH 服务器指纹已变更" : "确认 SSH 服务器指纹"}
        className={`dialog dialog--narrow${changed ? " ssh-trust--danger" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="dialog__title">
          <IconSsh /> {changed ? "服务器指纹已变更" : "首次连接"}
        </h3>
        <div className="dialog__sub">{host.username}@{host.host}:{host.port}</div>
        {changed ? (
          <>
            <p className="ssh-trust__warn">
              已信任的指纹与本次收到的不一致。若非你方重装/更换了服务器,这可能是中间人攻击——
              请在服务器上核对指纹后再继续。
            </p>
            <ConfigRow label="已信任">
              <code className="ssh-trust__fp">{error.known}</code>
            </ConfigRow>
            <ConfigRow label="本次收到">
              <code className="ssh-trust__fp">{error.received}</code>
            </ConfigRow>
            <p className="dialog__hint">算法 {error.keyType}。「仍要信任」将覆盖记录的指纹并{operation === "test" ? "重新测试" : "重连"}。</p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--danger-solid" onClick={onTrust}>{operation === "test" ? "仍要信任并测试" : "仍要信任并连接"}</button>
            </div>
          </>
        ) : (
          <>
            <ConfigRow label="指纹">
              <code className="ssh-trust__fp">{error.fingerprint}</code>
            </ConfigRow>
            <p className="dialog__hint">算法 {error.keyType}(SHA256)。首次连接需确认服务器身份,信任后本机将记住该指纹。</p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--primary" onClick={onTrust}>{operation === "test" ? "信任并测试" : "信任并连接"}</button>
            </div>
          </>
        )}
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


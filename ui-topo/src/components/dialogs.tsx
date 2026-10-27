/** 对话框族（抄 serial-studio dialogs.tsx 的所需子集，交互与视觉同源）：
 * 串口配置、设置面板（服务器+租约）、关于、添加远程设备、设备/端口详情、
 * SSH 管理/编辑/认证闭环/指纹确认、通用确认。 */
import { useEffect, useRef, useState } from "react";
import {
  IconAlert,
  IconCopy,
  IconGear,
  IconGlobe,
  IconInfo,
  IconPlug,
  IconSsh,
} from "../icons";
import { ConfigRow, useDialogA11y, useDialogKeys, useEscClose } from "../primitives";
import { BAUD_RATES, copyText, REPO_URL } from "../lib";
import type { SerialConfig, SrvSettings, SshAuth, SshHost, SshOpenError } from "../types";
import type { PortView } from "../api";

/** 遮罩点击关闭：mousedown 起点必须是遮罩本身（防框内选字拖出误关）。 */
function overlayClose(e: React.MouseEvent, onClose: () => void, guard?: () => boolean) {
  if (e.target !== e.currentTarget) return;
  if (guard?.()) return;
  onClose();
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
  initialAlias?: string;
  onChange: (c: SerialConfig) => void;
  onConfirm: (c: SerialConfig, alias: string) => void;
  onCancel: () => void;
}) {
  useDialogKeys({ onClose: onCancel, onEnter: () => onConfirm(config, alias) });
  const [alias, setAlias] = useState(initialAlias);
  const [baud, setBaud] = useState(String(config.baud_rate));
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
              <button type="button" className="mini-btn" title="回到常用档下拉" onClick={() => setCustomBaud(false)}>↺</button>
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

// ===== 设置面板（服务器 + 租约）=====

export function SettingsPanel({
  settings,
  onSave,
  onClose,
}: {
  settings: SrvSettings | null;
  onSave: (s: SrvSettings) => void;
  onClose: () => void;
}) {
  const [srv, setSrv] = useState<SrvSettings | null>(settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSrv(settings), [settings]);

  const apply = () => {
    if (srv) {
      onSave(srv);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };
  useDialogKeys({ onClose, onEnter: apply });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGear /> 设置
        </h3>
        {srv ? (
          <>
            <div className="dialog__group-label">服务器监听（重启进程生效）</div>
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
                <span title="服务器无认证，开启后任何已连接的客户端都可执行脚本（可读写本机文件）。" style={{ cursor: "help" }}>
                  ⚠
                </span>
              </label>
            </ConfigRow>
            <ConfigRow label="脚本日志">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={srv.script_log_to_disk}
                  onChange={(e) => setSrv({ ...srv, script_log_to_disk: e.target.checked })}
                />
                <span>log 输出自动落盘</span>
              </label>
            </ConfigRow>

            <div className="dialog__group-label">租约（重启进程生效）</div>
            <ConfigRow label="默认 TTL">
              <input type="number" value={srv.lease.ttl_minutes} onChange={(e) => setSrv({ ...srv, lease: { ...srv.lease, ttl_minutes: Number(e.target.value) } })} className="field" autoCapitalize="off" spellCheck={false} />
            </ConfigRow>
            <ConfigRow label="TTL 上限">
              <input type="number" value={srv.lease.max_ttl_minutes} onChange={(e) => setSrv({ ...srv, lease: { ...srv.lease, max_ttl_minutes: Number(e.target.value) } })} className="field" autoCapitalize="off" spellCheck={false} />
            </ConfigRow>
            <ConfigRow label="写闸">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={srv.lease.enable_gate}
                  onChange={(e) => setSrv({ ...srv, lease: { ...srv.lease, enable_gate: e.target.checked } })}
                />
                <span>MCP 写操作须持租约</span>
              </label>
            </ConfigRow>

            <div className="btn-row">
              {saved && <span className="btn--save-pulse">已应用</span>}
              <button className="btn btn--ghost" onClick={onClose}>
                关闭
              </button>
              <button className="btn btn--primary" onClick={apply}>
                应用
              </button>
            </div>
          </>
        ) : (
          <div style={{ color: "var(--ink-faint)" }}>加载中…</div>
        )}
      </div>
    </div>
  );
}

// ===== 关于 =====

export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay" onMouseDown={(e) => overlayClose(e, onClose)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="关于 topo-hub" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="about">
          <div className="about__mark">
            <IconPlug />
          </div>
          <h3 className="about__name">topo-hub</h3>
          <p className="about__version">版本 {version || "…"}</p>
          <p className="about__tagline">
            AI 设备调试的拓扑管理平台
            <br />
            拓扑 / 租约 / 设备库 / 终端 · MCP & WebSocket
            <br />
            MCP Url http://IP:PORT/mcp
          </p>
          <p className="about__repo">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              {REPO_URL}
            </a>
          </p>
          <button className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 添加远程设备 =====

export function RemoteDialog({
  input,
  onChange,
  onConfirm,
  onCancel,
  existing,
}: {
  input: { host: string; port: number; nickname: string };
  onChange: (v: { host: string; port: number; nickname: string }) => void;
  onConfirm: () => void;
  onCancel: () => void;
  existing: string[];
}) {
  const host = input.host.trim();
  const dup = host !== "" && existing.includes(`${host}:${input.port}`);
  const invalid = host === "" || dup;
  useDialogKeys({ onClose: onCancel, onEnter: () => { if (!invalid) onConfirm(); } });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="添加远程设备" className="dialog dialog--narrow" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          <IconGlobe /> 添加远程设备
        </h3>
        <div className="dialog__sub">连接远程 Serial Studio 服务（其端口并入设备库）</div>
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
        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={onConfirm} disabled={invalid}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== 详情（设备 / 端口）=====

function useCopyRow() {
  const [copied, setCopied] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(copyTimer.current ?? undefined), []);
  const copyBtn = (tag: number, text: string, title: string) => (
    <button
      className="btn btn--ghost"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(tag);
          clearTimeout(copyTimer.current ?? undefined);
          copyTimer.current = setTimeout(() => setCopied(null), 1500);
        });
      }}
      title={title}
    >
      <IconCopy /> {copied === tag ? "已复制 ✓" : "复制"}
    </button>
  );
  return copyBtn;
}

export interface DeviceDetailInfo {
  icon: "globe" | "ssh" | "plug";
  label: string;
  rows: { label: string; value: string; copy?: boolean }[];
  online?: boolean;
  statusNode?: React.ReactNode;
  ports: PortView[];
  portsText?: string;
  hint?: string;
}

export function DeviceDetailDialog({ info, onClose }: { info: DeviceDetailInfo; onClose: () => void }) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  const copyBtn = useCopyRow();
  const status =
    info.online === true ? (
      <><span className="dot on" /> 在线</>
    ) : info.online === false ? (
      <><span className="dot off" /> 离线</>
    ) : (
      <><span className="dot" /> 连接中…</>
    );
  const portsText =
    info.portsText ??
    (info.online === false
      ? "未连接"
      : info.ports.length === 0
        ? "无可用端口"
        : info.ports.map((p) => p.name).join(" · "));
  const icon = info.icon === "globe" ? <IconGlobe /> : info.icon === "ssh" ? <IconSsh /> : <IconPlug />;
  return (
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
        <ConfigRow label="端口">{portsText}</ConfigRow>
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

export interface PortDetailInfo {
  icon: "plug" | "ssh";
  label: string;
  rows: { label: string; value: string; copy?: boolean }[];
  hint?: string;
}

export function PortDetailDialog({ info, onClose }: { info: PortDetailInfo; onClose: () => void }) {
  useEscClose(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  const copyBtn = useCopyRow();
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

// ===== SSH 设备管理 =====

export function sshAuthLabel(auth: SshAuth): string {
  return auth.type === "key" ? "密钥" : auth.type === "agent" ? "Agent" : "密码";
}

export function SshManagerDialog({
  hosts,
  testOf,
  onCommit,
  onDelete,
  onTest,
  onClose,
}: {
  hosts: SshHost[];
  testOf: (id: string) => "testing" | "ok" | "fail" | undefined;
  onCommit: (host: SshHost, isNew: boolean) => void;
  onDelete: (host: SshHost) => void;
  onTest: (hostId: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<null | { mode: "add" } | { mode: "edit"; host: SshHost }>(null);
  useEscClose(() => {
    if (form === null) onClose();
    else setForm(null);
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  return (
    <>
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
              {hosts.map((h) => {
                const tst = testOf(h.id);
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
                    <span className={`ssh-table__status${tst === "ok" ? " ok" : ""}${tst === "fail" ? " bad" : ""}`} title={tst === "fail" ? "失败（原因见提示）" : undefined}>
                      {testText}
                    </span>
                    <span className="ssh-table__actions">
                      <button className="mini-btn" onClick={() => setForm({ mode: "edit", host: h })}>
                        编辑
                      </button>
                      <button className="mini-btn" onClick={() => onTest(h.id)} disabled={tst === "testing"}>
                        测试
                      </button>
                      <button className="mini-btn mini-btn--danger" onClick={() => onDelete(h)}>
                        删除
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
            setForm(null);
          }}
        />
      )}
    </>
  );
}

function SshHostForm({
  initial,
  existing,
  onBack,
  backLabel,
  onSave,
}: {
  initial: SshHost | null;
  existing: SshHost[];
  onBack: () => void;
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
          <input autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="用户名">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="昵称">
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="可选，如「车间网关」" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
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
            <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
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
          <button className="btn btn--primary" onClick={save} disabled={invalid}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== SSH open 失败闭环（认证 / 指纹）=====

export function SshAuthDialog({
  host,
  onRetryPassword,
  onEdit,
  onCancel,
}: {
  host: SshHost;
  onRetryPassword: (password: string, updateSaved: boolean) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const isPassword = host.auth.type === "password";
  const [password, setPassword] = useState("");
  const [updateSaved, setUpdateSaved] = useState(true);
  const canRetry = isPassword && password !== "";
  const confirm = () => {
    if (canRetry) onRetryPassword(password, updateSaved);
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
            <label className="ssh-dialog__check">
              <input type="checkbox" checked={updateSaved} onChange={(e) => setUpdateSaved(e.target.checked)} />
              同时更新已保存的密码
            </label>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--primary" onClick={confirm} disabled={!canRetry}>重试连接</button>
            </div>
          </>
        ) : (
          <>
            <p className="dialog__hint">
              {host.auth.type === "key"
                ? `密钥认证被服务器拒绝(${(host.auth as { keyPath: string }).keyPath})。`
                : "SSH Agent 中没有该服务器接受的密钥。"}
              可改用密码认证，或更新密钥后重试。
            </p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--primary" onClick={onEdit}>编辑设备</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SshTrustDialog({
  host,
  error,
  onTrust,
  onCancel,
}: {
  host: SshHost;
  error: Extract<SshOpenError, { kind: "host_key_unknown" | "host_key_changed" }>;
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
              已信任的指纹与本次收到的不一致。若非你方重装/更换了服务器，这可能是中间人攻击——
              请在服务器上核对指纹后再继续。
            </p>
            <ConfigRow label="已信任">
              <code className="ssh-trust__fp">{error.known}</code>
            </ConfigRow>
            <ConfigRow label="本次收到">
              <code className="ssh-trust__fp">{error.received}</code>
            </ConfigRow>
            <p className="dialog__hint">算法 {error.keyType}。「仍要信任」将覆盖记录的指纹并重连。</p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--danger-solid" onClick={onTrust}>仍要信任并连接</button>
            </div>
          </>
        ) : (
          <>
            <ConfigRow label="指纹">
              <code className="ssh-trust__fp">{error.fingerprint}</code>
            </ConfigRow>
            <p className="dialog__hint">算法 {error.keyType}(SHA256)。首次连接需确认服务器身份，信任后本机将记住该指纹。</p>
            <div className="btn-row">
              <button className="btn btn--ghost" onClick={onCancel}>取消</button>
              <button className="btn btn--primary" onClick={onTrust}>信任并连接</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ===== 通用确认 =====

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
  confirmText: string;
  cancelText?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useDialogKeys({ onClose: onCancel, onEnter: () => (tone === "danger" ? onCancel() : onConfirm()) });
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
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

export { IconInfo };

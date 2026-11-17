/** 对话框族（抄 serial-studio dialogs.tsx 的所需子集，交互与视觉同源）：
 * 串口配置、设置面板（服务器+租约）、关于、添加远程设备、设备/端口详情、
 * SSH 管理/编辑/认证闭环/指纹确认、通用确认。 */
import { useEffect, useRef, useState } from "react";
import { IconAlert, IconCopy, IconGlobe, IconInfo, IconPlug, IconSsh } from "../icons";
import { ConfigRow, useDialogA11y, useDialogKeys, useEscClose } from "../primitives";
import { BAUD_RATES, copyText } from "../lib";
import type { SerialConfig, SshHost, SshOpenError } from "../types";
import type { PortView } from "../api";

/** 遮罩点击关闭：mousedown 起点必须是遮罩本身（防框内选字拖出误关）。 */
export function overlayClose(e: React.MouseEvent, onClose: () => void, guard?: () => boolean) {
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

// ===== 关于 =====

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
        <div className="dialog__sub">连接远程 Serial Studio 服务（其端口并入设备页）</div>
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

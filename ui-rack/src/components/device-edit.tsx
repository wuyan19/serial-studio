/** 被测设备编辑对话框：设备=身份（名称/型号/位置），通道=卡片（P2.6 通道归设备）。
 *  串口卡内联完整打开参数（波特率/数据位/校验/流控/换行符）——终端即点即开；
 *  SSH 卡内联完整登录配置（主机/用户名/认证三选）——凭据库由后端投影维护，
 *  用户不再直接管理。 */
import { useRef, useState } from "react";
import { useDialogA11y, useDialogKeys } from "../primitives";
import { BAUD_RATES } from "../lib";
import type { Device, DeviceChannel } from "../api";
import type { SshAuth, SerialConfig } from "../types";

const DEFAULT_CONFIG: SerialConfig = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "lf",
};

type SerialCh = Extract<DeviceChannel, { type: "serial" }>;
type SshCh = Extract<DeviceChannel, { type: "ssh" }>;

function SerialCard({
  ch,
  ports,
  onChange,
  onRemove,
}: {
  ch: SerialCh;
  ports: string[];
  onChange: (c: DeviceChannel) => void;
  onRemove: () => void;
}) {
  const config = { ...DEFAULT_CONFIG, ...ch.config };
  const set = (patch: Partial<SerialConfig>) =>
    onChange({ type: "serial", port: ch.port, config: { ...config, ...patch } });
  return (
    <div className="chan-card">
      <div className="chan-card__head">
        <span className="dev-badge dev-badge--serial">串口</span>
        <span className="chan-card__title">{ch.port || "串口通道"}</span>
        <button className="dev-icon-btn dev-icon-btn--danger" title="移除通道" onClick={onRemove}>✕</button>
      </div>
      <div className="chan-card__grid">
        <label>
          端口
          <select value={ch.port} onChange={(e) => onChange({ type: "serial", port: e.target.value, config })}>
            <option value="">选端口…</option>
            {ports.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
            {ch.port && !ports.includes(ch.port) && <option value={ch.port}>{ch.port}（不在位）</option>}
          </select>
        </label>
        <label>
          波特率
          <select value={config.baud_rate} onChange={(e) => set({ baud_rate: Number(e.target.value) })}>
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
            {!BAUD_RATES.includes(config.baud_rate) && (
              <option value={config.baud_rate}>{config.baud_rate}（自定义）</option>
            )}
          </select>
        </label>
        <label>
          数据位
          <select value={config.data_bits} onChange={(e) => set({ data_bits: e.target.value })}>
            <option value="eight">8</option><option value="seven">7</option><option value="six">6</option><option value="five">5</option>
          </select>
        </label>
        <label>
          停止位
          <select value={config.stop_bits} onChange={(e) => set({ stop_bits: e.target.value })}>
            <option value="one">1</option><option value="two">2</option>
          </select>
        </label>
        <label>
          校验
          <select value={config.parity} onChange={(e) => set({ parity: e.target.value })}>
            <option value="none">None</option><option value="odd">Odd</option><option value="even">Even</option>
          </select>
        </label>
        <label>
          流控
          <select value={config.flow_control} onChange={(e) => set({ flow_control: e.target.value })}>
            <option value="none">None</option><option value="software">XON/XOFF</option><option value="hardware">RTS/CTS</option>
          </select>
        </label>
        <label>
          换行符
          <select value={config.line_ending} onChange={(e) => set({ line_ending: e.target.value })}>
            <option value="crlf">CRLF — Windows/AT</option><option value="lf">LF — Linux/Unix</option><option value="cr">CR</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function SshCard({
  ch,
  onChange,
  onRemove,
  savedPassword,
}: {
  ch: SshCh;
  onChange: (c: DeviceChannel) => void;
  onRemove: () => void;
  /** 编辑时已存密码（留空=沿用）；新建为空串。 */
  savedPassword: string;
}) {
  const auth: SshAuth = ch.auth ?? { type: "agent" };
  const setAuth = (a: SshAuth) => onChange({ ...ch, auth: a });
  const title =
    ch.username || ch.host
      ? `${ch.username || "?"}@${ch.host || "?"}`
      : ch.nickname || "SSH 通道";
  return (
    <div className="chan-card">
      <div className="chan-card__head">
        <span className="dev-badge dev-badge--ssh">SSH</span>
        <span className="chan-card__title">{title}</span>
        <button className="dev-icon-btn dev-icon-btn--danger" title="移除通道" onClick={onRemove}>✕</button>
      </div>
      <div className="chan-card__grid">
        <label>
          主机
          <input value={ch.host} onChange={(e) => onChange({ ...ch, host: e.target.value })} placeholder="192.168.1.100" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          端口
          <input type="number" value={ch.port ?? 22} onChange={(e) => onChange({ ...ch, port: Number(e.target.value) || 22 })} />
        </label>
        <label>
          用户名
          <input value={ch.username} onChange={(e) => onChange({ ...ch, username: e.target.value })} placeholder="root" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          昵称
          <input value={ch.nickname ?? ""} onChange={(e) => onChange({ ...ch, nickname: e.target.value || undefined })} placeholder="可选" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <div className="chan-card__auth">
        <span className="form-label">认证</span>
        <div className="seg" role="radiogroup" aria-label="认证方式">
          <button type="button" className="seg__btn" data-on={auth.type === "key"} onClick={() => setAuth({ type: "key", keyPath: (auth.type === "key" && auth.keyPath) || "~/.ssh/id_ed25519" })}>密钥</button>
          <button type="button" className="seg__btn" data-on={auth.type === "agent"} onClick={() => setAuth({ type: "agent" })}>Agent</button>
          <button type="button" className="seg__btn" data-on={auth.type === "password"} onClick={() => setAuth({ type: "password", password: savedPassword })}>密码</button>
        </div>
        {auth.type === "key" && (
          <input value={auth.keyPath} onChange={(e) => setAuth({ type: "key", keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        )}
        {auth.type === "password" && (
          <>
            <input
              type="password"
              value={auth.password}
              onChange={(e) => setAuth({ type: "password", password: e.target.value })}
              placeholder={savedPassword ? "已保存，留空不变" : "输入密码"}
              autoComplete="new-password"
            />
            <p className="dialog__hint">密码以明文保存，请确保存储位置受控。</p>
          </>
        )}
        <label className="dlg-settings__check chan-card__legacy-mac">
          <input
            type="checkbox"
            checked={ch.allow_legacy_mac ?? false}
            onChange={(e) => onChange({ ...ch, allow_legacy_mac: e.target.checked })}
          />
          允许旧版 MAC（hmac-sha1）
        </label>
      </div>
    </div>
  );
}

export function DeviceEditDialog({
  initial,
  ports,
  onConfirm,
  onCancel,
}: {
  initial: Device | null;
  /** 串口候选：未归属其它设备的端口 + 本设备现役。 */
  ports: string[];
  onConfirm: (input: {
    name: string;
    model: string;
    location: string;
    channels: DeviceChannel[];
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [channels, setChannels] = useState<DeviceChannel[]>(
    initial?.channels.map((c) => ({ ...c })) ?? [],
  );
  /** 各 SSH 通道的已存密码（编辑留空=沿用，提交前回填） */
  const savedPasswords = useRef<Map<number, string>>(
    new Map(
      (initial?.channels ?? []).map((c, i) =>
        c.type === "ssh" && c.auth?.type === "password" ? [i, c.auth.password] : [i, ""],
      ),
    ),
  );

  const save = () => {
    if (name.trim() === "") return;
    const resolved = channels.map((c, i) => {
      if (c.type === "ssh" && c.auth?.type === "password" && c.auth.password === "") {
        return { ...c, auth: { type: "password" as const, password: savedPasswords.current.get(i) ?? "" } };
      }
      return c;
    });
    onConfirm({ name: name.trim(), model: model.trim(), location: location.trim(), channels: resolved });
  };
  useDialogKeys({ onClose: onCancel, onEnter: save });
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={initial ? "编辑设备" : "注册设备"}
        className="dialog dialog--med"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="dialog__title">{initial ? "编辑设备" : "注册设备"}</h3>
        <div className="dialog__sub">{initial ? initial.name : "定义被测设备与接入通道"}</div>
        <div className="chan-card__grid" style={{ marginBottom: 10 }}>
          <label>
            名称
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如「车间交换机#3」" autoCapitalize="off" spellCheck={false} />
          </label>
          <label>
            型号
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="可选" autoCapitalize="off" spellCheck={false} />
          </label>
          <label>
            位置
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="可选" autoCapitalize="off" spellCheck={false} />
          </label>
        </div>

        {channels.map((c, i) => (
          c.type === "serial" ? (
            <SerialCard
              key={i}
              ch={c}
              ports={ports}
              onChange={(nc) => setChannels(channels.map((x, j) => (i === j ? nc : x)))}
              onRemove={() => setChannels(channels.filter((_, j) => j !== i))}
            />
          ) : (
            <SshCard
              key={i}
              ch={c}
              savedPassword={savedPasswords.current.get(i) ?? ""}
              onChange={(nc) => {
                if (nc.type === "ssh" && nc.auth?.type === "password" && nc.auth.password !== "") {
                  savedPasswords.current.set(i, nc.auth.password);
                }
                setChannels(channels.map((x, j) => (i === j ? nc : x)));
              }}
              onRemove={() => setChannels(channels.filter((_, j) => j !== i))}
            />
          )
        ))}

        <div className="row-actions" style={{ marginTop: 6 }}>
          <button className="btn btn--ghost" onClick={() => setChannels([...channels, { type: "serial", port: "", config: { ...DEFAULT_CONFIG } }])}>
            + 串口通道
          </button>
          <button className="btn btn--ghost" onClick={() => setChannels([...channels, { type: "ssh", id: "", host: "", port: 22, username: "root", nickname: undefined, auth: { type: "agent" } }])}>
            + SSH 通道
          </button>
        </div>
        <p className="dialog__hint">
          同一端口/地址只能属于一台设备；SSH 认证信息随通道保存（凭据库由平台自动维护）。
        </p>

        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button className="btn btn--primary" onClick={save} disabled={name.trim() === ""}>保存</button>
        </div>
      </div>
    </div>
  );
}

/** 被测设备编辑对话框：设备=身份（名称/型号/位置），通道=接入方式。
 *  串口通道从未占用端口里选（含级联键），SSH 通道从凭据库选（未挂设备的 +
 *  本设备现役）——凭据管理入口在此（打开 SSH 管理弹窗）。 */
import { useRef, useState } from "react";
import { ConfigRow, useDialogA11y, useDialogKeys } from "../primitives";
import type { Device, DeviceChannel } from "../api";

export function DeviceEditDialog({
  initial,
  ports,
  sshHosts,
  ownedSerialPorts,
  ownedSshRefs,
  onConfirm,
  onCancel,
}: {
  /** 编辑的原设备；null = 新建。 */
  initial: Device | null;
  /** 当前端口表（串口通道候选：未归属的 + 本设备现役）。 */
  ports: string[];
  sshHosts: { id: string; label: string }[];
  /** 已被其它设备占用的串口端口/凭据（本设备现役排除后即禁选项）。 */
  ownedSerialPorts: Set<string>;
  ownedSshRefs: Set<string>;
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

  const serialCandidates = [
    ...new Set([
      ...channels.filter((c) => c.type === "serial").map((c) => c.port ?? ""),
      ...ports.filter((p) => !ownedSerialPorts.has(p)),
    ]),
  ].filter(Boolean);
  const sshCandidates = [
    ...new Set([
      ...channels.filter((c) => c.type === "ssh").map((c) => c.ref ?? ""),
      ...sshHosts.map((h) => h.id).filter((id) => !ownedSshRefs.has(id)),
    ]),
  ].filter(Boolean);

  const save = () => {
    if (name.trim() === "") return;
    onConfirm({
      name: name.trim(),
      model: model.trim(),
      location: location.trim(),
      channels: channels.filter((c) =>
        c.type === "serial" ? !!c.port : !!c.ref,
      ),
    });
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
        className="dialog dialog--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="dialog__title">{initial ? "编辑设备" : "注册设备"}</h3>
        <div className="dialog__sub">设备 = 被调试的一台机器；通道 = 接入方式（串口控制台 / SSH 登录）</div>
        <ConfigRow label="名称">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如「车间交换机#3」"
            className="field"
            autoCapitalize="off"
            spellCheck={false}
          />
        </ConfigRow>
        <ConfigRow label="型号">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" spellCheck={false} />
        </ConfigRow>
        <ConfigRow label="位置">
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" spellCheck={false} />
        </ConfigRow>

        <div className="form-label" style={{ marginTop: 8 }}>
          通道
        </div>
        {channels.map((c, i) => (
          <div className="member-row" key={i}>
            <select
              value={c.type}
              onChange={(e) => {
                const type = e.target.value as "serial" | "ssh";
                setChannels(
                  channels.map((x, j) =>
                    i === j
                      ? type === "serial"
                        ? { type, port: "" }
                        : { type, ref: "" }
                      : x,
                  ),
                );
              }}
            >
              <option value="serial">串口</option>
              <option value="ssh">SSH</option>
            </select>
            {c.type === "serial" ? (
              <select
                value={c.port ?? ""}
                onChange={(e) =>
                  setChannels(
                    channels.map((x, j) => (i === j ? { type: "serial", port: e.target.value } : x)),
                  )
                }
              >
                <option value="">选端口…</option>
                {serialCandidates.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                {c.port && !serialCandidates.includes(c.port) && (
                  <option value={c.port}>{c.port}（不在位）</option>
                )}
              </select>
            ) : (
              <select
                value={c.ref ?? ""}
                onChange={(e) =>
                  setChannels(
                    channels.map((x, j) => (i === j ? { type: "ssh", ref: e.target.value } : x)),
                  )
                }
              >
                <option value="">选凭据…</option>
                {sshCandidates.map((id) => (
                  <option key={id} value={id}>
                    {sshHosts.find((h) => h.id === id)?.label ?? id}
                  </option>
                ))}
              </select>
            )}
            <button
              className="link"
              onClick={() => setChannels(channels.filter((_, j) => j !== i))}
            >
              移除
            </button>
          </div>
        ))}
        <button
          className="link"
          onClick={() => setChannels([...channels, { type: "serial", port: "" }])}
        >
          + 添加通道
        </button>
        <p className="dialog__hint">
          同一端口/凭据只能属于一台设备；候选只列未归属项。SSH 凭据在「设置 → SSH 凭据库」维护。
        </p>

        <div className="btn-row">
          <button className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={save} disabled={name.trim() === ""}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

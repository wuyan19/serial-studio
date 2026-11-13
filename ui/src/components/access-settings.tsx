import { useEffect, useState } from "react";
import { copyText, tauriInvoke } from "../lib";
import { accessTargetKey, accessTargetOptions, HTTP_ACCESS_WARNING, validAccessPort, type AccessConfig, type AccessStatus, type AccessTarget } from "../access";
import type { PortInfo } from "../types";
import "./access.css";

export function AccessSettings() {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [draft, setDraft] = useState<AccessConfig | null>(null);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const [expiresAt, setExpiresAt] = useState(0);

  function receive(value: AccessStatus) {
    setStatus(value);
    setExpiresAt(Date.now() + value.expires_in * 1000);
    setClock(Date.now());
  }

  useEffect(() => {
    let active = true;
    setError("");
    void tauriInvoke<AccessStatus>("get_access_status").then((value) => {
      if (!active) return;
      receive(value);
      setDraft(value.config);
    }).catch((failure) => { if (active) setError(String(failure)); });
    void tauriInvoke<PortInfo[]>("list_ports").then((value) => {
      if (active) setPorts(value);
    }).catch(() => { if (active) setError("无法读取连接列表"); });
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    if (!status?.config.enabled || busy) return;
    let active = true;
    let reading = false;
    const interval = window.setInterval(() => {
      setClock(Date.now());
      if (reading) return;
      reading = true;
      void tauriInvoke<AccessStatus>("get_access_status").then((value) => {
        if (active) receive(value);
      }).catch(() => {}).finally(() => { reading = false; });
    }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [status?.config.enabled, busy]);

  const apply = async (command: string, args?: Record<string, unknown>, message?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = await tauriInvoke<AccessStatus | undefined>(command, args);
      const current = reply ?? await tauriInvoke<AccessStatus>("get_access_status");
      receive(current);
      if (command === "save_access_config") setDraft(current.config);
      if (message) setNotice(message);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!draft) return <div className="access-settings" role="status">
    {error || "正在读取远程访问设置…"}
    {error && <button className="btn" onClick={() => setReload((value) => value + 1)}>重试</button>}
  </div>;

  const change = <K extends keyof AccessConfig>(key: K, value: AccessConfig[K]) => setDraft({ ...draft, [key]: value });
  const selected = new Set(draft.targets.map(accessTargetKey));
  const options = accessTargetOptions(ports);
  const known = new Set(options.map(({ target }) => accessTargetKey(target)));
  const allSelected = options.length > 0 && options.every(({ target }) => selected.has(accessTargetKey(target)));
  for (const target of draft.targets) {
    const key = accessTargetKey(target);
    if (!known.has(key)) {
      options.push({ target, label: `${target.id}（当前不可用）` });
      known.add(key);
    }
  }
  const toggle = (target: AccessTarget) => change("targets", selected.has(accessTargetKey(target))
    ? draft.targets.filter((item) => accessTargetKey(item) !== accessTargetKey(target))
    : [...draft.targets, target]);
  const showTls = !draft.allow_http || Boolean(draft.tls_cert.trim() || draft.tls_key.trim());
  const invalid = draft.enabled && (
    !validAccessPort(draft.tls_port) || (showTls && (!draft.tls_cert.trim() || !draft.tls_key.trim())) ||
    (draft.scope === "selected" && draft.targets.length === 0)
  );
  const expiresIn = Math.max(0, Math.ceil((expiresAt - clock) / 1000));
  const changed = JSON.stringify(draft) !== JSON.stringify(status?.config);

  return <div className="access-settings">
    <fieldset disabled={busy}>
      <label className="dlg-settings__check"><input type="checkbox" checked={draft.enabled} onChange={(event) => change("enabled", event.target.checked)} /> 启用远程访问验证</label>
      {draft.enabled && <>
        <label className="access-settings__field">
          <span>保护范围</span>
          <select className="field-select" value={draft.scope} onChange={(event) => change("scope", event.target.value === "selected" ? "selected" : "all")}>
            <option value="all">全部连接（含后续新增）</option>
            <option value="selected">指定连接</option>
          </select>
        </label>
        {draft.scope === "selected" && <div className="access-settings__targets" aria-label="指定连接">
          {options.length ? options.map(({ target, label }) => <label key={accessTargetKey(target)} className="dlg-settings__check">
            <input type="checkbox" checked={selected.has(accessTargetKey(target))} onChange={() => toggle(target)} />
            <span>{label}</span><small>{target.kind === "ssh" ? "SSH" : "串口"}</small>
          </label>) : <p>暂无可选连接</p>}
        </div>}
        <p className="dialog__hint">旧版客户端通过服务设置中的 WS 端口接入，只能看到未受保护的连接。{(draft.scope === "all" || allSelected) && "当前范围涵盖所有已列出的连接，旧版客户端可能显示无可用连接。"}</p>
        <p className="dialog__hint">Telnet 和 MCP 无法访问受保护的连接。应用保护设置会结束受影响的远程会话。</p>
        <label className="access-settings__field">
          <span>验证码刷新时间</span>
          <select className="field-select" value={draft.refresh_minutes} onChange={(event) => change("refresh_minutes", Number(event.target.value))}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
          </select>
        </label>
        <label className="dlg-settings__check"><input type="checkbox" checked={draft.allow_http === true} onChange={(event) => change("allow_http", event.target.checked)} /> 允许通过 HTTP 验证</label>
        {draft.allow_http && <p className="dialog__hint" role="note">{HTTP_ACCESS_WARNING} 使用原有 WS 端口。若不启用 HTTPS，证书和私钥路径均可留空。</p>}
        <label className="access-settings__field"><span>HTTPS 端口</span><input type="number" min={1} max={65535} className="field" value={draft.tls_port || ""} onChange={(event) => change("tls_port", Number(event.target.value))} /></label>
        <label className="access-settings__field"><span>TLS 证书路径（PEM）</span><input className="field" value={draft.tls_cert} onChange={(event) => change("tls_cert", event.target.value)} spellCheck={false} /></label>
        <label className="access-settings__field"><span>TLS 私钥路径（PEM）</span><input className="field" value={draft.tls_key} onChange={(event) => change("tls_key", event.target.value)} spellCheck={false} /></label>
        {showTls && <p className="dialog__hint">通过 HTTPS 访问时，请使用证书覆盖的主机名或 IP。证书须受浏览器和远程客户端信任。</p>}
      </>}
      <div className="access-settings__actions">
        <button className="btn btn--primary" disabled={invalid || !changed} onClick={() => void apply("save_access_config", { config: draft }, "访问验证设置已应用")}>应用保护设置</button>
      </div>
    </fieldset>
    {status?.config.enabled && <div className="access-settings__code">
      <div className="access-settings__actions">
        <button className="btn" onClick={() => setReveal((value) => !value)}>{reveal ? "隐藏验证码" : "查看验证码"}</button>
        <button className="btn" disabled={busy} onClick={() => void apply("rotate_access_code")}>立即刷新</button>
        <button className="btn" disabled={busy || !status.session_count} onClick={() => void apply("revoke_access_sessions", undefined, "已撤销全部远程授权")}>撤销全部授权（{status.session_count}）</button>
      </div>
      {reveal && <div className="access-settings__actions">
        <code>{expiresIn ? status.code ?? "—" : "—"}</code>
        <span>剩余 {expiresIn} 秒 · 成功验证后作废</span>
        <button className="btn" disabled={!status.code || !expiresIn} onClick={() => {
          if (status.code) void copyText(status.code).then((ok) => setNotice(ok ? "已复制验证码" : "无法复制验证码"));
        }}>复制</button>
      </div>}
    </div>}
    {error && <p className="editor-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

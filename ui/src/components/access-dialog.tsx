import { useRef, useState, type FormEvent } from "react";
import { DEFAULT_ACCESS_PORT, HTTP_ACCESS_WARNING, validAccessPort } from "../access";
import { IconServer } from "../icons";
import { useDialogA11y, useDialogKeys } from "./primitives";
import "./access.css";

export function AccessDialog({ label, desktop, insecure = false, onVerify, onCancel }: {
  label: string;
  desktop?: { securePort?: number; verifyHttp?: boolean };
  insecure?: boolean;
  onVerify: (code: string, options?: { securePort?: number; verifyHttp?: boolean }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState(desktop?.securePort ?? DEFAULT_ACCESS_PORT);
  const [mode, setMode] = useState<"http" | "https">(desktop?.verifyHttp ? "http" : "https");
  const valid = /^\d{8}$/.test(code) && (!desktop || mode === "http" || validAccessPort(port));
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogA11y(dialogRef, inputRef);
  useDialogKeys({ onClose: () => { if (!inFlight.current) onCancel?.(); } });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onVerify(code, desktop ? { securePort: mode === "https" ? port : undefined, verifyHttp: mode === "http" || undefined } : undefined);
      setCode("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setCode("");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <div className="dialog-overlay">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="远程访问验证" className="dialog dialog--narrow">
      <h3 className="dialog__title"><IconServer /> 远程访问验证</h3>
      <p className="dialog__sub">{label}</p>
      <form onSubmit={(event) => void submit(event)}>
        {desktop && <label className="access-dialog__field">
          <span>验证方式</span>
          <select className="field-select" value={mode} disabled={busy} onChange={(event) => {
            setMode(event.target.value === "http" ? "http" : "https");
            setCode("");
            setError("");
          }}>
            <option value="https">HTTPS（推荐）</option>
            <option value="http">HTTP</option>
          </select>
        </label>}
        {desktop && mode === "https" && <label className="access-dialog__field">
          <span>目标设备 HTTPS 端口</span>
          <input className="field" type="number" min={1} max={65535} value={port || ""} disabled={busy} onChange={(event) => setPort(Number(event.target.value))} />
        </label>}
        {(insecure || (desktop && mode === "http")) && <p className="dialog__hint" role="note">{HTTP_ACCESS_WARNING}</p>}
        <label className="access-dialog__field">
          <span>请输入目标设备「设置 → 访问验证」中的 8 位验证码</span>
          <input ref={inputRef} className="field" type="password" inputMode="numeric" autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={code} maxLength={8} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} />
        </label>
        {error && <p className="editor-error" role="alert">{error}</p>}
        <div className="btn-row">
          {onCancel && <button className="btn btn--ghost" type="button" disabled={busy} onClick={onCancel}>取消</button>}
          <button className="btn btn--primary" type="submit" disabled={busy || !valid}>{busy ? "验证中…" : "验证"}</button>
        </div>
      </form>
    </div>
  </div>;
}

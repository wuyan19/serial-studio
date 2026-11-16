import { useEffect, useRef, useState } from "react";
import { createDeviceShareUrl, type DeviceShareAddress } from "../device-share";
import { copyText } from "../lib";
import { IconCopy, IconShare } from "../icons";
import { ConfigRow, useDialogA11y, useDialogKeys } from "./primitives";

export function DeviceShareDialog({ loadAddresses, onClose }: {
  loadAddresses: () => Promise<DeviceShareAddress[]>;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setCopied(false);
    setLinks([]);
    setSelected("");
    void loadAddresses().then((addresses) => {
      const next = [...new Set(addresses.map(createDeviceShareUrl))];
      if (!next.length) throw new Error("未找到可分享的局域网地址，请检查网络连接");
      if (!active) return;
      setLinks(next);
      setSelected(next[0]);
    }).catch((error) => {
      if (active) setError(String(error instanceof Error ? error.message : error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAddresses, attempt]);
  const copy = async () => {
    if (loading || error || !selected) return;
    if (await copyText(selected)) setCopied(true);
    else setError("复制失败，请选中链接手动复制");
  };
  useDialogKeys({ onClose, onEnter: () => { void copy(); } });
  return <div className="dialog-overlay">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="分享当前设备" className="dialog dialog--med">
      <h3 className="dialog__title"><IconShare /> 分享当前设备</h3>
      <div className="dialog__sub">复制链接，分享此设备的 Serial Studio 服务。</div>
      {loading ? <p className="dialog__hint">正在获取设备地址…</p> : <>
        {links.length > 1 && <ConfigRow label="设备地址">
          <select className="field-select" aria-label="分享设备地址" value={selected} onChange={(event) => { setSelected(event.target.value); setCopied(false); }}>
            {links.map((link) => <option key={link} value={link}>{new URL(link).host}</option>)}
          </select>
        </ConfigRow>}
        {selected && <ConfigRow label="分享链接"><input className="field" aria-label="分享链接" value={selected} readOnly onFocus={(event) => event.target.select()} /></ConfigRow>}
        {error && <p className="dialog__hint" role="alert">{error}</p>}
        {!error && <p className="dialog__hint">同一网络中的设备可通过浏览器打开。复制链接后唤起桌面版，可快速添加远程设备。</p>}
      </>}
      <div className="btn-row">
        <button className="btn btn--ghost" onClick={onClose}>关闭</button>
        {error && <button className="btn" onClick={() => setAttempt((value) => value + 1)}>重试</button>}
        <button className="btn btn--primary" onClick={() => void copy()} disabled={loading || !!error || !selected}><IconCopy />{copied ? "已复制" : "复制链接"}</button>
      </div>
    </div>
  </div>;
}

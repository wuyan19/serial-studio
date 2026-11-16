import { useEffect, useRef, useState } from "react";
import { IconClose, IconExport, IconImport, IconRefresh } from "../icons";
import type { SshFileClient, SshFileEntry, SshFileProgress } from "../ssh-files";
import { isFileDrop } from "../file-drop";
import "../ssh-files.css";

function FileIcon({ folder = false }: { folder?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {folder ? <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /> : <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Z" /><path d="M13 3v7h7" /></>}
  </svg>;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function parentPath(path: string) {
  if (path === "/") return "/";
  const index = path.replace(/\/$/, "").lastIndexOf("/");
  return index < 0 ? ".." : path.slice(0, index) || "/";
}

type UploadChoice = { target: string } & (
  | { kind: "picker"; directory: boolean }
  | { kind: "drop"; files: File[] }
);

export function SshFilesPanel({ client, label, onClose }: {
  client: SshFileClient;
  label: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(340);
  const [path, setPath] = useState(".");
  const [draft, setDraft] = useState(".");
  const [entries, setEntries] = useState<SshFileEntry[]>([]);
  const [selected, setSelected] = useState<SshFileEntry | null>(null);
  const [preview, setPreview] = useState<{ text: string | null; truncated: boolean; size: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [protocol, setProtocol] = useState<string>();
  const [progress, setProgress] = useState<SshFileProgress | null>(null);
  const [uploadChoice, setUploadChoice] = useState<UploadChoice | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const current = useRef(true);
  const request = useRef<AbortController | null>(null);
  const transfer = useRef<AbortController | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);

  const showError = (cause: unknown) => {
    if (current.current && !(cause instanceof DOMException && cause.name === "AbortError")) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const navigate = async (destination: string) => {
    if (busy) return;
    setUploadChoice(null);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setSelected(null);
    setPreview(null);
    try {
      const result = await client.list(destination, controller.signal);
      if (controller.signal.aborted || !current.current) return;
      setPath(result.path);
      setProtocol(result.protocol);
      setDraft(result.path);
      setEntries([...result.entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)));
    } catch (cause) {
      if (!controller.signal.aborted) showError(cause);
    } finally {
      if (!controller.signal.aborted && current.current) setLoading(false);
    }
  };
  useEffect(() => {
    current.current = true;
    void navigate(".");
    return () => {
      current.current = false;
      request.current?.abort();
      transfer.current?.abort();
      resizeCleanup.current?.();
    };
  }, [client]);

  const openFile = async (entry: SshFileEntry) => {
    if (entry.kind === "directory") { void navigate(entry.path); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSelected(entry);
    setPreview(null);
    setLoading(true);
    setError("");
    try {
      const result = await client.preview(entry.path, controller.signal);
      if (!controller.signal.aborted && current.current) setPreview(result);
    } catch (cause) { if (!controller.signal.aborted) showError(cause); }
    finally { if (!controller.signal.aborted && current.current) setLoading(false); }
  };
  const runTransfer = async (action: (signal: AbortSignal, update: (value: SshFileProgress) => void) => Promise<boolean>, uploading: boolean) => {
    if (transfer.current) return;
    const controller = new AbortController();
    transfer.current = controller;
    setBusy(true);
    setProgress(null);
    setError("");
    setStatus("");
    try {
      const done = await action(controller.signal, (value) => {
        if (current.current && !controller.signal.aborted) setProgress(value);
      });
      if (!current.current || controller.signal.aborted) return;
      setStatus(done ? (uploading ? "上传完成" : "下载完成") : "已取消");
    } catch (cause) {
      if (!controller.signal.aborted) showError(cause);
    } finally {
      if (current.current) {
        setBusy(false);
        setProgress(null);
        transfer.current = null;
        if (uploading) {
          // The transfer no longer owns the UI when the refreshed listing arrives.
          request.current?.abort();
          const refresh = new AbortController();
          request.current = refresh;
          void client.list(path, refresh.signal).then((result) => {
            if (!current.current || refresh.signal.aborted) return;
            setEntries([...result.entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)));
          }).catch((cause) => { if (!refresh.signal.aborted) showError(cause); });
        }
      }
    }
  };
  const download = (entry?: SshFileEntry) => {
    const target = entry ?? selected ?? { path, name: path.split("/").filter(Boolean).slice(-1)[0] || "root", kind: "directory", size: 0 } as SshFileEntry;
    void runTransfer((signal, update) => client.download(target, update, signal), false);
  };

  return <aside className="ssh-files" aria-label={`SSH 文件：${label}`} style={{ width }}
    data-file-drop={draggingFiles || undefined}
    onDragOver={(event) => {
      if (!isFileDrop(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = busy || loading ? "none" : "copy";
      setDraggingFiles(!busy && !loading);
    }}
    onDragLeave={(event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDraggingFiles(false);
    }}
    onDrop={(event) => {
      if (!isFileDrop(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDraggingFiles(false);
      if (busy || loading) return;
      if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
        setError("上传文件夹请使用底部的“文件夹”按钮。");
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (!files.length) return;
      if (files.length > 10000) { setError("一次最多上传 10000 个文件。"); return; }
      setError("");
      setUploadChoice({ kind: "drop", files, target: path });
    }}>
    <div className="ssh-files__resizer" role="separator" aria-label="调整文件面板宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={260} aria-valuemax={560} tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((value) => Math.max(260, Math.min(560, value + (event.key === "ArrowLeft" ? 20 : -20)))); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizeCleanup.current?.();
        const start = event.clientX;
        const previous = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        const move = (e: PointerEvent) => setWidth(Math.max(260, Math.min(560, width + start - e.clientX)));
        const cleanup = () => { document.body.style.userSelect = previous; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", cleanup); window.removeEventListener("pointercancel", cleanup); resizeCleanup.current = null; };
        resizeCleanup.current = cleanup;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", cleanup);
        window.addEventListener("pointercancel", cleanup);
      }} />
    <header className="ssh-files__header"><strong><FileIcon folder /> SSH 文件</strong><button className="icon-btn" onClick={onClose} aria-label="收起 SSH 文件面板" title="收起"><IconClose /></button></header>
    <div className="ssh-files__host" title={label}>{label}</div>
    <form className="ssh-files__path" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void navigate(draft.trim()); }}>
      <button type="button" className="icon-btn" disabled={busy || loading || path === "/"} onClick={() => void navigate(parentPath(path))} title="上级目录" aria-label="上级目录">↑</button>
      <input aria-label="远程目录路径" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} spellCheck={false} />
      <button type="button" className="icon-btn" disabled={busy || loading} onClick={() => void navigate(path)} title="刷新目录" aria-label="刷新目录"><IconRefresh /></button>
    </form>
    {error && <div className="ssh-files__error" role="alert"><span>{error}</span><button onClick={() => selected ? void openFile(selected) : void navigate(path)} disabled={busy}>重试</button></div>}
    {selected ? <section className="ssh-files__preview" aria-label="文件预览">
      <div className="ssh-files__preview-title"><button onClick={() => { request.current?.abort(); setLoading(false); setSelected(null); setPreview(null); setError(""); }}>← 返回</button><span title={selected.name}>{selected.name}</span></div>
      {loading ? <p className="ssh-files__message" role="status">正在读取文件…</p> : preview && <>
        <div className="ssh-files__meta">{sizeLabel(preview.size)}{preview.truncated ? " · 仅预览文件开头" : ""}</div>
        {preview.text === null ? <p className="ssh-files__message">此文件不支持文本预览，可下载后查看。</p> : <pre tabIndex={0}>{preview.text || "（空文件）"}</pre>}
      </>}
    </section> : <div className="ssh-files__list" aria-label="远程文件列表" aria-busy={loading}>
      {loading ? <p className="ssh-files__message" role="status">正在读取目录…</p> : entries.length === 0 ? <p className="ssh-files__message">{error ? "目录未加载" : "此目录为空"}</p> : entries.map((entry) => <div className="ssh-files__row" key={entry.name}>
        <button className="ssh-files__entry" onClick={() => void openFile(entry)} disabled={busy || entry.kind === "other"} title={entry.path}><FileIcon folder={entry.kind === "directory"} /><span>{entry.name}{entry.kind === "symlink" ? " ↗" : ""}</span><small>{entry.kind === "directory" ? "" : sizeLabel(entry.size)}</small></button>
        <button className="icon-btn ssh-files__row-download" disabled={busy || entry.kind === "other"} aria-label={`下载 ${entry.name}`} title={`下载${entry.kind === "directory" ? "文件夹" : "文件"}`} onClick={() => download(entry)}><IconImport /></button>
      </div>)}
    </div>}
    <div className="ssh-files__toolbar">
      <button disabled={busy || loading} onClick={() => setUploadChoice({ kind: "picker", directory: false, target: path })}><IconExport />文件</button>
      <button disabled={busy || loading} onClick={() => setUploadChoice({ kind: "picker", directory: true, target: path })}><IconExport />文件夹</button>
      <button disabled={busy || loading} onClick={() => download()} title={selected ? `下载 ${selected.name}` : "下载当前文件夹"}><IconImport />下载</button>
    </div>
    {uploadChoice && <div className="ssh-files__confirm" role="alert">
      <span>{uploadChoice.kind === "drop" ? `上传 ${uploadChoice.files.length} 个文件到 ${uploadChoice.target}？` : `上传到 ${uploadChoice.target}。`}同名文件可能被覆盖；不支持替换时会保留原文件并提示失败。</span><div><button type="button" onClick={() => setUploadChoice(null)}>取消</button><button type="button" disabled={busy} onClick={() => {
        if (transfer.current) return;
        const choice = uploadChoice;
        request.current?.abort();
        setLoading(false);
        setSelected(null);
        setPreview(null);
        setUploadChoice(null);
        void runTransfer((signal, update) => choice.kind === "drop"
          ? client.uploadFiles(choice.files, choice.target, update, signal)
          : client.upload(choice.directory, choice.target, update, signal), true);
      }}>{uploadChoice.kind === "drop" ? "确认上传" : `选择${uploadChoice.directory ? "文件夹" : "文件"}`}</button></div>
    </div>}
    <footer className="ssh-files__footer" aria-live="polite">
      {busy ? <><div className="ssh-files__progress-label"><span title={progress?.name}>{progress?.name || "正在准备传输…"}</span><button onClick={() => { transfer.current?.abort(); setStatus("已取消；已传输的文件可能保留"); }}>取消</button></div>{progress && <><progress max={progress.total || 1} value={progress.bytes} /><small>{sizeLabel(progress.bytes)} / {sizeLabel(progress.total)} · {progress.files} 个文件</small></>}</> : <span>{status || `${entries.length} 项 · ${protocol === "ssh" ? "SSH 兼容" : protocol === "sftp" ? "SFTP" : "SSH 文件"}`}</span>}
    </footer>
  </aside>;
}

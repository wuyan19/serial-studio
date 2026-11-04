import { useEffect, useId, useState, type ReactNode } from "react";
import type { Transport } from "../transport";
import { createSshFileClient, type SshFileClient } from "../ssh-files";
import { SshFilesPanel } from "./ssh-files";

function MountedFiles({ transport, hostId, label, onClose }: {
  transport: Transport; hostId: string; label: string; onClose: () => void;
}) {
  const [client, setClient] = useState<SshFileClient | null>(null);
  useEffect(() => {
    const next = createSshFileClient(operation => transport.sshFiles(hostId, operation));
    setClient(next);
    return () => next.dispose();
  }, [transport, hostId]);
  return client && <SshFilesPanel client={client} label={label} onClose={onClose} />;
}

export function SshFileWorkspace({ transport, hostId, label, children }: {
  transport?: Transport;
  hostId?: string;
  label: string;
  children: (tools: ReactNode, panel: ReactNode) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  useEffect(() => transport?.onConnectedChange(connected => {
    if (!connected) setExpanded(false);
  }), [transport]);
  const available = !!transport && !!hostId;
  const tools = available && <button
    type="button" className="ssh-files-toggle" aria-label={expanded ? "收起 SSH 文件系统" : "展开 SSH 文件系统"}
    title={expanded ? "收起 SSH 文件系统" : "展开 SSH 文件系统"}
    aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
    onClick={() => setExpanded(value => !value)}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
      <path d={expanded ? "m8 9 3 3-3 3" : "m11 9-3 3 3 3"} />
    </svg>
  </button>;
  const panel = available && expanded && <div id={panelId} className="ssh-files-slot">
    <MountedFiles key={`${transport.devId}:${hostId}`} transport={transport} hostId={hostId} label={label} onClose={() => setExpanded(false)} />
  </div>;
  return children(tools, panel);
}

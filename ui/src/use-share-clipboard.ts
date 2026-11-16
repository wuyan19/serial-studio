import { useEffect, useRef } from "react";
import { createShareClipboardScanner, type DeviceShareAddress } from "./device-share";
import { readClipboardText, tauriInvoke } from "./lib";
import type { RemoteDevice } from "./types";

export function useShareClipboard({ enabled, ready, blocked, remotes, onShare }: {
  enabled: boolean;
  ready: boolean;
  blocked: boolean;
  remotes: RemoteDevice[];
  onShare: (address: DeviceShareAddress) => void;
}) {
  const current = useRef({ blocked, remotes, onShare });
  current.current = { blocked, remotes, onShare };
  const pending = useRef<DeviceShareAddress | null>(null);
  const focused = useRef(false);
  const flush = () => {
    const address = pending.current;
    if (!address || !focused.current || current.current.blocked) return;
    pending.current = null;
    if (current.current.remotes.some((remote) => remote.host === address.host && remote.port === address.port)) return;
    current.current.onShare(address);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => { flushRef.current(); }, [blocked, remotes]);

  useEffect(() => {
    if (!enabled || !ready) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focusRevision = 0;
    const scanner = createShareClipboardScanner({
      read: readClipboardText,
      isIgnored: async (address) => {
        if (current.current.remotes.some((remote) => remote.host === address.host && remote.port === address.port)) return true;
        const [hosts, status] = await Promise.all([
          tauriInvoke<string[]>("get_local_share_hosts"),
          tauriInvoke<{ ws_addr: string | null }>("service_status"),
        ]);
        const ownPort = Number(status.ws_addr?.slice(status.ws_addr.lastIndexOf(":") + 1));
        return hosts.includes(address.host) && ownPort === address.port;
      },
      onShare: (address) => {
        pending.current = address;
        flushRef.current();
      },
    });
    const focusChanged = (value: boolean) => {
      if (!active) return;
      focused.current = value;
      clearTimeout(timer);
      if (value) {
        flushRef.current();
        timer = setTimeout(() => { void scanner.check(); }, 150);
      }
    };
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const off = await window.onFocusChanged(({ payload }) => { focusRevision++; focusChanged(payload); });
      if (!active) { off(); return; }
      unlisten = off;
      const revision = focusRevision;
      const value = await window.isFocused();
      if (revision === focusRevision) focusChanged(value);
    }).catch(() => {});
    return () => {
      active = false;
      focused.current = false;
      pending.current = null;
      clearTimeout(timer);
      scanner.stop();
      unlisten?.();
    };
  }, [enabled, ready]);
}

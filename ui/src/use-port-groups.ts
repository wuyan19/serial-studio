import { useCallback, useEffect, useRef, useState } from "react";
import { clientGrouping, type PortGroupsOperation } from "./port-groups";
import { SharedPortGroups, type GroupSyncState, type PortGroupsConnection } from "./shared-port-groups";

const emptyState = (): GroupSyncState => ({ snapshot: null, collapsed: [], ready: false, error: "" });

export function usePortGroups(getConnection: () => PortGroupsConnection | undefined, available: boolean, scope: string) {
  const [state, setState] = useState<GroupSyncState>(emptyState);
  const controller = useRef<SharedPortGroups | null>(null);
  const domain = useRef("local");
  useEffect(() => {
    setState(emptyState());
    if (!available) return;
    const connection = getConnection();
    if (!connection) return;
    domain.current = connection.devId;
    const sync = new SharedPortGroups(connection, localStorage, setState,
      () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    controller.current = sync;
    void sync.start();
    return () => { sync.stop(); controller.current = null; };
  }, [getConnection, available, scope]);

  const update = useCallback(async (operation: PortGroupsOperation) => {
    const sync = controller.current;
    if (!sync) throw new Error("请先连接服务");
    await sync.update(operation);
  }, []);
  const toggleCollapsed = useCallback((name: string) => controller.current?.toggleCollapsed(name), []);
  const reload = useCallback(() => { void controller.current?.reload(); }, []);
  return { grouping: clientGrouping(state.snapshot, domain.current, state.collapsed), ready: state.ready, error: state.error, update, toggleCollapsed, reload };
}

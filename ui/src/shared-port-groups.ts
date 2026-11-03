import {
  PORT_GROUPS_KEY, canonicalGrouping, parsePortGrouping,
  type PortGroupsOperation, type PortGroupsSnapshot,
} from "./port-groups";

export interface PortGroupsConnection {
  readonly devId: string;
  getPortGroups(): Promise<PortGroupsSnapshot>;
  updatePortGroups(operation: PortGroupsOperation): Promise<PortGroupsSnapshot>;
  onPortGroups(cb: (snapshot: PortGroupsSnapshot) => void): () => void;
}

export interface GroupSyncState {
  snapshot: PortGroupsSnapshot | null;
  collapsed: string[];
  ready: boolean;
  error: string;
}

type Preferences = Pick<Storage, "getItem" | "setItem">;
const MIGRATION_KEY = `${PORT_GROUPS_KEY}:migration`;
const collapsedKey = (serverId: string) => `${PORT_GROUPS_KEY}:collapsed:${serverId}`;

export class SharedPortGroups {
  state: GroupSyncState = { snapshot: null, collapsed: [], ready: false, error: "" };
  private stopped = false;
  private unsubscribe?: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private connection: PortGroupsConnection,
    private preferences: Preferences,
    private changed: (state: GroupSyncState) => void,
    private sourceId: () => string,
  ) {}

  private publish(patch: Partial<GroupSyncState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  private accept(snapshot: PortGroupsSnapshot) {
    if (this.stopped) return;
    const previous = this.state.snapshot;
    if (previous && previous.serverId !== snapshot.serverId) return;
    if (previous && previous.revision > snapshot.revision) return;
    let collapsed = this.state.collapsed;
    if (!previous) {
      try {
        const value: unknown = JSON.parse(this.preferences.getItem(collapsedKey(snapshot.serverId)) ?? "null");
        collapsed = Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
      } catch { collapsed = []; }
    }
    this.publish({ snapshot, collapsed, error: "" });
  }

  async start() {
    this.unsubscribe = this.connection.onPortGroups((snapshot) => this.accept(snapshot));
    await this.reload();
  }

  async reload() {
    try {
      const snapshot = await this.connection.getPortGroups();
      if (this.stopped) return;
      this.accept(snapshot);
      await this.migrate(snapshot.serverId);
      if (!this.stopped) this.publish({ ready: true, error: "" });
    } catch (error) {
      this.publish({ ready: false, error: `分组同步失败：${String(error instanceof Error ? error.message : error)}` });
    }
  }

  private async migrate(serverId: string) {
    const legacy = parsePortGrouping(this.preferences.getItem(PORT_GROUPS_KEY));
    if (!legacy.names.length) return;
    const saved: unknown = JSON.parse(this.preferences.getItem(MIGRATION_KEY) ?? "null");
    let marker: { sourceId: string; serverId: string };
    if (saved && typeof saved === "object" && "sourceId" in saved && typeof saved.sourceId === "string" && "serverId" in saved && typeof saved.serverId === "string") {
      marker = { sourceId: saved.sourceId, serverId: saved.serverId };
      if (marker.serverId !== serverId) return;
    } else {
      marker = { sourceId: this.sourceId(), serverId };
      // Persist the binding before importing so retries cannot seed a different server.
      this.preferences.setItem(MIGRATION_KEY, JSON.stringify(marker));
      if (!this.preferences.getItem(collapsedKey(serverId))) {
        this.preferences.setItem(collapsedKey(serverId), JSON.stringify(legacy.collapsed));
        this.publish({ collapsed: legacy.collapsed });
      }
    }
    const snapshot = await this.connection.updatePortGroups({
      type: "migrate", sourceId: marker.sourceId, data: canonicalGrouping(legacy, this.connection.devId),
    });
    this.accept(snapshot);
  }

  update(operation: PortGroupsOperation): Promise<void> {
    const work = this.queue.then(async () => {
      if (this.stopped || !this.state.ready) throw new Error("分组尚未同步，请连接服务后重试");
      try {
        const snapshot = await this.connection.updatePortGroups(operation);
        this.accept(snapshot);
        if (operation.type === "rename") {
          this.saveCollapsed(this.state.collapsed.map((name) => name === operation.name ? operation.newName.trim() : name));
        } else if (operation.type === "dissolve") {
          this.saveCollapsed(this.state.collapsed.filter((name) => name !== operation.name));
        }
      } catch (error) {
        this.publish({ error: `保存分组失败：${String(error instanceof Error ? error.message : error)}` });
        throw error;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  private saveCollapsed(collapsed: string[]) {
    this.publish({ collapsed });
    const serverId = this.state.snapshot?.serverId;
    if (!serverId || this.stopped) return;
    try { this.preferences.setItem(collapsedKey(serverId), JSON.stringify(collapsed)); }
    catch { /* Display preferences remain usable in this window. */ }
  }

  toggleCollapsed(name: string) {
    const collapsed = this.state.collapsed;
    this.saveCollapsed(collapsed.includes(name) ? collapsed.filter((item) => item !== name) : [...collapsed, name]);
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
  }
}

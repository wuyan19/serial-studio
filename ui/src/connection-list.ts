import type { PortGroupView } from "./components/sidebar";
import { parsePortId } from "./lib";
import type { PortRow } from "./types";
import { getGroupMemberships, type PortGrouping } from "./port-groups";

export type ConnectionListRow =
  | { kind: "serial"; group: PortGroupView; port: PortRow }
  | { kind: "ssh"; group: PortGroupView; ports: PortRow[] };

export function defaultConnectionSections(groups: PortGroupView[], remoteIds: ReadonlySet<string>) {
  const childrenByRemote = new Map<string, PortGroupView[]>();
  const topLevel: PortGroupView[] = [];
  for (const group of groups) {
    if (group.kind !== "ssh" || !group.ports.length) {
      topLevel.push(group);
      continue;
    }
    // The route identifies the relay; device metadata identifies the SSH host.
    const portsByRelay = new Map<string, PortRow[]>();
    const direct: PortRow[] = [];
    for (const port of group.ports) {
      const { devId, name } = parsePortId(port.pid);
      if (remoteIds.has(devId) && name.includes("::")) {
        const ports = portsByRelay.get(devId) ?? [];
        ports.push(port);
        portsByRelay.set(devId, ports);
      } else {
        direct.push(port);
      }
    }
    for (const [relay, ports] of portsByRelay) {
      const children = childrenByRemote.get(relay) ?? [];
      children.push({
        ...group,
        ports,
        external: group.external || ports[0].name === ports[0].pid,
        meta: ports[0].device ?? group.meta,
      });
      childrenByRemote.set(relay, children);
    }
    if (direct.length) topLevel.push({ ...group, ports: direct });
  }
  return topLevel.map((group) => ({ group, sshChildren: childrenByRemote.get(group.devId) ?? [] }));
}

export function connectionRows(
  groups: PortGroupView[],
  grouping: PortGrouping,
  customGroup: string | null,
  query: string,
): ConnectionListRow[] {
  const search = query.trim().toLocaleLowerCase();
  const groupNameMatches = customGroup !== null && customGroup.toLocaleLowerCase().includes(search);
  const rows: ConnectionListRow[] = [];
  for (const group of groups) {
    const wholeDevice = customGroup === null || (group.kind === "ssh" && getGroupMemberships(grouping.sshAssignments, group.devId).includes(customGroup));
    const ports = wholeDevice ? group.ports : group.ports.filter((port) => customGroup !== null && getGroupMemberships(grouping.assignments, port.pid).includes(customGroup));
    const deviceMatches = !search || groupNameMatches || `${group.label} ${group.detail ?? ""}`.toLocaleLowerCase().includes(search);
    const portMatches = (port: PortRow) => deviceMatches || `${port.name} ${port.alias ?? ""} ${port.device?.label ?? ""}`.toLocaleLowerCase().includes(search);
    if (group.kind === "ssh") {
      if (!ports.length && !wholeDevice) continue;
      // A search hit must not discard sibling sessions needed by the row's actions.
      if (deviceMatches || ports.some(portMatches)) rows.push({ kind: "ssh", group, ports });
    } else {
      for (const port of ports) {
        if (portMatches(port)) rows.push({ kind: "serial", group, port });
      }
    }
  }
  return rows;
}

function isSshInstance(port: PortRow): boolean {
  if (port.instance != null) return true;
  const index = port.name.lastIndexOf("::");
  return port.name.slice(index < 0 ? 0 : index + 2).includes("@");
}

export function selectSshPort(ports: PortRow[], activePort: string): PortRow | undefined {
  return ports.find((port) => port.pid === activePort)
    ?? ports.find((port) => port.opened && !isSshInstance(port))
    ?? ports.find((port) => port.opened)
    ?? ports.find((port) => !isSshInstance(port))
    ?? ports[0];
}

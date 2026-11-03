export const PORT_GROUPS_KEY = "serial-studio-port-groups-v1";

type Memberships = Record<string, string[]>;

export interface PortGrouping {
  names: string[];
  assignments: Memberships;
  sshAssignments: Memberships;
  collapsed: string[];
}

export type SharedPortGrouping = Omit<PortGrouping, "collapsed">;

export interface PortGroupsSnapshot extends SharedPortGrouping {
  serverId: string;
  revision: number;
}

export type PortGroupsOperation =
  | { type: "create"; name: string }
  | { type: "rename"; name: string; newName: string }
  | { type: "dissolve"; name: string }
  | { type: "membership"; kind: "port" | "ssh"; id: string; name: string; included: boolean }
  | { type: "migrate"; sourceId: string; data: SharedPortGrouping };

export function canonicalGrouping(grouping: PortGrouping, devId: string): SharedPortGrouping {
  const prefix = `${devId}::`;
  const assignments = new Map<string, string[]>();
  for (const [pid, names] of Object.entries(grouping.assignments)) {
    const id = devId !== "local" && pid.startsWith(prefix) ? pid.slice(prefix.length) : pid;
    assignments.set(id, [...new Set([...(assignments.get(id) ?? []), ...names])]);
  }
  return { names: grouping.names, assignments: Object.fromEntries(assignments), sshAssignments: grouping.sshAssignments };
}

export function clientGrouping(snapshot: PortGroupsSnapshot | null, devId: string, collapsed: string[]): PortGrouping {
  if (!snapshot) return { ...emptyPortGrouping(), collapsed };
  return {
    names: snapshot.names,
    assignments: Object.fromEntries(Object.entries(snapshot.assignments).map(([wire, names]) => [devId === "local" ? wire : `${devId}::${wire}`, names])),
    sshAssignments: snapshot.sshAssignments,
    collapsed,
  };
}

export function emptyPortGrouping(): PortGrouping {
  return { names: [], assignments: {}, sshAssignments: {}, collapsed: [] };
}

export function getGroupMemberships(assignments: Memberships, id: string): string[] {
  return Object.prototype.hasOwnProperty.call(assignments, id) ? assignments[id] : [];
}

function parseMemberships(source: unknown, names: string[]): Memberships {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).flatMap(([id, value]) => {
    if (!id) return [];
    const values: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    const groups = [...new Set(values.filter((name): name is string => typeof name === "string" && names.includes(name)))];
    return groups.length ? [[id, groups]] : [];
  }));
}

export function parsePortGrouping(raw: string | null): PortGrouping {
  if (!raw) return emptyPortGrouping();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPortGrouping();
    const input = value as Record<string, unknown>;
    const names = Array.isArray(input.names)
      ? [...new Set(input.names.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean))]
      : [];
    const collapsed = Array.isArray(input.collapsed)
      ? [...new Set(input.collapsed.filter((name): name is string => typeof name === "string" && names.includes(name)))]
      : [];
    return {
      names,
      assignments: parseMemberships(input.assignments, names),
      sshAssignments: parseMemberships(input.sshAssignments, names),
      collapsed,
    };
  } catch {
    return emptyPortGrouping();
  }
}

function addMembership(state: PortGrouping, field: "assignments" | "sshAssignments", id: string, name: string): PortGrouping {
  const existing = getGroupMemberships(state[field], id);
  if (!id || !state.names.includes(name) || existing.includes(name)) return state;
  const assignments = { ...state[field] };
  Object.defineProperty(assignments, id, { value: [...existing, name], writable: true, enumerable: true, configurable: true });
  return { ...state, [field]: assignments };
}

function removeMembership(state: PortGrouping, field: "assignments" | "sshAssignments", id: string, name: string): PortGrouping {
  const existing = getGroupMemberships(state[field], id);
  if (!existing.includes(name)) return state;
  const assignments = { ...state[field] };
  const remaining = existing.filter((entry) => entry !== name);
  if (remaining.length) Object.defineProperty(assignments, id, { value: remaining, writable: true, enumerable: true, configurable: true });
  else delete assignments[id];
  return { ...state, [field]: assignments };
}

export function addPortToGroup(state: PortGrouping, pid: string, name: string): PortGrouping {
  return addMembership(state, "assignments", pid, name);
}

export function removePortFromGroup(state: PortGrouping, pid: string, name: string): PortGrouping {
  return removeMembership(state, "assignments", pid, name);
}

export function addSshToGroup(state: PortGrouping, devId: string, name: string): PortGrouping {
  return addMembership(state, "sshAssignments", devId, name);
}

export function removeSshFromGroup(state: PortGrouping, devId: string, name: string): PortGrouping {
  return removeMembership(state, "sshAssignments", devId, name);
}

function mapMemberships(assignments: Memberships, transform: (name: string) => string | null): Memberships {
  return Object.fromEntries(Object.entries(assignments).flatMap(([id, names]) => {
    const next = names.flatMap((name) => {
      const mapped = transform(name);
      return mapped === null ? [] : [mapped];
    });
    return next.length ? [[id, next]] : [];
  }));
}

export function renamePortGroup(state: PortGrouping, oldName: string, value: string): PortGrouping {
  const name = value.trim();
  if (!name || !state.names.includes(oldName) || name === oldName || state.names.includes(name)) return state;
  const rename = (entry: string) => entry === oldName ? name : entry;
  return {
    names: state.names.map(rename),
    assignments: mapMemberships(state.assignments, rename),
    sshAssignments: mapMemberships(state.sshAssignments, rename),
    collapsed: state.collapsed.map(rename),
  };
}

export function dissolvePortGroup(state: PortGrouping, name: string): PortGrouping {
  if (!state.names.includes(name)) return state;
  const remove = (entry: string) => entry === name ? null : entry;
  return {
    names: state.names.filter((entry) => entry !== name),
    assignments: mapMemberships(state.assignments, remove),
    sshAssignments: mapMemberships(state.sshAssignments, remove),
    collapsed: state.collapsed.filter((entry) => entry !== name),
  };
}

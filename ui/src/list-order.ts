export type ListOrders = Record<string, string[]>;

export function parseListOrders(raw: string | null): ListOrders {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([scope, ids]) =>
      Array.isArray(ids) && ids.every(id => typeof id === "string")
        ? [[scope, [...new Set(ids)]]] : []));
  } catch { return {}; }
}

export function orderItems<T>(items: readonly T[], saved: readonly string[], keyOf: (item: T) => string): T[] {
  const positions = new Map(saved.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (positions.get(keyOf(a)) ?? saved.length) - (positions.get(keyOf(b)) ?? saved.length));
}

export function moveListItem(ids: readonly string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

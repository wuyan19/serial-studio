import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { moveListItem, orderItems, parseListOrders, type ListOrders } from "./list-order";

const MIME = "application/x-serial-studio-list-item";
const scopeKey = (scope: string) => `serial-studio-connection-order-v1:${scope}`;

function load(key: string): ListOrders {
  try { return parseListOrders(localStorage.getItem(key)); }
  catch { return {}; }
}

export function useListOrder(storageScope: string) {
  const key = scopeKey(storageScope);
  const [state, setState] = useState(() => ({ key, orders: load(key) }));
  const source = useRef<{ scope: string; id: string } | null>(null);
  const suppressClick = useRef(false);
  const [hint, setHint] = useState<{ scope: string; id: string; after: boolean } | null>(null);
  const orders = state.key === key ? state.orders : {};
  useEffect(() => {
    setState({ key, orders: load(key) });
    source.current = null;
    suppressClick.current = false;
    setHint(null);
  }, [key]);

  function sort<T>(scope: string, items: readonly T[], keyOf: (item: T) => string) {
    return orderItems(items, Object.prototype.hasOwnProperty.call(orders, scope) ? orders[scope] : [], keyOf);
  }

  function bind(scope: string, id: string, ids: string[]): HTMLAttributes<HTMLDivElement> & {
    "data-sort-id": string; "data-sort-scope": string; "data-drop-position"?: string;
  } {
    const accepts = (event: DragEvent) => source.current?.scope === scope && source.current.id !== id &&
      ids.includes(source.current.id) && ids.includes(id) && Array.from(event.dataTransfer.types).includes(MIME);
    return {
      draggable: true,
      "data-sort-id": id,
      "data-sort-scope": scope,
      "data-drop-position": hint?.scope === scope && hint.id === id ? (hint.after ? "after" : "before") : undefined,
      onDragStart(event) {
        event.stopPropagation();
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable="true"], .port-item__edit, .port-item__force, .group-menu, [role="menu"]')) {
          event.preventDefault();
          return;
        }
        source.current = { scope, id };
        suppressClick.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(MIME, JSON.stringify({ scope, id }));
        event.dataTransfer.setData("text/plain", id);
      },
      onDragOver(event) {
        event.stopPropagation();
        if (!accepts(event)) { setHint(null); return; }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        setHint(previous => previous?.scope === scope && previous.id === id && previous.after === after
          ? previous : { scope, id, after });
      },
      onDragLeave(event) {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHint(null);
      },
      onDrop(event) {
        event.stopPropagation();
        if (!accepts(event)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const next: ListOrders = { ...orders, [scope]: moveListItem(ids, source.current!.id, id, event.clientY >= rect.top + rect.height / 2) };
        setState({ key, orders: next });
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Ordering still works without storage. */ }
        source.current = null;
        setHint(null);
      },
      onDragEnd(event) {
        event.stopPropagation();
        source.current = null;
        setHint(null);
      },
      onClickCapture(event) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onMouseDownCapture() { suppressClick.current = false; },
      onKeyDownCapture() { suppressClick.current = false; },
    };
  }
  return { sort, bind };
}

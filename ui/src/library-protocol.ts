import type { Macro, Script } from "./types";

export type LibraryKind = "macros" | "scripts";
export type LibraryItem = Macro | Script;
export type LibraryItems = Record<string, LibraryItem>;
export interface LibrarySnapshot {
  items: LibraryItems;
  serverId: string;
}
export type LibraryChanges = Record<string, { before: LibraryItem | null; after: LibraryItem | null }>;

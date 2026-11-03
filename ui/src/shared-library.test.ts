import { describe, expect, it, vi } from "vitest";
import { editorLibraryBefore, libraryChanges, sharedLibrarySource } from "./shared-library";
import type { Script } from "./types";

const script = (code: string): Script => ({ code });

describe("shared library edits", () => {
  it("sends only changed keys, including rename/delete, and preserves unrelated entries", () => {
    const before = { unchanged: script("same"), old: script("old"), removed: script("gone") };
    const next = { unchanged: script("same"), renamed: script("old") };
    expect(libraryChanges(before, next)).toEqual({
      old: { before: script("old"), after: null },
      removed: { before: script("gone"), after: null },
      renamed: { before: null, after: script("old") },
    });
  });

  it("uses the editor's original version after another client's update arrives", async () => {
    const original = script("v1");
    const current = { login: script("remote v2"), other: script("remote addition") };
    const connection = {
      getLibrary: vi.fn(),
      patchLibrary: vi.fn().mockRejectedValue(new Error("条目已被其他客户端修改")),
    };
    const source = sharedLibrarySource<Script>("scripts", "server-a", () => connection);
    const desired = { ...current, login: script("my v3") };
    await expect(source.persist(desired, editorLibraryBefore(current, "login", original))).rejects.toThrow("其他客户端修改");
    expect(connection.patchLibrary).toHaveBeenCalledWith("scripts", {
      login: { before: original, after: script("my v3") },
    });
    expect(current.login.code).toBe("remote v2");
    expect(current.other.code).toBe("remote addition");
  });

  it("requires the original item even when another client has removed it", () => {
    const current = { other: script("keep") };
    expect(libraryChanges(editorLibraryBefore(current, "deleted", script("original")), { ...current, deleted: script("edited") }))
      .toEqual({ deleted: { before: script("original"), after: script("edited") } });
  });

  it("supports prototype-looking names without changing object prototypes", () => {
    const before = Object.fromEntries([["__proto__", script("old")]]);
    const next = Object.fromEntries([["__proto__", script("new")], ["constructor", script("added")]]);
    const changes = libraryChanges(before, next);
    expect(Object.keys(changes)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(changes)).toBe(Object.prototype);
    expect(changes.__proto__).toEqual({ before: script("old"), after: script("new") });
  });

  it("loads and saves against the selected service without touching browser caches", async () => {
    const a = { getLibrary: vi.fn().mockResolvedValue({ items: { a: script("a") }, serverId: "a" }), patchLibrary: vi.fn() };
    const b = { getLibrary: vi.fn().mockResolvedValue({ items: { b: script("b") }, serverId: "b" }), patchLibrary: vi.fn() };
    const sourceA = sharedLibrarySource<Script>("scripts", "a", () => a);
    const sourceB = sharedLibrarySource<Script>("scripts", "b", () => b);
    await expect(sourceA.load()).resolves.toEqual({ items: { a: script("a") }, serverId: "a" });
    await expect(sourceB.load()).resolves.toEqual({ items: { b: script("b") }, serverId: "b" });
    expect(a.patchLibrary).not.toHaveBeenCalled();
    expect(b.patchLibrary).not.toHaveBeenCalled();
  });

  it("rejects unavailable connections instead of saving an empty local fallback", async () => {
    const source = sharedLibrarySource<Script>("scripts", "offline", () => undefined);
    await expect(source.load()).rejects.toThrow("请先连接服务");
    await expect(source.persist({ added: script("new") }, {})).rejects.toThrow("请先连接服务");
  });
});

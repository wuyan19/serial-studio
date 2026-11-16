// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  document.documentElement.dataset.theme = "codex";
  document.documentElement.dataset.lum = "dark";
});

afterEach(() => vi.unstubAllGlobals());

describe("two-choice workspace themes", () => {
  it.each([["apple", "codex"], ["stripe", "codex-light"], ["dark", "codex"], ["light", "codex-light"]])("migrates DOM theme %s to %s without changing font preferences", async (old, expected) => {
    document.documentElement.dataset.theme = old;
    localStorage.setItem("serial-studio-fontsize", "19");
    const theme = await import("./theme");
    expect(theme.getTheme()).toBe(expected);
    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(localStorage.getItem("serial-studio-theme")).toBe(expected);
    expect(localStorage.getItem("serial-studio-fontsize")).toBe("19");
  });

  it("offers and cycles only dark and light, including legacy setTheme calls", async () => {
    const theme = await import("./theme");
    expect(theme.APPEARANCE_THEMES.map(item => item.label)).toEqual(["深色", "浅色"]);
    const changes: string[] = [];
    const unsubscribe = theme.subscribe(value => changes.push(value));
    for (let i = 0; i < 4; i++) theme.toggleTheme();
    expect(changes).toEqual(["codex-light", "codex", "codex-light", "codex"]);
    theme.setTheme("stripe");
    expect(theme.getTheme()).toBe("codex-light");
    expect(document.documentElement.dataset.lum).toBe("light");
    expect(localStorage.getItem("serial-studio-theme")).toBe("codex-light");
    for (const definition of theme.THEMES) {
      expect(theme.normalizeTheme(definition.id)).toBe(definition.lum === "light" ? "codex-light" : "codex");
    }
    unsubscribe();
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * 主题三处登记的同步护栏(纯文本解析,不 import 运行时模块——theme.ts
 * 模块加载即触 DOM,node 环境跑不了;也不用 `?raw`:本 vitest 的 rolldown
 * 内核对 .css?raw 返回空串)。
 * 主题定义散在三处是架构现状:theme.ts::THEMES(TS 侧纯色)、
 * styles.css(CSS token 块)、index.html(首帧脚本 id 数组/lightIds/背景色)。
 * 本测试把"加了 theme.ts 忘掉另外两处"这类漂移拦在 CI。
 */

const themeTs = readFileSync(new URL("theme.ts", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("styles.css", import.meta.url), "utf8");

function initialTheme(saved: string | null, light: boolean, unavailable = false) {
  const attributes: Record<string, string> = {};
  const values = new Map<string, string>();
  if (saved !== null) values.set("serial-studio-theme", saved);
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing startup theme script");
  runInNewContext(script, {
    document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } } },
    localStorage: {
      getItem: (key: string) => {
        if (unavailable) throw new Error("Storage unavailable");
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
    window: { matchMedia: () => ({ matches: light }) },
  });
  return { attributes, values };
}

describe("startup theme selection", () => {
  it("uses the Codex system variant for new users", () => {
    expect(initialTheme(null, true).attributes).toMatchObject({ "data-theme": "codex-light", "data-lum": "light" });
    expect(initialTheme(null, false).attributes).toMatchObject({ "data-theme": "codex", "data-lum": "dark" });
  });

  it("migrates saved themes to the corresponding dark or light choice", () => {
    for (const { id, lum } of themes) {
      const result = initialTheme(id, lum !== "light");
      const expected = lum === "light" ? "codex-light" : "codex";
      expect(result.attributes).toMatchObject({ "data-theme": expected, "data-lum": lum });
      expect(result.values.get("serial-studio-theme")).toBe(expected);
    }
  });

  it("preserves the legacy theme migration", () => {
    const result = initialTheme("light", false);
    expect(result.attributes["data-theme"]).toBe("codex-light");
    expect(result.values.get("serial-studio-theme")).toBe("codex-light");
  });

  it("provides a readable fallback without browser storage", () => {
    expect(initialTheme(null, true, true).attributes).toMatchObject({ "data-theme": "codex", "data-lum": "dark" });
  });
});

/** 从 theme.ts 源码按序提取 (id, lum) 对——只认对象字面量里的带引号值,
 *  ThemeDef 接口的 `id: string` / `lum: "dark" | "light"` 声明不会命中前者的 id,
 *  且接口块位于全部条目之前,顺序扫描安全。 */
function extractThemes(): { id: string; lum: string }[] {
  const out: { id: string; lum: string }[] = [];
  const re = /id: "([a-z0-9-]+)"[\s\S]*?lum: "(dark|light)"/g;
  let m: RegExpExecArray | null;
  const registry = themeTs.split("export const THEMES = [")[1].split("] as const satisfies readonly ThemeDef[];")[0];
  while ((m = re.exec(registry))) out.push({ id: m[1], lum: m[2] });
  return out;
}

const themes = extractThemes();
const ids = themes.map((t) => t.id);
const lightIds = themes.filter((t) => t.lum === "light").map((t) => t.id);

function htmlIds(): string[] {
  const m = indexHtml.match(/var ids = \[([\s\S]*?)\]/);
  if (!m) throw new Error("index.html 里找不到 ids 数组");
  return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
}

function htmlLightIds(): string[] {
  const m = indexHtml.match(/var lightIds = \{([\s\S]*?)\}/);
  if (!m) throw new Error("index.html 里找不到 lightIds 映射");
  return [...m[1].matchAll(/"([a-z0-9-]+)":\s*1/g)].map((x) => x[1]);
}

describe("主题三处登记同步", () => {
  it("theme.ts 提取到全部主题(≥2 条,含明暗标记)", () => {
    expect(themes.length).toBeGreaterThanOrEqual(2);
    for (const t of themes) expect(["dark", "light"]).toContain(t.lum);
  });

  it("index.html ids 数组与 THEMES 一致且同序", () => {
    expect(htmlIds()).toEqual(ids);
  });

  it("index.html lightIds 映射与 lum=light 的主题集合一致", () => {
    expect([...htmlLightIds()].sort()).toEqual([...lightIds].sort());
  });

  it("除默认主题外,每个 id 在 styles.css 有 token 覆盖块", () => {
    // linear 是 :root 默认值本体,无覆盖块
    for (const id of ids.filter((i) => i !== "linear")) {
      expect(stylesCss).toMatch(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`));
    }
  });

  it("index.html 每个非默认主题有首帧背景规则,且与 styles.css 的 --bg 一致", () => {
    for (const id of ids.filter((i) => i !== "linear")) {
      const rule = indexHtml.match(new RegExp(`html\\[data-theme="${id}"\\]\\s*\\{[^}]*background:\\s*(#[0-9a-fA-F]+)`));
      expect(rule, `index.html 缺 ${id} 的首帧背景规则`).toBeTruthy();
      const block = stylesCss.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{[\\s\\S]*?\\}`));
      expect(block, `styles.css 缺 ${id} 的 token 块`).toBeTruthy();
      const bg = block![0].match(/--bg:\s*(#[0-9a-fA-F]+)/);
      expect(bg, `${id} 的 token 块缺 --bg`).toBeTruthy();
      expect(rule![1].toLowerCase()).toBe(bg![1].toLowerCase());
    }
  });
});

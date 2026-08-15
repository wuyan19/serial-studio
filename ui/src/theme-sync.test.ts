import { readFileSync } from "node:fs";
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

/** 从 theme.ts 源码按序提取 (id, lum) 对——只认对象字面量里的带引号值,
 *  ThemeDef 接口的 `id: string` / `lum: "dark" | "light"` 声明不会命中前者的 id,
 *  且接口块位于全部条目之前,顺序扫描安全。 */
function extractThemes(): { id: string; lum: string }[] {
  const out: { id: string; lum: string }[] = [];
  const re = /id: "([a-z0-9-]+)"[\s\S]*?lum: "(dark|light)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(themeTs))) out.push({ id: m[1], lum: m[2] });
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

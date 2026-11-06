/** 设置页注册表与搜索过滤的纯函数测试（不挂 DOM）。 */
import { describe, expect, it } from "vitest";
import { buildSettingsCategories, filterSettings } from "./settings-registry";

const CATS = buildSettingsCategories(true, true); // 服务器模式（条目最多的分支）；desktop 显式传真，绕开 isTauri 的 window 依赖

describe("buildSettingsCategories", () => {
  it("四个分类齐全且 id 唯一", () => {
    expect(CATS.map((c) => c.id)).toEqual(["appearance", "connection", "shortcuts", "about"]);
  });
  it("服务器模式连接分类是监听条目，客户端模式是主机/端口", () => {
    const serverIds = CATS.find((c) => c.id === "connection")!.items.map((i) => i.id);
    expect(serverIds).toContain("srv.ws_port");
    const clientIds = buildSettingsCategories(false, true).find((c) => c.id === "connection")!.items.map((i) => i.id);
    expect(clientIds).toEqual(["conn.host", "conn.port"]);
  });
  it("快捷键条目与分组一一对应", () => {
    const shortcuts = CATS.find((c) => c.id === "shortcuts")!;
    const grouped = shortcuts.shortcutGroups!.flatMap((g) => g.actions);
    expect(shortcuts.items.map((i) => i.id)).toEqual(grouped);
  });
  it("Web 端剔除 remote.open", () => {
    const web = buildSettingsCategories(false, false);
    const all = web.find((c) => c.id === "shortcuts")!.shortcutGroups!.flatMap((g) => g.actions);
    expect(all).not.toContain("remote.open");
  });
});

describe("filterSettings", () => {
  it("空 query 返回全部分类全部条目", () => {
    const all = filterSettings("", CATS);
    expect(all.map((c) => c.id)).toEqual(CATS.map((c) => c.id));
    expect(all.find((c) => c.id === "shortcuts")!.shortcutGroups.length).toBe(5);
  });
  it("条目 label 命中：只留命中分类与条目", () => {
    const out = filterSettings("缩放", CATS); // 仅 font-size 的 keywords 有「缩放」
    expect(out.map((c) => c.id)).toEqual(["appearance"]);
    expect(out[0].items.map((i) => i.id)).toEqual(["appearance.font-size"]);
  });
  it("keywords 命中（英文别名）", () => {
    const out = filterSettings("zoom", CATS);
    expect(out.find((c) => c.id === "appearance")!.items.map((i) => i.id)).toContain("appearance.font-size");
  });
  it("description 命中", () => {
    const out = filterSettings("telnet", CATS);
    expect(out.map((c) => c.id)).toEqual(["connection"]);
    expect(out[0].items.map((i) => i.id)).toEqual(["srv.telnet_port"]);
  });
  it("分类级命中（分类名/关键词）→ 整类全量", () => {
    const out = filterSettings("皮肤", CATS); // appearance 的分类关键词
    expect(out.find((c) => c.id === "appearance")!.items.length).toBe(2);
  });
  it("快捷键按动作 label 过滤，空分组剔除", () => {
    const out = filterSettings("刷新端口", CATS);
    const shortcuts = out.find((c) => c.id === "shortcuts")!;
    expect(shortcuts.shortcutGroups).toEqual([{ title: "端口与设备", actions: ["port.refresh"] }]);
  });
  it("快捷键分组标题命中 → 组内全量", () => {
    const out = filterSettings("标签页", CATS);
    const shortcuts = out.find((c) => c.id === "shortcuts")!;
    expect(shortcuts.shortcutGroups!.find((g) => g.title === "标签页")!.actions).toEqual([
      "tab.next", "tab.prev", "tab.select",
    ]);
  });
  it("大小写不敏感", () => {
    expect(filterSettings("THEME", CATS).find((c) => c.id === "appearance")).toBeTruthy();
  });
  it("无命中返回空数组", () => {
    expect(filterSettings("不存在的设置xyz", CATS)).toEqual([]);
  });
});

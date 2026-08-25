import { describe, expect, it } from "vitest";
import {
  dissolveGroup,
  displayPortName,
  groupBy,
  paramDefault,
  parseParamsFromCode,
  parsePortId,
  portIdOf,
  prefillRunValues,
  renameGroup,
  upsertNamed,
  wireToPid,
} from "./lib";
import type { ScriptParam } from "./types";

describe("portIdOf / parsePortId", () => {
  it("往返一致", () => {
    expect(parsePortId(portIdOf("local", "COM3"))).toEqual({ devId: "local", name: "COM3" });
    expect(parsePortId(portIdOf("uuid-1", "/dev/ttyUSB0"))).toEqual({
      devId: "uuid-1",
      name: "/dev/ttyUSB0",
    });
  });

  it("无分隔符 = 本机裸端口名(规范形态)", () => {
    expect(parsePortId("COM3")).toEqual({ devId: "local", name: "COM3" });
  });

  it("仅按首个 :: 切分", () => {
    expect(parsePortId("a::b::c")).toEqual({ devId: "a", name: "b::c" });
  });
});

describe("wireToPid(线名→pid)/ displayPortName(pid→展示名)", () => {
  it("本地 transport 线名即本机视角键,直通(本地口=裸名)", () => {
    expect(wireToPid("local", "COM3")).toBe("COM3");
    // 遗留 local:: 线名(理论上不再出现)也原样直通——归一责任在后端
    expect(wireToPid("local", "local::COM3")).toBe("local::COM3");
  });

  it("远程线名加设备前缀:远端侧键为裸名或其级联键 → 单级/两级", () => {
    expect(wireToPid("uuidA", "COM3")).toBe("uuidA::COM3");
    expect(wireToPid("uuidA", "uuidB::COM9")).toBe("uuidA::uuidB::COM9");
  });

  it("展示名取最后一个 :: 之后(级联也只显示串口名)", () => {
    expect(displayPortName("uuidA::COM3")).toBe("COM3");
    expect(displayPortName("uuidA::uuidB::COM3")).toBe("COM3");
    expect(displayPortName("COM3")).toBe("COM3");
  });
});

describe("groupBy", () => {
  const items: [string, { group?: string }][] = [
    ["b", { group: "G2" }],
    ["a", { group: "G1" }],
    ["d", {}],
    ["c", { group: "G2" }],
    ["e", { group: "未分组" }],
  ];

  it("具名组字典序在前，未分组殿后", () => {
    const gs = groupBy(items, (x) => x.group);
    expect(gs.map((g) => g.name)).toEqual(["G1", "G2", "未分组"]);
    expect(gs[0].items.map(([k]) => k)).toEqual(["a"]);
    expect(gs[1].items.map(([k]) => k)).toEqual(["b", "c"]);
  });

  it("无组项与名为「未分组」的项并入同一合成组（防 key 碰撞）", () => {
    const gs = groupBy(items, (x) => x.group);
    const un = gs.find((g) => g.name === "未分组")!;
    expect(un.items.map(([k]) => k)).toEqual(["d", "e"]);
    // 只有一条「未分组」
    expect(gs.filter((g) => g.name === "未分组").length).toBe(1);
  });

  it("全有组时不合成未分组", () => {
    const gs = groupBy([["a", { group: "G" }]] as [string, { group?: string }][], (x) => x.group);
    expect(gs.map((g) => g.name)).toEqual(["G"]);
  });
});

describe("upsertNamed", () => {
  it("新增", () => {
    const next = upsertNamed({ a: { group: "1" } }, null, "b", { group: "2" });
    expect(Object.keys(next!)).toEqual(["a", "b"]);
  });

  it("真重命名：删旧 key，不残留", () => {
    const next = upsertNamed({ a: {}, b: {} }, "a", "c", {});
    expect(Object.keys(next!)).toEqual(["b", "c"]);
  });

  it("同名覆盖自身：旧 key 保留", () => {
    const next = upsertNamed({ a: { group: "old" } }, "a", "a", { group: "new" });
    expect(next).toEqual({ a: { group: "new" } });
  });

  it("撞名（非自身）→ null", () => {
    expect(upsertNamed({ a: {} }, null, "a", {})).toBeNull();
  });

  it("空名 → null；名字两端空白被 trim", () => {
    expect(upsertNamed({}, null, "  ", {})).toBeNull();
    const next = upsertNamed({}, null, " x ", {});
    expect(Object.keys(next!)).toEqual(["x"]);
  });
});

describe("renameGroup / dissolveGroup", () => {
  const rec = { a: { group: "G1" }, b: { group: "G1" }, c: { group: "G2" }, d: {} };

  it("重命名 = 批量改成员字段；空名原样返回", () => {
    const next = renameGroup(rec, "G1", "New");
    expect(next.a).toEqual({ group: "New" });
    expect(next.b).toEqual({ group: "New" });
    expect(next.c).toEqual({ group: "G2" }); // 其他组不动
    expect(renameGroup(rec, "G1", "  ")).toBe(rec);
  });

  it("解散：成员 group 置 undefined，返回受影响数", () => {
    const { next, count } = dissolveGroup(rec, "G1");
    expect(count).toBe(2);
    expect(next.a).toEqual({ group: undefined });
    expect("group" in next.a).toBe(true); // 字段仍在（值为 undefined）
    expect(next.c).toEqual({ group: "G2" });
    expect(next.d).toEqual({});
  });
});

describe("parseParamsFromCode", () => {
  it("string 参数带 default", () => {
    const code = "// @param host string default=192.168.1.1\nsend('AT');";
    expect(parseParamsFromCode(code)).toEqual([
      { name: "host", type: "string", default: "192.168.1.1" },
    ]);
  });

  it("select 参数解析 options（含方括号容错）", () => {
    const code = "// @param mode select [fast|slow] default=fast";
    expect(parseParamsFromCode(code)).toEqual([
      { name: "mode", type: "select", default: "fast", options: ["fast", "slow"] },
    ]);
  });

  it("无 @param 行 → null（调用方据此不覆盖现有 params）", () => {
    expect(parseParamsFromCode("// 普通\n注释")).toBeNull();
  });

  it("格式不匹配的行被忽略", () => {
    const code = "// @param foo\n// @param bar number 42";
    expect(parseParamsFromCode(code)).toBeNull();
  });

  it("多行混合", () => {
    const code = [
      "// @param a string default=1",
      "log('hi')",
      "  // @param b select x|y",
    ].join("\n");
    expect(parseParamsFromCode(code)).toEqual([
      { name: "a", type: "string", default: "1" },
      { name: "b", type: "select", options: ["x", "y"] },
    ]);
  });
});

describe("paramDefault / prefillRunValues", () => {
  const str: ScriptParam = { name: "host", type: "string", default: "192.168.1.1" };
  const sel: ScriptParam = { name: "mode", type: "select", options: ["fast", "slow"], default: "fast" };
  const params: ScriptParam[] = [str, sel];

  it("paramDefault：string 取 default；select 取 options 内 default，否则首个非空 option", () => {
    expect(paramDefault(str)).toBe("192.168.1.1");
    expect(paramDefault(sel)).toBe("fast");
    // default 已不在 options（脚本被编辑过）→ 首个 option，防下拉悬空
    expect(paramDefault({ name: "m", type: "select", options: ["a", "b"], default: "gone" })).toBe("a");
    expect(paramDefault({ name: "n", type: "string" })).toBe("");
  });

  it("无缓存 → 全部声明默认", () => {
    expect(prefillRunValues(params, undefined)).toEqual({ host: "192.168.1.1", mode: "fast" });
    expect(prefillRunValues(params, {})).toEqual({ host: "192.168.1.1", mode: "fast" });
  });

  it("缓存命中优先于声明默认（按需微调语义，含作者后来改 default）", () => {
    expect(prefillRunValues(params, { host: "10.0.0.8", mode: "slow" })).toEqual({
      host: "10.0.0.8",
      mode: "slow",
    });
  });

  it("缓存部分命中：未命中的参数回落默认", () => {
    expect(prefillRunValues(params, { mode: "slow" })).toEqual({ host: "192.168.1.1", mode: "slow" });
  });

  it("select 缓存值已不在 options → 回落默认；string 空串缓存保留（上次显式清空）", () => {
    expect(prefillRunValues(params, { mode: "turbo" })).toEqual({ host: "192.168.1.1", mode: "fast" });
    expect(prefillRunValues(params, { host: "" })).toEqual({ host: "", mode: "fast" });
  });

  it("缓存中多余的参数键（脚本已删该参数）被忽略", () => {
    expect(prefillRunValues(params, { host: "h", mode: "slow", legacy: "x" })).toEqual({
      host: "h",
      mode: "slow",
    });
  });
});

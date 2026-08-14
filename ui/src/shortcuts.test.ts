import { afterEach, describe, expect, it, vi } from "vitest";
import { comboToAccelerator, eventToCombo, findAction, formatCombo } from "./shortcuts";

/** 造最小 KeyboardEvent 形状（node 环境无 DOM，eventToCombo 只读这五个字段）。 */
function ev(key: string, opts: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }) {
  return {
    key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    altKey: !!opts.alt,
    shiftKey: !!opts.shift,
  } as KeyboardEvent;
}

describe("findAction", () => {
  it("精确等值命中（默认绑定）", () => {
    expect(findAction("mod+shift+f")).toEqual({ id: "search.open" });
    expect(findAction("mod+alt+w")).toEqual({ id: "port.close-active" });
  });

  it("无命中返回 null", () => {
    expect(findAction("mod+shift+z")).toBeNull();
    expect(findAction("")).toBeNull();
  });

  it("scope 过滤：terminal 作用域不进 global 查询", () => {
    expect(findAction("mod+=", "global")).toBeNull();
    expect(findAction("mod+=", "terminal")).toEqual({ id: "zoom.in" });
  });

  it("参数化绑定：pattern 捕获组作 arg", () => {
    expect(findAction("mod+alt+3")).toEqual({ id: "tab.select", arg: "3" });
    expect(findAction("mod+alt+0")).toEqual({ id: "tab.select", arg: "0" });
    // 双位数不在族内（仅单数字 0-9）
    expect(findAction("mod+alt+12")).toBeNull();
  });

  it("精确命中优先于 pattern", () => {
    // tab.next 的精确 combo 恰好是普通键，不被 tab.select 的 pattern 吃掉
    expect(findAction("mod+alt+arrowright")).toEqual({ id: "tab.next" });
  });
});

describe("eventToCombo", () => {
  it("ctrl/meta 归一为 mod（跨平台主修饰符）", () => {
    expect(eventToCombo(ev("f", { ctrl: true, shift: true }))).toBe("mod+shift+f");
    expect(eventToCombo(ev("f", { meta: true, shift: true }))).toBe("mod+shift+f");
  });

  it("修饰符顺序固定：mod → alt → shift → 主键", () => {
    expect(eventToCombo(ev("x", { ctrl: true, alt: true, shift: true }))).toBe("mod+alt+shift+x");
  });

  it("空格主键序列化为 space", () => {
    expect(eventToCombo(ev(" ", { ctrl: true }))).toBe("mod+space");
  });

  it("纯修饰符按键（组合进行中）返回空串", () => {
    expect(eventToCombo(ev("Control", { ctrl: true }))).toBe("");
    expect(eventToCombo(ev("Shift", { shift: true }))).toBe("");
  });

  it("主键小写化", () => {
    expect(eventToCombo(ev("F", { shift: true }))).toBe("shift+f");
  });
});

describe("comboToAccelerator", () => {
  it("mod → CmdOrCtrl；单字符大写", () => {
    expect(comboToAccelerator("mod+shift+f")).toBe("CmdOrCtrl+Shift+F");
  });

  it("空 combo → null（无 accelerator）", () => {
    expect(comboToAccelerator("")).toBeNull();
  });

  it("特殊符号键映射；多字符键保持小写（仅单字符大写）", () => {
    expect(comboToAccelerator("mod+=")).toBe("CmdOrCtrl+Equal");
    expect(comboToAccelerator("mod+-")).toBe("CmdOrCtrl+Minus");
    expect(comboToAccelerator("mod+alt+arrowright")).toBe("CmdOrCtrl+Alt+arrowright");
  });
});

describe("formatCombo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非 Mac：Ctrl+… 加号连接，单字符大写（stub 平台，防 macOS 开发机误挂）", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(formatCombo("mod+shift+f")).toBe("Ctrl+Shift+F");
    expect(formatCombo("mod+-")).toBe("Ctrl+-");
    expect(formatCombo("")).toBe("—");
  });
});

import { describe, expect, it } from "vitest";
import { leafGroupIds } from "./pane-tree";
import { initialSession, sessionReducer, type SessionState } from "./store";
import { portIdOf } from "./lib";
import type { SerialConfig } from "./types";

const CFG: SerialConfig = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "lf",
};

/** 开两个端口（都进焦点 g1，活动端口为后开者）。 */
function withPorts(...pids: string[]): SessionState {
  let s = initialSession;
  for (const pid of pids) s = sessionReducer(s, { type: "port_acquired", pid, config: CFG });
  return s;
}

describe("port_acquired", () => {
  it("记录配置、追加 openPorts、进焦点 group 并设为活动端口", () => {
    const cfg = { baud_rate: 9600, data_bits: "eight", stop_bits: "one", parity: "none", flow_control: "none", line_ending: "lf" };
    const s = sessionReducer(initialSession, { type: "port_acquired", pid: "local::COM3", config: cfg });
    expect(s.openPorts).toEqual(["local::COM3"]);
    expect(s.portConfigs["local::COM3"]).toEqual(cfg);
    expect(s.groups.g1.ports).toEqual(["local::COM3"]);
    expect(s.groups.g1.activePort).toBe("local::COM3");
  });

  it("重复 acquire 同端口去重", () => {
    const s1 = withPorts("local::COM3");
    const s2 = sessionReducer(s1, { type: "port_acquired", pid: "local::COM3", config: CFG });
    expect(s2.openPorts.length).toBe(1);
    expect(s2.groups.g1.ports.length).toBe(1);
  });

  it("acquire 成功清除断开标记（重连路径）", () => {
    let s = withPorts("local::COM3");
    s = sessionReducer(s, { type: "port_disconnected_evt", devId: "local", port: "COM3" });
    expect(s.disconnectedPorts.has("local::COM3")).toBe(true);
    s = sessionReducer(s, { type: "port_acquired", pid: "local::COM3", config: CFG });
    expect(s.disconnectedPorts.has("local::COM3")).toBe(false);
  });

  it("已在某 group 的端口再 acquire（重连重放）不重复进焦点 group——INV-1", () => {
    let s = withPorts("local::COM3", "local::COM4");
    // 把 COM3 拖去新 group g2，焦点回 g1（COM3 不在焦点 group）
    s = sessionReducer(s, { type: "drop_half", port: "local::COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "set_focused_group", groupId: "g1" });
    expect(s.groups.g2.ports).toEqual(["local::COM3"]);
    // 重连重放 COM3（已在 g2）：不得被追加进焦点 g1，否则同端口出现在两个 group
    s = sessionReducer(s, { type: "port_acquired", pid: "local::COM3", config: CFG });
    expect(s.groups.g1.ports).toEqual(["local::COM4"]);
    expect(s.groups.g2.ports).toEqual(["local::COM3"]);
  });
});

describe("prune_port —— 关端口共用路径", () => {
  it("关非末个 tab：group 保留，activePort 回退", () => {
    let s = withPorts("local::COM3", "local::COM4");
    s = sessionReducer(s, { type: "prune_port", pid: "local::COM4" });
    expect(s.openPorts).toEqual(["local::COM3"]);
    expect(s.groups.g1.ports).toEqual(["local::COM3"]);
    expect(s.groups.g1.activePort).toBe("local::COM3");
    expect("local::COM4" in s.portConfigs).toBe(false);
  });

  it("唯一 group 的末个 tab：group 保留为空（承接下次打开）", () => {
    let s = withPorts("local::COM3");
    s = sessionReducer(s, { type: "prune_port", pid: "local::COM3" });
    expect(s.groups.g1.ports).toEqual([]);
    expect(s.layout).toEqual({ type: "leaf", groupId: "g1" });
    expect(s.focusedGroupId).toBe("g1");
  });

  it("多 group 时关空某 group：group 删除 + layout 坍缩 + 焦点自愈", () => {
    let s = withPorts("local::COM3", "local::COM4");
    // 拖 COM4 到 g1 右半区 → 新 group g2
    s = sessionReducer(s, { type: "drop_half", port: "local::COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(leafGroupIds(s.layout)).toEqual(["g1", "g2"]);
    expect(s.focusedGroupId).toBe("g2");
    // 关掉 g2 的唯一 tab → g2 坍缩删除，焦点自愈回 g1
    s = sessionReducer(s, { type: "prune_port", pid: "local::COM4" });
    expect(s.groups.g1).toBeDefined();
    expect(s.groups.g2).toBeUndefined();
    expect(leafGroupIds(s.layout)).toEqual(["g1"]);
    expect(s.focusedGroupId).toBe("g1");
  });
});

describe("dev_online", () => {
  it("断连：本设备开着的端口标记待重连 + 列表 opened 置 false", () => {
    let s = withPorts("local::COM3", "dev1::COM3");
    s = sessionReducer(s, {
      type: "ports_listed",
      devId: "dev1",
      ports: [{ name: "COM3", opened: true, holders: 1 }],
    });
    s = sessionReducer(s, { type: "dev_online", devId: "dev1", online: false });
    expect(s.devOnline.dev1).toBe(false);
    expect(s.disconnectedPorts.has("dev1::COM3")).toBe(true);
    expect(s.disconnectedPorts.has("local::COM3")).toBe(false); // 别的设备不受影响
    expect(s.portsByDev.dev1[0].opened).toBe(false);
  });

  it("重连成功后 port_opened_evt 清断开标记", () => {
    let s = withPorts("dev1::COM3");
    s = sessionReducer(s, { type: "dev_online", devId: "dev1", online: false });
    s = sessionReducer(s, { type: "dev_online", devId: "dev1", online: true });
    expect(s.devOnline.dev1).toBe(true);
    expect(s.disconnectedPorts.has("dev1::COM3")).toBe(true); // 标记仍在，等端口级事件/acquire 清
    s = sessionReducer(s, { type: "port_opened_evt", devId: "dev1", port: "COM3" });
    expect(s.disconnectedPorts.has("dev1::COM3")).toBe(false);
  });
});

describe("drop_half / move_port", () => {
  it("拖到另一 group 半区：新建 group + 分裂 + 焦点转移", () => {
    let s = withPorts("local::COM3", "local::COM4");
    s = sessionReducer(s, { type: "drop_half", port: "local::COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(leafGroupIds(s.layout)).toEqual(["g1", "g2"]);
    expect(s.groups.g1.ports).toEqual(["local::COM3"]);
    expect(s.groups.g2.ports).toEqual(["local::COM4"]);
    expect(s.focusedGroupId).toBe("g2");
  });

  it("拖自己唯一 tab 到自己半区：no-op", () => {
    let s = withPorts("local::COM3");
    const s2 = sessionReducer(s, { type: "drop_half", port: "local::COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(s2).toBe(s);
  });

  it("落到空 group：直接搬，不分裂", () => {
    let s = withPorts("local::COM3", "local::COM4");
    s = sessionReducer(s, { type: "drop_half", port: "local::COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    // g2 现有 COM4；把 COM3 拖到 g2 的标签栏（move_port）
    s = sessionReducer(s, { type: "move_port", port: "local::COM3", srcGroupId: "g1", dstGroupId: "g2" });
    expect(s.groups.g1).toBeUndefined(); // 源空 → 删除
    expect(leafGroupIds(s.layout)).toEqual(["g2"]);
    expect(s.groups.g2.ports).toEqual(["local::COM4", "local::COM3"]);
    expect(s.focusedGroupId).toBe("g2");
  });

  it("group id 序号递增（drop 两次得到 g2、g3）", () => {
    let s = withPorts("local::COM1", "local::COM2", "local::COM3");
    s = sessionReducer(s, { type: "drop_half", port: "local::COM2", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "drop_half", port: "local::COM3", srcGroupId: "g1", dstGroupId: "g1", half: "down" });
    expect(Object.keys(s.groups).sort()).toEqual(["g1", "g2", "g3"]);
  });
});

describe("switch_tab / set_focused_group", () => {
  it("切换活动端口并聚焦 group", () => {
    let s = withPorts("local::COM3", "local::COM4");
    s = sessionReducer(s, { type: "switch_tab", groupId: "g1", port: "local::COM3" });
    expect(s.groups.g1.activePort).toBe("local::COM3");
    // 切到不在 group 内的端口：no-op
    const s2 = sessionReducer(s, { type: "switch_tab", groupId: "g1", port: "local::COM9" });
    expect(s2).toBe(s);
  });

  it("activePort 未变仍聚焦该 group（侧栏/串口面板触发已开端口的跳转路径）", () => {
    let s = withPorts("local::COM3", "local::COM4");
    // COM3 拖去 g2，焦点回 g1（g2 的 activePort 仍是 COM3）
    s = sessionReducer(s, { type: "drop_half", port: "local::COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "set_focused_group", groupId: "g1" });
    // 侧栏点 COM3（已是 g2 的 activePort）：activePort 不变，但焦点必须切到 g2
    s = sessionReducer(s, { type: "switch_tab", groupId: "g2", port: "local::COM3" });
    expect(s.focusedGroupId).toBe("g2");
    expect(s.groups.g2.activePort).toBe("local::COM3");
  });
});

describe("portIdOf 复合键一致性", () => {
  it("store 组 key 与 lib 编解码一致", () => {
    expect(portIdOf("local", "COM3")).toBe("local::COM3");
  });
});

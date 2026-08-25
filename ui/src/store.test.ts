import { describe, expect, it } from "vitest";
import { leafGroupIds } from "./pane-tree";
import { initialSession, sessionReducer, type SessionState } from "./store";
import { parsePortId, portIdOf } from "./lib";
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
    const s = sessionReducer(initialSession, { type: "port_acquired", pid: "COM3", config: cfg });
    expect(s.openPorts).toEqual(["COM3"]);
    expect(s.portConfigs["COM3"]).toEqual(cfg);
    expect(s.groups.g1.ports).toEqual(["COM3"]);
    expect(s.groups.g1.activePort).toBe("COM3");
  });

  it("重复 acquire 同端口去重", () => {
    const s1 = withPorts("COM3");
    const s2 = sessionReducer(s1, { type: "port_acquired", pid: "COM3", config: CFG });
    expect(s2.openPorts.length).toBe(1);
    expect(s2.groups.g1.ports.length).toBe(1);
  });

  it("acquire 成功清除断开标记（重连路径）", () => {
    let s = withPorts("COM3");
    // 本地 transport 的线名已是复合键(pid ≡ 线名,wireToPid 直通)
    s = sessionReducer(s, { type: "port_disconnected_evt", devId: "local", port: "COM3" });
    expect(s.disconnectedPorts.has("COM3")).toBe(true);
    s = sessionReducer(s, { type: "port_acquired", pid: "COM3", config: CFG });
    expect(s.disconnectedPorts.has("COM3")).toBe(false);
  });

  it("port_disconnected_evt:远程线名加设备前缀(线名=远端侧键)", () => {
    let s = withPorts("uuidA::COM3", "uuidA::uuidB::COM9");
    // 远程线名是远端侧键(裸名或其级联键),wireToPid 只加一段设备前缀产出本机 pid
    s = sessionReducer(s, { type: "port_disconnected_evt", devId: "uuidA", port: "COM3" });
    expect(s.disconnectedPorts.has("uuidA::COM3")).toBe(true);
    s = sessionReducer(s, { type: "port_disconnected_evt", devId: "uuidA", port: "uuidB::COM9" });
    expect(s.disconnectedPorts.has("uuidA::uuidB::COM9")).toBe(true);
  });

  it("已在某 group 的端口再 acquire（重连重放）不重复进焦点 group——INV-1", () => {
    let s = withPorts("COM3", "COM4");
    // 把 COM3 拖去新 group g2，焦点回 g1（COM3 不在焦点 group）
    s = sessionReducer(s, { type: "drop_half", port: "COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "set_focused_group", groupId: "g1" });
    expect(s.groups.g2.ports).toEqual(["COM3"]);
    // 重连重放 COM3（已在 g2）：不得被追加进焦点 g1，否则同端口出现在两个 group
    s = sessionReducer(s, { type: "port_acquired", pid: "COM3", config: CFG });
    expect(s.groups.g1.ports).toEqual(["COM4"]);
    expect(s.groups.g2.ports).toEqual(["COM3"]);
  });
});

describe("prune_port —— 关端口共用路径", () => {
  it("关非末个 tab：group 保留，activePort 回退", () => {
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "prune_port", pid: "COM4" });
    expect(s.openPorts).toEqual(["COM3"]);
    expect(s.groups.g1.ports).toEqual(["COM3"]);
    expect(s.groups.g1.activePort).toBe("COM3");
    expect("COM4" in s.portConfigs).toBe(false);
  });

  it("唯一 group 的末个 tab：group 保留为空（承接下次打开）", () => {
    let s = withPorts("COM3");
    s = sessionReducer(s, { type: "prune_port", pid: "COM3" });
    expect(s.groups.g1.ports).toEqual([]);
    expect(s.layout).toEqual({ type: "leaf", groupId: "g1" });
    expect(s.focusedGroupId).toBe("g1");
  });

  it("多 group 时关空某 group：group 删除 + layout 坍缩 + 焦点自愈", () => {
    let s = withPorts("COM3", "COM4");
    // 拖 COM4 到 g1 右半区 → 新 group g2
    s = sessionReducer(s, { type: "drop_half", port: "COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(leafGroupIds(s.layout)).toEqual(["g1", "g2"]);
    expect(s.focusedGroupId).toBe("g2");
    // 关掉 g2 的唯一 tab → g2 坍缩删除，焦点自愈回 g1
    s = sessionReducer(s, { type: "prune_port", pid: "COM4" });
    expect(s.groups.g1).toBeDefined();
    expect(s.groups.g2).toBeUndefined();
    expect(leafGroupIds(s.layout)).toEqual(["g1"]);
    expect(s.focusedGroupId).toBe("g1");
  });
});

describe("dev_online", () => {
  it("断连：本设备开着的端口标记待重连 + 列表 opened 置 false", () => {
    let s = withPorts("COM3", "dev1::COM3");
    s = sessionReducer(s, {
      type: "ports_listed",
      devId: "dev1",
      ports: [{ name: "COM3", opened: true, holders: 1 }],
    });
    s = sessionReducer(s, { type: "dev_online", devId: "dev1", online: false });
    expect(s.devOnline.dev1).toBe(false);
    expect(s.disconnectedPorts.has("dev1::COM3")).toBe(true);
    expect(s.disconnectedPorts.has("COM3")).toBe(false); // 别的设备不受影响
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
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "drop_half", port: "COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(leafGroupIds(s.layout)).toEqual(["g1", "g2"]);
    expect(s.groups.g1.ports).toEqual(["COM3"]);
    expect(s.groups.g2.ports).toEqual(["COM4"]);
    expect(s.focusedGroupId).toBe("g2");
  });

  it("拖自己唯一 tab 到自己半区：no-op", () => {
    let s = withPorts("COM3");
    const s2 = sessionReducer(s, { type: "drop_half", port: "COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    expect(s2).toBe(s);
  });

  it("落到空 group：直接搬，不分裂", () => {
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "drop_half", port: "COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    // g2 现有 COM4；把 COM3 拖到 g2 的标签栏（move_port）
    s = sessionReducer(s, { type: "move_port", port: "COM3", srcGroupId: "g1", dstGroupId: "g2" });
    expect(s.groups.g1).toBeUndefined(); // 源空 → 删除
    expect(leafGroupIds(s.layout)).toEqual(["g2"]);
    expect(s.groups.g2.ports).toEqual(["COM4", "COM3"]);
    expect(s.focusedGroupId).toBe("g2");
  });

  it("group id 序号递增（drop 两次得到 g2、g3）", () => {
    let s = withPorts("COM1", "COM2", "COM3");
    s = sessionReducer(s, { type: "drop_half", port: "COM2", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "drop_half", port: "COM3", srcGroupId: "g1", dstGroupId: "g1", half: "down" });
    expect(Object.keys(s.groups).sort()).toEqual(["g1", "g2", "g3"]);
  });
});

describe("set_split_ratio", () => {
  it("改根 split 比例并 clamp 到 0.15–0.85", () => {
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "drop_half", port: "COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "set_split_ratio", path: [], ratio: 0.7 });
    expect(s.layout).toMatchObject({ type: "split", ratio: 0.7 });
    s = sessionReducer(s, { type: "set_split_ratio", path: [], ratio: 0.05 });
    expect(s.layout).toMatchObject({ ratio: 0.15 });
    s = sessionReducer(s, { type: "set_split_ratio", path: [], ratio: 2 });
    expect(s.layout).toMatchObject({ ratio: 0.85 });
  });

  it("沿 path 改嵌套 split,不影响兄弟", () => {
    let s = withPorts("COM1", "COM2", "COM3");
    s = sessionReducer(s, { type: "drop_half", port: "COM2", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "drop_half", port: "COM3", srcGroupId: "g1", dstGroupId: "g1", half: "down" });
    // 第二次 drop 在 g1 下分裂 → 嵌套 split 在 path [0]
    const root = s.layout as { type: "split"; ratio: number; children: [{ type: string; ratio: number }, unknown] };
    s = sessionReducer(s, { type: "set_split_ratio", path: [0], ratio: 0.6 });
    const next = s.layout as typeof root;
    expect(next.ratio).toBe(root.ratio); // 根不动
    expect(next.children[0]).toMatchObject({ type: "split", ratio: 0.6 });
  });

  it("ratio 不变时引用不变（no-op 短路）", () => {
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "drop_half", port: "COM4", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    const s2 = sessionReducer(s, { type: "set_split_ratio", path: [], ratio: 0.5 });
    expect(s2).toBe(s);
  });
});

describe("switch_tab / set_focused_group", () => {
  it("切换活动端口并聚焦 group", () => {
    let s = withPorts("COM3", "COM4");
    s = sessionReducer(s, { type: "switch_tab", groupId: "g1", port: "COM3" });
    expect(s.groups.g1.activePort).toBe("COM3");
    // 切到不在 group 内的端口：no-op
    const s2 = sessionReducer(s, { type: "switch_tab", groupId: "g1", port: "COM9" });
    expect(s2).toBe(s);
  });

  it("activePort 未变仍聚焦该 group（侧栏/串口面板触发已开端口的跳转路径）", () => {
    let s = withPorts("COM3", "COM4");
    // COM3 拖去 g2，焦点回 g1（g2 的 activePort 仍是 COM3）
    s = sessionReducer(s, { type: "drop_half", port: "COM3", srcGroupId: "g1", dstGroupId: "g1", half: "right" });
    s = sessionReducer(s, { type: "set_focused_group", groupId: "g1" });
    // 侧栏点 COM3（已是 g2 的 activePort）：activePort 不变，但焦点必须切到 g2
    s = sessionReducer(s, { type: "switch_tab", groupId: "g2", port: "COM3" });
    expect(s.focusedGroupId).toBe("g2");
    expect(s.groups.g2.activePort).toBe("COM3");
  });
});

describe("portIdOf 复合键一致性", () => {
  it("store 组 key 与 lib 编解码一致(本地=裸名,远端=compose)", () => {
    // 本地口 pid 即裸名;parsePortId 对裸名返回 devId "local"(语义标记)
    expect(parsePortId("COM3")).toEqual({ devId: "local", name: "COM3" });
    // 远端口 compose 后 roundtrip
    expect(parsePortId(portIdOf("uuidA", "COM3"))).toEqual({
      devId: "uuidA",
      name: "COM3",
    });
  });
});

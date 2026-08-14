import { describe, expect, it } from "vitest";
import { createRoot, findLeaf, leafGroupIds, removeLeaf, splitLeaf } from "./pane-tree";

/** 造一棵两层的树：((g1 | g2) — g3) */
function sampleTree() {
  let t = createRoot("g1");
  t = splitLeaf(t, "g1", { type: "leaf", groupId: "g2" }, "row", "end");
  t = splitLeaf(t, "g1", { type: "leaf", groupId: "g3" }, "col", "start");
  return t;
}

describe("createRoot / leafGroupIds / findLeaf", () => {
  it("单叶根", () => {
    const t = createRoot("g1");
    expect(leafGroupIds(t)).toEqual(["g1"]);
    expect(findLeaf(t, "g1")).toEqual({ type: "leaf", groupId: "g1" });
    expect(findLeaf(t, "g9")).toBeNull();
  });

  it("深度优先收集叶子", () => {
    expect(leafGroupIds(sampleTree())).toEqual(["g3", "g1", "g2"]);
  });
});

describe("splitLeaf", () => {
  it("side=end：新叶在后", () => {
    const t = splitLeaf(createRoot("g1"), "g1", { type: "leaf", groupId: "g2" }, "row", "end");
    expect(t).toEqual({
      type: "split",
      dir: "row",
      ratio: 0.5,
      children: [{ type: "leaf", groupId: "g1" }, { type: "leaf", groupId: "g2" }],
    });
  });

  it("side=start：新叶在前", () => {
    const t = splitLeaf(createRoot("g1"), "g1", { type: "leaf", groupId: "g2" }, "col", "start");
    expect(t).toEqual({
      type: "split",
      dir: "col",
      ratio: 0.5,
      children: [{ type: "leaf", groupId: "g2" }, { type: "leaf", groupId: "g1" }],
    });
  });

  it("target 不存在：树结构不变（split 节点会重建对象，但值相等）", () => {
    const t = createRoot("g1");
    const t2 = splitLeaf(t, "g1", { type: "leaf", groupId: "g2" }, "row", "end");
    expect(splitLeaf(t2, "g9", { type: "leaf", groupId: "g3" }, "row", "end")).toEqual(t2);
    // 原树未被修改
    expect(t).toEqual({ type: "leaf", groupId: "g1" });
  });

  it("嵌套分裂只改含 target 的路径", () => {
    // 样例树根是 row（第一次分裂），col 分裂嵌套在 g1 处：split(row, [split(col,[g3,g1]), g2])
    const t = sampleTree();
    const t2 = splitLeaf(t, "g2", { type: "leaf", groupId: "g4" }, "row", "end");
    if (t2.type !== "split") throw new Error("根应为 split");
    expect(t2.dir).toBe("row");
    expect(leafGroupIds(t2)).toEqual(["g3", "g1", "g2", "g4"]);
  });
});

describe("removeLeaf —— 坍缩语义", () => {
  it("删非亲兄弟叶：另一半 split 顶上", () => {
    // 树 ((g1 | g2) — g3)，删 g3 → 剩 g1 | g2
    const t = removeLeaf(sampleTree(), "g3");
    expect(t).toEqual({
      type: "split",
      dir: "row",
      ratio: 0.5,
      children: [{ type: "leaf", groupId: "g1" }, { type: "leaf", groupId: "g2" }],
    });
  });

  it("删亲兄弟之一：父 split 坍缩为另一子（提升给祖父）", () => {
    // 树 ((g1 | g2) — g3)，删 g2 → g3 | g1
    const t = removeLeaf(sampleTree(), "g2");
    expect(t).toEqual({
      type: "split",
      dir: "col",
      ratio: 0.5,
      children: [{ type: "leaf", groupId: "g3" }, { type: "leaf", groupId: "g1" }],
    });
  });

  it("删到只剩一个叶子：返回该叶子", () => {
    const t = removeLeaf(sampleTree(), "g2");
    const t2 = removeLeaf(t!, "g3");
    expect(t2).toEqual({ type: "leaf", groupId: "g1" });
  });

  it("删根叶：返回 null", () => {
    expect(removeLeaf(createRoot("g1"), "g1")).toBeNull();
  });

  it("target 不存在：树结构不变（对象可能重建，值相等）", () => {
    const t = sampleTree();
    expect(removeLeaf(t, "g9")).toEqual(t);
  });
});

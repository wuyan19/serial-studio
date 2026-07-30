/** 布局树纯函数（无 React、无副作用，可单测）。
 *  叶子 = 一个 group；分裂 = 两子树 + 比例。
 *  坍缩语义（VS Code 风格）：删某叶子后，父 split 只剩一子 → 用该子替换父节点（提升给祖父）。 */
import type { PaneDir, PaneNode } from "./types";

/** 单 group 根布局。 */
export function createRoot(groupId: string): PaneNode {
  return { type: "leaf", groupId };
}

/** 树中所有叶子的 groupId（左深度优先）。用于校验 layout 叶子集 == groups id 集（INV-3）。 */
export function leafGroupIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...leafGroupIds(node.children[0]), ...leafGroupIds(node.children[1])];
}

/** 找含 groupId 的叶子节点（null = 不存在）。 */
export function findLeaf(node: PaneNode, groupId: string): PaneNode | null {
  if (node.type === "leaf") return node.groupId === groupId ? node : null;
  return findLeaf(node.children[0], groupId) || findLeaf(node.children[1], groupId);
}

/** 在含 targetGroupId 的叶子处分裂，植入 newLeaf，按 dir/side 组成 split。返回新树（不可变，原树不动）。
 *  side="start" → newLeaf 放主方向起始（左/上）；"end" → 放结束（右/下）。ratio 默认 0.5（均分）。
 *  例：target 在右、新格在左 → splitLeaf(tree, gid, newLeaf, "row", "start")。 */
export function splitLeaf(
  node: PaneNode,
  targetGroupId: string,
  newLeaf: PaneNode,
  dir: PaneDir,
  side: "start" | "end",
): PaneNode {
  if (node.type === "leaf") {
    if (node.groupId !== targetGroupId) return node;
    const children: [PaneNode, PaneNode] = side === "start" ? [newLeaf, node] : [node, newLeaf];
    return { type: "split", dir, ratio: 0.5, children };
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], targetGroupId, newLeaf, dir, side),
      splitLeaf(node.children[1], targetGroupId, newLeaf, dir, side),
    ],
  };
}

/** 移除含 groupId 的叶子，返回坍缩后的树（用兄弟替换父 split）。根被移除返回 null。
 *  注意：调用方需保证至少剩一个 group（根不应被删空）。 */
export function removeLeaf(node: PaneNode, groupId: string): PaneNode | null {
  if (node.type === "leaf") return node.groupId === groupId ? null : node;
  const a = removeLeaf(node.children[0], groupId);
  const b = removeLeaf(node.children[1], groupId);
  if (a && b) return { ...node, children: [a, b] };
  return a ?? b; // 一子被删 → 坍缩：返回另一子（提升给祖父）
}

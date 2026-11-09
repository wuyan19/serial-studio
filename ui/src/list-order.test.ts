import { describe, expect, it } from "vitest";
import { moveListItem, orderItems, parseListOrders } from "./list-order";

describe("saved connection list order", () => {
  it("rejects damaged storage and keeps only valid, deduplicated scopes", () => {
    for (const raw of [null, "bad", "null", "[]", "42"]) expect(parseListOrders(raw)).toEqual({});
    expect(parseListOrders('{"devices":["b","a","b"],"bad":[1],"other":null}')).toEqual({ devices: ["b", "a"] });
  });
  it("uses stable identities, ignores absent devices and appends new devices in source order", () => {
    const items = [{ id: "a" }, { id: "new" }, { id: "b" }, { id: "newer" }];
    expect(orderItems(items, ["missing", "b", "a"], item => item.id).map(item => item.id)).toEqual(["b", "a", "new", "newer"]);
    expect(items.map(item => item.id)).toEqual(["a", "new", "b", "newer"]);
  });
  it("moves before or after an existing target without mutating the original list", () => {
    const ids = ["a", "b", "c"];
    expect(moveListItem(ids, "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(moveListItem(ids, "a", "c", true)).toEqual(["b", "c", "a"]);
    expect(moveListItem(ids, "a", "b", false)).toEqual(ids);
    for (const [source, target] of [["a", "a"], ["missing", "b"], ["a", "missing"]]) {
      expect(moveListItem(ids, source, target, false)).toEqual(ids);
    }
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

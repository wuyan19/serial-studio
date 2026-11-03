import { describe, expect, it } from "vitest";
import {
  addPortToGroup, addSshToGroup, dissolvePortGroup, emptyPortGrouping, getGroupMemberships,
  parsePortGrouping, removePortFromGroup, removeSshFromGroup, renamePortGroup,
} from "./port-groups";

function labGroups() {
  return { ...emptyPortGrouping(), names: ["Lab", "Field"] };
}

describe("port grouping preferences", () => {
  it("recovers from corrupt or structurally invalid stored preferences", () => {
    for (const raw of [null, "{", "null", "[]", '"groups"']) {
      expect(parsePortGrouping(raw)).toEqual(emptyPortGrouping());
    }
    expect(parsePortGrouping(JSON.stringify({
      names: [" Lab ", "Lab", 9, ""],
      assignments: { COM1: ["Lab", "Lab", "missing", 9], COM2: [], COM3: 4, "": "Lab" },
      sshAssignments: [],
      collapsed: ["Lab", "Lab", "missing", null],
    }))).toEqual({ names: ["Lab"], assignments: { COM1: ["Lab"] }, sshAssignments: {}, collapsed: ["Lab"] });
  });

  it("migrates old single-group preferences without changing endpoint identities", () => {
    const raw = JSON.stringify({
      names: ["Lab", "Field"],
      assignments: { COM1: "Lab", "remote::COM1": "Field", "remote::child::COM1": "Lab", missing: "unknown" },
      collapsed: ["Field"],
    });
    const state = parsePortGrouping(raw);
    expect(state).toEqual({
      names: ["Lab", "Field"],
      assignments: { COM1: ["Lab"], "remote::COM1": ["Field"], "remote::child::COM1": ["Lab"] },
      sshAssignments: {}, collapsed: ["Field"],
    });
    expect(parsePortGrouping(JSON.stringify(state))).toEqual(state);
  });

  it("adds an endpoint to multiple groups and removes only the chosen membership", () => {
    const original = addPortToGroup(labGroups(), "remote::COM1", "Lab");
    const both = addPortToGroup(original, "remote::COM1", "Field");
    expect(both.assignments["remote::COM1"]).toEqual(["Lab", "Field"]);
    expect(original.assignments["remote::COM1"]).toEqual(["Lab"]);
    expect(addPortToGroup(both, "remote::COM1", "Lab")).toBe(both);
    const removed = removePortFromGroup(both, "remote::COM1", "Lab");
    expect(removed.assignments["remote::COM1"]).toEqual(["Field"]);
    expect(removePortFromGroup(removed, "remote::COM1", "Field").assignments).toEqual({});
    expect(addPortToGroup(both, "remote::COM1", "unknown")).toBe(both);
    expect(addPortToGroup(both, "", "Lab")).toBe(both);
    expect(removePortFromGroup(both, "missing", "Lab")).toBe(both);
  });

  it("keeps SSH device memberships independent from endpoint memberships", () => {
    let state = addPortToGroup(labGroups(), "host::shell@2", "Field");
    state = addSshToGroup(state, "host", "Lab");
    state = addSshToGroup(state, "host", "Field");
    expect(state.sshAssignments.host).toEqual(["Lab", "Field"]);
    expect(state.assignments).toEqual({ "host::shell@2": ["Field"] });
    const removed = removeSshFromGroup(state, "host", "Lab");
    expect(removed.sshAssignments.host).toEqual(["Field"]);
    expect(removed.assignments).toEqual(state.assignments);
    expect(removeSshFromGroup(removed, "host", "Field").sshAssignments).toEqual({});
    expect(parsePortGrouping(JSON.stringify(state))).toEqual(state);
  });

  it("renames both membership types without rewriting identity keys and rejects collisions", () => {
    const original = {
      names: ["Lab", "Field"], assignments: { "remote::shell@2": ["Lab", "Field"] },
      sshAssignments: { host: ["Lab"] }, collapsed: ["Lab"],
    };
    expect(renamePortGroup(original, "Lab", "Field")).toBe(original);
    expect(renamePortGroup(original, "Lab", " ")).toBe(original);
    expect(renamePortGroup(original, "Lab", "Lab")).toBe(original);
    expect(renamePortGroup(original, "Lab", "New lab")).toEqual({
      names: ["New lab", "Field"], assignments: { "remote::shell@2": ["New lab", "Field"] },
      sshAssignments: { host: ["New lab"] }, collapsed: ["New lab"],
    });
    expect(original.assignments["remote::shell@2"]).toEqual(["Lab", "Field"]);
  });

  it("dissolves only the selected group while preserving other memberships and disconnected endpoints", () => {
    const state = {
      names: ["Lab", "Field"], assignments: { COM1: ["Lab", "Field"], "offline::COM7": ["Lab"] },
      sshAssignments: { host: ["Lab", "Field"] }, collapsed: ["Lab", "Field"],
    };
    expect(dissolvePortGroup(state, "Lab")).toEqual({
      names: ["Field"], assignments: { COM1: ["Field"] }, sshAssignments: { host: ["Field"] }, collapsed: ["Field"],
    });
    expect(state.assignments["offline::COM7"]).toEqual(["Lab"]);
    expect(dissolvePortGroup(state, "unknown")).toBe(state);
  });

  it("handles object-prototype-looking identities safely for both membership types", () => {
    let state = labGroups();
    expect(getGroupMemberships(state.assignments, "constructor")).toEqual([]);
    expect(getGroupMemberships(state.sshAssignments, "__proto__")).toEqual([]);
    for (const key of ["__proto__", "constructor", "toString"]) {
      state = addPortToGroup(state, key, "Lab");
      state = addPortToGroup(state, key, "Field");
      state = addSshToGroup(state, key, "Field");
      expect(getGroupMemberships(state.assignments, key)).toEqual(["Lab", "Field"]);
      expect(getGroupMemberships(state.sshAssignments, key)).toEqual(["Field"]);
    }
    expect(Object.getPrototypeOf(state.assignments)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(state.sshAssignments)).toBe(Object.prototype);
    expect(parsePortGrouping(JSON.stringify(state))).toEqual(state);
    state = removePortFromGroup(state, "__proto__", "Lab");
    state = removePortFromGroup(state, "__proto__", "Field");
    state = removeSshFromGroup(state, "__proto__", "Field");
    expect(getGroupMemberships(state.assignments, "__proto__")).toEqual([]);
    expect(getGroupMemberships(state.sshAssignments, "__proto__")).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_COLORS_KEY, connectionColorKey, loadConnectionColors, saveConnectionColors } from "./connection-colors";
import type { PortInfo } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("connection colors", () => {
  it("uses the SSH owner for both base and duplicate tabs, including relayed connections", () => {
    const device: PortInfo["device"] = { id: "lab-host", label: "Lab SSH", via: "ssh" };
    for (const pid of ["lab-host::shell", "lab-host::shell@2", "relay::lab-host::shell@3"]) {
      expect(connectionColorKey(pid, { name: pid, kind: "ssh", device })).toBe("ssh:lab-host");
    }
    expect(connectionColorKey("lab-host::shell@4", undefined, "lab-host")).toBe("ssh:lab-host");
    expect(connectionColorKey("relay::lab-host::shell@3", { name: "relay::lab-host::shell@3", kind: "ssh" }))
      .toBe("ssh:relay::lab-host");
  });

  it("keeps same-named serial ports on different devices separate", () => {
    expect(connectionColorKey("device-a::COM5")).toBe("serial:device-a::COM5");
    expect(connectionColorKey("device-b::COM5")).toBe("serial:device-b::COM5");
  });

  it("round-trips independent overrides and ignores invalid saved colors", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    saveConnectionColors(new Map([
      ["ssh:lab-host", { tab: "#aa1133", cursor: "#55cc99" }],
      ["serial:COM5", { cursor: "#ffffff" }],
    ]));
    expect(loadConnectionColors().get("ssh:lab-host")).toEqual({ tab: "#aa1133", cursor: "#55cc99" });
    expect(loadConnectionColors().get("serial:COM5")?.tab).toBeUndefined();
    storage.set(CONNECTION_COLORS_KEY, JSON.stringify({ "serial:COM5": { tab: "url(x)", cursor: "#12AB34" } }));
    expect(loadConnectionColors().get("serial:COM5")).toEqual({ cursor: "#12AB34" });
    storage.set(CONNECTION_COLORS_KEY, "{");
    expect(loadConnectionColors().size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { PortInfo } from "./types";
import { accessTargetKey, accessTargetOptions } from "./access";

function serial(name: string, alias?: string): PortInfo {
  return { name, alias, opened: false, holders: 0 };
}

describe("access target options", () => {
  it("shows one choice per macOS serial device and keeps its alias", () => {
    const callout = "/dev/cu.debug-console";
    const dialIn = "/dev/tty.debug-console";
    const options = accessTargetOptions([serial(callout), serial(dialIn, "调试")]);
    expect(options).toEqual([{ target: { kind: "serial", id: dialIn }, label: "调试 (/dev/tty.debug-console)" }]);
    expect(accessTargetKey(options[0].target)).toBe(accessTargetKey({ kind: "serial", id: "local::" + callout }));
  });

  it("normalizes Windows aliases while keeping serial ports on different devices separate", () => {
    const options = accessTargetOptions([
      serial("relay-a::COM3"),
      serial("relay-a::\\\\.\\com3"),
      serial("relay-b::COM3"),
    ]);
    expect(options).toHaveLength(2);
    expect(new Set(options.map(({ target }) => accessTargetKey(target)))).toEqual(
      new Set(["serial:relay-a::com3", "serial:relay-b::com3"]),
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDeviceShareUrl, createShareClipboardScanner, parseDeviceShareUrl, SHARE_FRAGMENT } from "./device-share";

const a = { host: "192.168.20.119", port: 18700 };
const b = { host: "10.0.0.2", port: 18701 };
const link = (authority: string) => `http://${authority}/${SHARE_FRAGMENT}`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("device share URLs", () => {
  it("opens the service root in a browser and round-trips the address", () => {
    const text = createDeviceShareUrl(a);
    expect(text).toBe("http://192.168.20.119:18700/#serial-studio-share=v1");
    expect(new URL(text).pathname).toBe("/");
    expect(parseDeviceShareUrl(` \n${text}\n `)).toEqual(a);
    expect(parseDeviceShareUrl(link("10.0.0.1"))).toEqual({ host: "10.0.0.1", port: 80 });
    expect(parseDeviceShareUrl(link("10.0.0.1:80"))).toEqual({ host: "10.0.0.1", port: 80 });
    expect(parseDeviceShareUrl(createDeviceShareUrl({ host: "8.8.8.8", port: 65535 }))).toEqual({ host: "8.8.8.8", port: 65535 });
  });

  it.each([
    "127.0.0.1", "127.1.2.3", "localhost", "0.0.0.0", "0.1.2.3", "169.254.1.1",
    "224.1.2.3", "255.255.255.255", "256.1.2.3", "192.168.1", "192.168.01.1",
    "3232235777", "0xc0a80101", "[::1]", "[fe80::1]", "192.168.1.1.evil.test",
    "user@192.168.1.1", "192.168.1.1@10.0.0.1", "192.168.1.1%00.evil.test",
  ])("rejects unsuitable and noncanonical hosts: %s", (host) => {
    expect(parseDeviceShareUrl(link(`${host}:18700`))).toBeNull();
    expect(() => createDeviceShareUrl({ host, port: 18700 })).toThrow();
  });

  it.each([0, -1, 65536, 1.5, NaN, Infinity])("rejects invalid ports: %s", (port) => {
    expect(() => createDeviceShareUrl({ ...a, port })).toThrow();
    expect(parseDeviceShareUrl(link(`${a.host}:${port}`))).toBeNull();
  });

  it("ignores unmarked text, oversized clipboard content and altered destinations", () => {
    for (const text of [
      null, "", "ordinary text", "x".repeat(500000) + createDeviceShareUrl(a),
      `http://${a.host}:18700/`, `https://${a.host}:18700/${SHARE_FRAGMENT}`,
      `http://${a.host}:18700/path/${SHARE_FRAGMENT}`, `http://${a.host}:18700/?remote=10.0.0.1:80${SHARE_FRAGMENT}`,
      createDeviceShareUrl(a) + "&other=1", createDeviceShareUrl(a).replace("v1", "v2"),
      `http://${a.host}:18700/../${SHARE_FRAGMENT}`,
    ]) expect(parseDeviceShareUrl(text)).toBeNull();
  });
});

describe("share clipboard scans", () => {
  it("only reads once for concurrent focus events", async () => {
    const pending = deferred<string | null>();
    const read = vi.fn(() => pending.promise);
    const onShare = vi.fn();
    const scanner = createShareClipboardScanner({ read, onShare, isIgnored: async () => false });
    const first = scanner.check();
    const second = scanner.check();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(createDeviceShareUrl(a));
    await Promise.all([first, second]);
    expect(onShare).toHaveBeenCalledExactlyOnceWith(a);
  });

  it("does no identity work for ordinary clipboard text and never reprompts the same link", async () => {
    const read = vi.fn().mockResolvedValueOnce("plain text").mockResolvedValueOnce(createDeviceShareUrl(a))
      .mockResolvedValueOnce(null).mockResolvedValueOnce(createDeviceShareUrl(a))
      .mockResolvedValueOnce(createDeviceShareUrl(b)).mockResolvedValueOnce(createDeviceShareUrl(a));
    const isIgnored = vi.fn().mockResolvedValue(false);
    const onShare = vi.fn();
    const scanner = createShareClipboardScanner({ read, isIgnored, onShare });
    await scanner.check();
    expect(isIgnored).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) await scanner.check();
    expect(onShare.mock.calls).toEqual([[a], [b], [a]]);
  });

  it("ignores existing and own devices before prompting", async () => {
    const isIgnored = vi.fn().mockResolvedValue(true);
    const onShare = vi.fn();
    const scanner = createShareClipboardScanner({ read: async () => createDeviceShareUrl(a), isIgnored, onShare });
    await scanner.check();
    await scanner.check();
    expect(isIgnored).toHaveBeenCalledExactlyOnceWith(a);
    expect(onShare).not.toHaveBeenCalled();
  });

  it("retries after clipboard and identity lookup failures", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(createDeviceShareUrl(a));
    const isIgnored = vi.fn().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(false);
    const onShare = vi.fn();
    const scanner = createShareClipboardScanner({ read, isIgnored, onShare });
    await scanner.check();
    await scanner.check();
    await scanner.check();
    expect(onShare).toHaveBeenCalledExactlyOnceWith(a);
  });

  it("ignores a late clipboard response after stopping", async () => {
    const pending = deferred<string | null>();
    const isIgnored = vi.fn().mockResolvedValue(false);
    const onShare = vi.fn();
    const read = vi.fn(() => pending.promise);
    const scanner = createShareClipboardScanner({ read, isIgnored, onShare });
    const check = scanner.check();
    scanner.stop();
    pending.resolve(createDeviceShareUrl(a));
    await check;
    await scanner.check();
    expect(read).toHaveBeenCalledTimes(1);
    expect(isIgnored).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
  });

  it("ignores a late identity lookup after stopping", async () => {
    const pending = deferred<boolean>();
    const isIgnored = vi.fn(() => pending.promise);
    const onShare = vi.fn();
    const scanner = createShareClipboardScanner({ read: async () => createDeviceShareUrl(a), isIgnored, onShare });
    const check = scanner.check();
    await Promise.resolve();
    expect(isIgnored).toHaveBeenCalledTimes(1);
    scanner.stop();
    pending.resolve(false);
    await check;
    expect(onShare).not.toHaveBeenCalled();
  });
});

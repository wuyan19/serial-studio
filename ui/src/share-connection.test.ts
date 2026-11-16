import { afterEach, describe, expect, it, vi } from "vitest";
import { initConn } from "./lib";

afterEach(() => vi.unstubAllGlobals());

function page(url: string) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", new URL(url));
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ host: "10.0.0.7", port: 19999 }) });
}

describe("opening a device share in the browser", () => {
  it("connects to the shared service instead of a previously saved connection", () => {
    page("http://192.168.1.8:18700/#serial-studio-share=v1");
    expect(initConn()).toEqual({ host: "192.168.1.8", port: 18700 });
  });

  it("preserves the saved connection when the page is not a valid share", () => {
    for (const url of ["http://192.168.1.8:18700/", "http://192.168.1.8:18700/#serial-studio-share=v2"]) {
      page(url);
      expect(initConn()).toEqual({ host: "10.0.0.7", port: 19999 });
    }
  });

  it("keeps the desktop main window connected locally", () => {
    page("http://192.168.1.8:18700/#serial-studio-share=v1");
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(initConn()).toEqual({ host: "127.0.0.1", port: 18700 });
  });
});

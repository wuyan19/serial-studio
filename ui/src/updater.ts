// 在线升级封装：检查 / 下载安装重启 / 平台与形态判定。
// 仅「本地桌面模式」（Tauri 且窗口非远程）启用；macOS 不自动安装
// （未公证 app 自更新替换后会被 Gatekeeper 再次拦截）。详见 docs/auto-update.md。

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./lib";

export type { Update };

export type UpdateState =
  | "idle" | "checking" | "upToDate" | "available"
  | "downloading" | "downloadComplete" | "failed";

export interface UpdateStatus {
  state: UpdateState;
  version?: string; // 新版本号（available 时）
  notes?: string; // 更新说明（latest.json.notes）
  percent?: number; // 下载进度 0–100
  message?: string; // 失败时的错误信息
}

const RELEASES_URL = "https://github.com/wuyan19/serial-studio/releases/latest";

/** 本地桌面模式：Tauri 且窗口非远程（?remote=）。Web / 远程窗口无本机 updater 意义。 */
export function isLocalDesktop(): boolean {
  if (!isTauri()) return false;
  return !/[?&]remote=/.test(window.location.search);
}

/** 当前平台是否支持自动下载安装。macOS 未公证 → 仅跳转下载，不自动安装。 */
export function supportsAutoInstall(): boolean {
  return platform() !== "macos";
}

/** 检查更新。返回状态 + Update 对象（供后续 downloadAndInstall）。 */
export async function checkUpdate(): Promise<{ status: UpdateStatus; update: Update | null }> {
  try {
    const update = await check();
    if (update) {
      return {
        status: { state: "available", version: update.version, notes: update.body },
        update,
      };
    }
    return { status: { state: "upToDate" }, update: null };
  } catch (e) {
    return { status: { state: "failed", message: errMsg(e) }, update: null };
  }
}

/** 下载并安装（带进度回调），完成后重启。仅 supportsAutoInstall() 为真时调用。 */
export async function downloadAndInstall(
  update: Update,
  onProgress: (percent: number) => void,
): Promise<UpdateStatus> {
  try {
    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          onProgress(0);
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            onProgress(Math.round((downloaded / contentLength) * 100));
          }
          break;
        case "Finished":
          break;
      }
    });
    await relaunch(); // 校验通过 + 安装完成 → 重启
    return { state: "downloadComplete" };
  } catch (e) {
    return { state: "failed", message: errMsg(e) };
  }
}

/** 打开 Release 页（macOS 发现新版 / 更新失败的回退）。 */
export async function openReleasesPage(): Promise<void> {
  await openUrl(RELEASES_URL);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

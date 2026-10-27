/** 小工具（抄自 serial-studio lib.ts 的所需子集）。 */

export const REPO_URL = "https://github.com/wuyan19/serial-studio";

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** 复制到系统剪贴板：安全上下文走 navigator.clipboard，缺失/失败降级 execCommand
 * （局域网 http 访问无 clipboard API，Chromium/WebKit 仍支持 execCommand）。 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到兜底 */
    }
  }
  try {
    const prev =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    prev?.focus();
    return ok;
  } catch {
    return false;
  }
}

/** 端口显示名（裸段）：有别名显别名，否则真名。 */
export function displayPortName(name: string, alias?: string): string {
  const a = alias?.trim();
  return a ? a : name;
}

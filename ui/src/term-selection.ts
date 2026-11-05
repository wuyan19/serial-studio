import type { Terminal } from "@xterm/xterm";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauri } from "./lib";

// Automatic copies must not queue browser clipboard writes waiting for focus.
export function copySelectionText(text: string, document: Document): boolean | Promise<boolean> {
  // Native writes do not wait for the WebView to regain clipboard permission.
  if (isTauri()) return writeText(text).then(() => true, () => false);
  const previous = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  let handled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
    handled = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    // WebKit requires an actual DOM selection for execCommand to copy reliably.
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy") && handled;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
    textarea.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
}

export function installSelectionCopy(
  term: Pick<Terminal, "onSelectionChange" | "getSelection">,
  container: HTMLElement,
  copy = copySelectionText,
): () => void {
  const document = container.ownerDocument;
  const window = document.defaultView!;
  let gesture: object | null = null;
  let lastText = "";
  const reset = () => { gesture = null; lastText = ""; };
  const begin = () => {
    reset();
    const current = {};
    gesture = current;
    return current;
  };
  const onDown = (event: MouseEvent) => {
    if (event.button === 0 || event.button === 2) begin();
  };
  const transientGesture = () => {
    const current = begin();
    queueMicrotask(() => { if (gesture === current) reset(); });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") transientGesture();
  };
  const onVisibility = () => { if (document.hidden) reset(); };
  const selection = term.onSelectionChange(() => {
    if (!gesture || !document.hasFocus() || document.hidden) return;
    const text = term.getSelection();
    if (text && text !== lastText) {
      lastText = text;
      copy(text, document);
    }
  });
  container.addEventListener("mousedown", onDown, true);
  container.addEventListener("contextmenu", transientGesture, true);
  container.addEventListener("keydown", onKeyDown, true);
  // xterm completes selection in its document mouseup listener, before window bubbling.
  window.addEventListener("mouseup", reset);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    reset();
    selection.dispose();
    container.removeEventListener("mousedown", onDown, true);
    container.removeEventListener("contextmenu", transientGesture, true);
    container.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("mouseup", reset);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

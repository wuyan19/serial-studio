export interface FileDropData {
  readonly types?: ArrayLike<string>;
  readonly files?: { readonly length: number };
}

export function isFileDrop(dataTransfer: FileDropData | null | undefined): boolean {
  return !!dataTransfer && (
    Array.from(dataTransfer.types ?? []).includes("Files") ||
    (dataTransfer.files?.length ?? 0) > 0
  );
}

export function installFileDropGuard(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  const guard = (event: Event) => {
    const transfer = (event as DragEvent).dataTransfer;
    if (!isFileDrop(transfer)) return;
    // Cancel document navigation while allowing the receiving panel to handle the file.
    event.preventDefault();
    if (transfer && event.type === "dragover") transfer.dropEffect = "none";
  };
  const options = { capture: true, passive: false };
  target.addEventListener("dragover", guard, options);
  target.addEventListener("drop", guard, options);
  return () => {
    target.removeEventListener("dragover", guard, options);
    target.removeEventListener("drop", guard, options);
  };
}

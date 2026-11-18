/** 「自定义布局」按钮 + 四预设弹出菜单（IconLayout 四变体）。
 *  桌面壳挂在标题栏（titlebar.tsx）；Web 模式无标题栏，由状态栏挂同一组件
 *  ——两形态同一入口同一行为，切换即时生效、localStorage 持久化。 */
import { useEffect, useRef, useState } from "react";
import { LAYOUT_PRESETS, type LayoutMode } from "../layout";
import {
  IconLayout,
  IconLayoutColumns,
  IconLayoutMain,
  IconLayoutRows,
} from "../icons";

/** 预设图标：与 LAYOUT_PRESETS 同序（standard/Main、term-bottom/Layout、
 *  rows/Rows、columns/Columns——用户参考图四变体）。 */
const LAYOUT_ICONS = {
  standard: IconLayoutMain,
  "term-bottom": IconLayout,
  rows: IconLayoutRows,
  columns: IconLayoutColumns,
} as const;

export function LayoutMenuButton({
  layoutMode,
  onLayoutChange,
}: {
  layoutMode: LayoutMode;
  onLayoutChange: (m: LayoutMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="titlebar__layout" ref={rootRef}>
      <button
        className="titlebar__btn"
        title="自定义布局"
        aria-label="自定义布局"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconLayout className="titlebar__btn-icon" />
      </button>
      {open && (
        <div className="layout-menu" role="menu" aria-label="布局预设">
          {LAYOUT_PRESETS.map((p) => {
            const Icon = LAYOUT_ICONS[p.mode];
            return (
              <button
                key={p.mode}
                role="menuitemradio"
                aria-checked={layoutMode === p.mode}
                className={`layout-menu__item${layoutMode === p.mode ? " layout-menu__item--on" : ""}`}
                onClick={() => {
                  onLayoutChange(p.mode);
                  setOpen(false);
                }}
              >
                <Icon className="layout-menu__icon" />
                <span className="layout-menu__text">
                  <b>{p.label}</b>
                  <small>{p.hint}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

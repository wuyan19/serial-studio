/** 通用右键/上下文浮层菜单:fixed 定位 portal 到 body,越界自动翻转。
 *  关闭:点击菜单外(捕获)/ Escape / 滚轮 / 窗口 resize。纯视图组件,无业务依赖。 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  /** 分隔线项:只渲染 hr,其余字段忽略。 */
  sep?: boolean;
  label?: string;
  /** 右侧弱化提示文字(快捷键等)。 */
  hint?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  /** 触发坐标(clientX/clientY,viewport 坐标系——本组件 fixed 定位直接可用)。 */
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** 关闭回调,携带原因:item=点了菜单项;escape;outside=点菜单外;wheel/resize。
   *  调用方按需善后(如 escape/item 后把焦点还给终端)。 */
  onClose: (reason: "item" | "escape" | "outside" | "wheel" | "resize") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 越界翻转:挂载后量实际尺寸,放不下就向上/向左翻,并露出自身(先 hidden 防闪位)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flipX = x + r.width > window.innerWidth - 8;
    const flipY = y + r.height > window.innerHeight - 8;
    el.style.left = `${flipX ? Math.max(8, x - r.width) : x}px`;
    el.style.top = `${flipY ? Math.max(8, y - r.height) : y}px`;
    el.style.visibility = "visible";
  }, [x, y]);

  // 全局关闭监听:mousedown 用捕获阶段——抢在任何 onClick 处理前收场,避免
  // "点菜单项同帧又触发别处 handler"的时序毛刺。Escape/滚轮/resize 同理全局。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose("escape");
      }
    };
    const onWheel = () => onClose("wheel");
    const onResize = () => onClose("resize");
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: x, top: y, visibility: "hidden" }}
      onContextMenu={(e) => {
        // 菜单自身上再右键:不弹原生菜单也不重开,仅关闭(防套娃)。
        // 必须 stopPropagation:portal 合成事件沿 fiber 树冒泡,会打到 TermView 根的
        // onContextMenu 重开菜单(setState 后写胜出),注释意图即告失效
        e.preventDefault();
        e.stopPropagation();
        onClose("outside");
      }}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-menu__sep" role="separator" />
        ) : (
          <button
            key={i}
            className="ctx-menu__item"
            role="menuitem"
            data-disabled={it.disabled ? "true" : undefined}
            aria-disabled={it.disabled || undefined}
            // mousedown 不改焦点(标准菜单行为):点菜单项不把焦点从终端挪走,
            // 选词/光标态原样保留,click 后终端照常接键盘输入
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (it.disabled || !it.onSelect) return;
              it.onSelect();
              onClose("item");
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="ctx-menu__hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** 底层原语：布局行、通用 hook、端口名标签、别名 inline 输入、分组头、活动栏图标。
各对话框/编辑器/终端视图共用，不依赖其它组件模块。 */
import { useEffect, useMemo, useRef, useState } from "react";

// ===== 通用 =====

export function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      {children}
    </div>
  );
}

/** 模块级对话框栈:嵌套对话框(编辑器上叠确认框、确认框上再叠帮助浮层)的按键归属仲裁——
 *  只有栈顶响应 Esc/Enter,否则 window 级监听会全部触发(一次 Esc 关两层)。
 *  挂载即 push、卸载即 pop;后挂载(视觉上层)者后 push → 栈顶。 */
const dialogStack: number[] = [];
let dialogSeq = 0;
function useDialogStackId(): number {
  const id = useMemo(() => ++dialogSeq, []);
  useEffect(() => {
    dialogStack.push(id);
    return () => {
      const i = dialogStack.indexOf(id);
      if (i >= 0) dialogStack.splice(i, 1);
    };
  }, [id]);
  return id;
}

/** 裸 Esc 关闭对话框（无修饰符）。给仅靠按钮关闭、无 Enter 语义的通用对话框用。
 *  模态打开期间 App 全局 listener 已被抑制，不会与之冲突。 */
// Esc/Enter 走 capture:终端聚焦时 xterm 会在 bubble 阶段吃掉 Esc(About 无 autoFocus、
// 从终端用快捷键打开后 Esc 关不掉),capture 先于 xterm 触发,焦点在不在对话框里都能关。
// 栈顶判定 + stopImmediatePropagation:一次按键只归最上层对话框。
export function useEscClose(onClose: () => void) {
  const id = useDialogStackId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== id) return; // 非栈顶(上层还有对话框):让位
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, id]);
}

/** 对话框通用键：Esc 关闭、回车触发主操作（同 AliasDialog 语义）。
 *  回车是 window 级监听，故点击输入框编辑后按回车仍能触发主操作（不依赖按钮焦点）。 */
export function useDialogKeys({ onClose, onEnter }: { onClose: () => void; onEnter?: () => void }) {
  const id = useDialogStackId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== id) return; // 非栈顶:让位
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Enter" && onEnter) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onEnter();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onEnter, id]);
}

/** 对话框焦点圈闭：挂载时焦点入框（有 autoFocus 输入框或 initialFocus 指定时聚焦它）、
 *  Tab 循环在内、卸载（关闭）后焦点还原到打开前的元素（通常是终端）。
 *  配合容器上的 role="dialog" aria-modal="true" 使用。
 *  initialFocus 不能用 autoFocus 属性实现——它在 commit 期生效,早于本 effect 捕获 prev,
 *  会把 prev 污染成对话框内部元素(卸载时还原到已卸载节点,焦点丢 body)。 */
export function useDialogA11y(ref: React.RefObject<HTMLDivElement | null>, initialFocus?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)
      ? document.activeElement
      : null;
    if (initialFocus?.current) initialFocus.current.focus();
    else if (!el.contains(document.activeElement)) {
      el.tabIndex = -1;
      el.focus();
    }
    const FOCUSABLE =
      "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex='-1']),[contenteditable]:not([contenteditable='false'])";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      // 打开者可能已卸载(如编辑器整体关闭);isConnected 兜底,失效则不动(交由上层回焦逻辑)
      if (prev?.isConnected) prev.focus();
    };
  }, [ref, initialFocus]);
}

/** 端口名展示：有别名时显「别名(真名)」，真名走 .port-label__raw 浅色；无别名仅显真名。
 *  端口行 / tab / 通道条共用，避免三处重复 JSX。 */
export function PortLabel({ name, alias }: { name: string; alias?: string }) {
  const a = alias?.trim();
  if (!a) return <span className="port-label">{name}</span>;
  return (
    <span className="port-label" title={`${a}（${name}）`}>
      {a}
      <span className="port-label__raw">({name})</span>
    </span>
  );
}


// ===== 别名 inline 编辑 =====

/** 原地（inline）编辑端口别名：替换 PortLabel 显示，不弹模态。
 *  挂载即聚焦 + 全选；Enter / blur 提交，Esc 取消。值未变则仅关闭、不写盘。
 *  与旧 AliasDialog 同语义（空串=清除别名），键盘逻辑搬自其 keydown。
 *  调用方做「编辑态」条件渲染：editing ? <InlineAliasInput/> : <PortLabel/>。 */
export function InlineAliasInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (alias: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false); // 防 Enter/Esc 与 blur 重复收尾
  const armedRef = useRef(false); // 聚焦稳定后才响应 blur，跳过挂载/事件链里的误 blur

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // 下一帧再聚焦：点铅笔/双击的事件链未走完时立即 focus() 易被随后的焦点归位打断
    const id = requestAnimationFrame(() => {
      el.focus();
      el.select();
      armedRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const finish = (mode: "commit" | "cancel") => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (mode === "cancel") {
      onCancel();
      return;
    }
    const trimmed = value.trim();
    // 未改值：仅关闭，不写盘 / 不触发 meta 广播
    if (trimmed === initial.trim()) onCancel();
    else onCommit(trimmed);
  };

  return (
    <input
      ref={inputRef}
      className="alias-inline"
      value={value}
      autoCapitalize="off"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      // 点击不冒泡到 .port-item / .tab，避免编辑中触发切换端口
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish("commit");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish("cancel");
        }
      }}
      onBlur={() => {
        if (armedRef.current) finish("commit");
      }}
    />
  );
}

/** 分组标题行：折叠按钮 + 组名(可 inline 重命名) + 计数 + ⋯ 菜单(重命名/解散)。
 *  宏/脚本侧栏共用，封装组级交互；成员列表由调用方各自渲染。
 *  head 为 div（内含 ⋯ button 与 inline input，避免 button 嵌 button）——同 .port-group__head 模式。
 *  局部自管理 menuOpen/renaming 两个 UI 状态，不上升调用方。 */

export function GroupHead({
  name,
  count,
  collapsed,
  onToggle,
  onRename,
  onDissolve,
  menuHidden = false,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (newName: string) => void;
  onDissolve: () => void;
  /** 隐藏 ⋯ 菜单（「未分组」是聚合组——成员 group 字段为 undefined，重命名/解散无意义） */
  menuHidden?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);

  // 菜单/重命名态：点 head 外部收起（InlineAliasInput 的 blur 已自行提交，这里仅兜底关 UI）。
  useEffect(() => {
    if (!menuOpen && !renaming) return;
    const onDown = (e: MouseEvent) => {
      if (headRef.current && !headRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setRenaming(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, renaming]);

  return (
    <div className="macro-group__head" ref={headRef} onClick={renaming ? undefined : onToggle}>
      <span className="macro-group__caret">{collapsed ? "▶" : "▼"}</span>
      {renaming ? (
        <InlineAliasInput
          initial={name}
          placeholder="分组名"
          onCommit={(n) => {
            setRenaming(false);
            onRename(n);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className="macro-group__name">{name}</span>
      )}
      <span className="macro-group__count">{count}</span>
      {!renaming && !menuHidden && (
        <button
          className="macro-group__menu"
          title="分组操作"
          aria-label={`分组操作（${name}）`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div className="group-menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="group-menu__item"
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            重命名分组
          </button>
          <button
            className="group-menu__item group-menu__item--danger"
            onClick={() => {
              setMenuOpen(false);
              onDissolve();
            }}
          >
            解散分组
          </button>
        </div>
      )}
    </div>
  );
}


/** 活动栏图标按钮。badge:角标——"run"=有任务运行中,"alert"=有失败结果待查看(读屏同步)。 */
export function ActivityIcon({ icon, title, active, onClick, badge }: {
  icon: React.ReactNode;
  title: string;
  active: boolean;
  onClick: () => void;
  badge?: "run" | "alert";
}) {
  const label = badge === "run" ? `${title}（有任务运行中）` : badge === "alert" ? `${title}（有失败结果待查看）` : title;
  return (
    <button onClick={onClick} title={title} data-active={active} className="act-icon" aria-label={label}>
      {icon}
      {badge && <span className="act-icon__dot" data-kind={badge} />}
    </button>
  );
}


/** 底层原语：布局行、通用 hook、端口名标签、别名 inline 输入、分组头、活动栏图标。
各对话框/编辑器/终端视图共用，不依赖其它组件模块。 */
import { useEffect, useRef, useState } from "react";

// ===== 通用 =====

export function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      {children}
    </div>
  );
}

/** 裸 Esc 关闭对话框（无修饰符）。给仅靠按钮关闭、无 Enter 语义的通用对话框用。
 *  模态打开期间 App 全局 listener 已被抑制，不会与之冲突。 */
// Esc/Enter 走 capture:终端聚焦时 xterm 会在 bubble 阶段吃掉 Esc(About 无 autoFocus、
// 从终端用快捷键打开后 Esc 关不掉),capture 先于 xterm 触发,焦点在不在对话框里都能关。
export function useEscClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

/** 对话框通用键：Esc 关闭、回车触发主操作（同 AliasDialog 语义）。
 *  回车是 window 级监听，故点击输入框编辑后按回车仍能触发主操作（不依赖按钮焦点）。 */
export function useDialogKeys({ onClose, onEnter }: { onClose: () => void; onEnter?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && onEnter) {
        e.preventDefault();
        onEnter();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onEnter]);
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
            重命名组
          </button>
          <button
            className="group-menu__item group-menu__item--danger"
            onClick={() => {
              setMenuOpen(false);
              onDissolve();
            }}
          >
            解散组
          </button>
        </div>
      )}
    </div>
  );
}


export function ActivityIcon({ icon, title, active, onClick }: { icon: React.ReactNode; title: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title} data-active={active} className="act-icon" aria-label={title}>
      {icon}
    </button>
  );
}


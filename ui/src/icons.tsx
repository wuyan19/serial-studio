/**
 * Monoline inline-SVG icon set for Serial Studio.
 * currentColor stroke so icons inherit the signal/ink color of their context.
 * Replaces the emoji glyphs that made the old UI read as generic.
 */

type IconProps = { className?: string };

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Serial connector — the app's primary identity glyph. */
export function IconPlug({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <rect x="7" y="8" width="10" height="6" rx="1.5" />
      <path d="M9 14v3a3 3 0 0 0 6 0v-3" />
      <path d="M12 20v2" />
    </Svg>
  );
}

/** Macros. */
export function IconBolt({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
    </Svg>
  );
}

/** Keyboard shortcuts. */
export function IconKeyboard({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 11h.01M11 11h.01M15 11h.01M17 11h.01M7 14h.01M17 14h.01M10 14h4" />
    </Svg>
  );
}

/** Dialog maximize / restore. */
export function IconExpand({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </Svg>
  );
}

/** Scripts (code). */
export function IconCode({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 9l-3 3 3 3" />
      <path d="M16 9l3 3-3 3" />
      <path d="M13.5 6l-3 12" />
    </Svg>
  );
}

/** Remote window. */
export function IconGlobe({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.6 2.6 15.4 0 18" />
      <path d="M12 3c-2.6 2.6-2.6 15.4 0 18" />
    </Svg>
  );
}

/** Manage / settings (sliders). */
export function IconSliders({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 6h9" />
      <path d="M19 6h1" />
      <circle cx="16" cy="6" r="2.2" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <circle cx="9" cy="12" r="2.2" />
      <path d="M4 18h9" />
      <path d="M17 18h3" />
      <circle cx="14.5" cy="18" r="2.2" />
    </Svg>
  );
}

/** Gear — used inside the manage menu for Settings. */
export function IconGear({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/** Info. */
export function IconInfo({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Svg>
  );
}

export function IconEdit({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
      <path d="M14 6l4 4" />
    </Svg>
  );
}

export function IconTrash({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3.5 6h17" />
      <path d="M8.5 6V4h7v2" />
      <path d="M6 6l1 13.5h10L18 6" />
      <path d="M10 10v6M14 10v6" />
    </Svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5h-5" />
    </Svg>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

// ===== 窗口控制(自绘标题栏,Win/Linux 用;mac 走原生红绿灯) =====

export function IconWinMin({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconWinMax({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </Svg>
  );
}

/** 还原:两层错位方框 */
export function IconWinRestore({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="5" y="8" width="11" height="11" rx="1" />
      <path d="M9 8V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" />
    </Svg>
  );
}

export function IconChevronUp({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 15l6-6 6 6" />
    </Svg>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconAlert({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function IconBell({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 1.5 6 1.5 6h-15S6 14 6 9Z" />
      <path d="M10.5 19a1.5 1.5 0 0 0 3 0" />
    </Svg>
  );
}

/** 亮色模式。 */
/** 主题(明暗对比圆)——主题菜单入口,不随具体主题换图标。 */
export function IconPalette({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 勾选(菜单当前项)。 */
export function IconCheck({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4.5 12.5l5 5 10-11" />
    </Svg>
  );
}

/** 强制断电——强制关闭:踢掉远程客户端。 */
export function IconPower({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18.36 6.64a9 9 0 1 1-12.72 0" />
      <path d="M12 2v10" />
    </Svg>
  );
}

/** 复制步骤。 */
export function IconCopy({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

/** 拖拽手柄（6 点）。 */
export function IconGrip({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 导入宏（文件 → 应用，箭头入匣）。 */
export function IconImport({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </Svg>
  );
}

/** 导出宏（应用 → 文件，箭头出匣）。 */
export function IconExport({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </Svg>
  );
}

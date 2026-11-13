/**
 * Monoline inline-SVG icon set for Serial Studio.
 * currentColor stroke so icons inherit the signal/ink color of their context.
 * Replaces the emoji glyphs that made the old UI read as generic.
 */

type IconProps = { className?: string };

export function IconShare({ className }: IconProps) {
  return <Svg className={className}>
    <path d="M12 15V3m-4 4 4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
  </Svg>;
}

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

/** Connections panel — chain link, medium-neutral across serial / SSH / remote devices. */
export function IconLink({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

/** Macros. */
export function IconBolt({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13.2 2 5.2 13.4h5.3L9.9 22l8.9-11.4h-5.3L13.2 2Z" />
    </Svg>
  );
}

/** Keyboard shortcuts. */
export function IconKeyboard({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="6.5" width="18" height="11" rx="2.5" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01" />
      <path d="M6.5 13.5h.01M17 13.5h.01M9.5 13.5h5" />
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

/** Scripts —— 卷轴信纸(上下卷边 + 字迹,形制参照 Lucide scroll-text,ISC)。 */
export function IconCode({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M15 8h-5" />
      <path d="M15 12h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
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

/** SSH 设备 —— 终端提示符方框(>_ ,形制参照 Lucide terminal-square)。 */
export function IconSsh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5" />
      <path d="M12.5 15H17" />
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

/** Server stack — the 服务 settings category (listen / connection config). */
export function IconLock({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4m-4 8v-3" />
    </svg>
  );
}

export function IconServer({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="2.5" y="3" width="19" height="7.5" rx="2" />
      <rect x="2.5" y="13.5" width="19" height="7.5" rx="2" />
      <path d="M6.5 6.75h.01" />
      <path d="M6.5 17.25h.01" />
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

/** 分组折叠指示：">" 单线雪佛龙，展开态由 CSS 旋转 90° 朝下。 */
export function IconChevronRight({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

/** 连接列表视图（默认/分组）切换：行首圆点 + 三行列表。 */
export function IconListView({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      {/* round cap + 零长度路径 = 行首圆点 */}
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
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

/** 主题 —— 短袖 T 恤(换主题=换衣服)。 */
export function IconShirt({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9.3 2.6a2.7 2.7 0 0 0 5.4 0" />
      <path d="M9.3 2.6 4.2 4.9 1.8 9.2l3.6 1.7V21.5h13.2V10.9l3.6-1.7-2.4-4.3-5.1-2.3" />
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

export function IconListFilter({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 6h18M6 12h12M10 18h4" />
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

/** 中心+四向节点(拓扑/枢纽):主区未打开端口时的空态图标。
 *  用户手绘原稿 0 0 100 视图,笔宽 2(等比到 24 视图 ≈0.5,故独立 svg 不走 24 视图的 Svg 包装,
 *  保持原比例的轻线条观感)。 */
export function IconHub({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="15" />
      <circle cx="50" cy="16" r="8" />
      <circle cx="50" cy="84" r="8" />
      <circle cx="16" cy="50" r="8" />
      <circle cx="84" cy="50" r="8" />
      <line x1="50" y1="24" x2="50" y2="35" />
      <line x1="50" y1="65" x2="50" y2="76" />
      <line x1="24" y1="50" x2="35" y2="50" />
      <line x1="65" y1="50" x2="76" y2="50" />
    </svg>
  );
}

/** 横向三点(面板标题栏「更多操作」)。实心小圆点,与单线条图标组混用时按点群处理。 */
export function IconMore({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

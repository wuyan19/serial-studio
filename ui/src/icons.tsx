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

/** Run macro. */
export function IconPlay({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M7 4.5 19 12 7 19.5v-15Z" />
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
export function IconSun({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M2 12h2.5M19.5 12H22M4.5 19.5l1.8-1.8M17.7 6.3l1.8-1.8" />
    </Svg>
  );
}

/** 暗色模式。 */
export function IconMoon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" />
    </Svg>
  );
}

/** 强制断电——强制关闭端口（踢掉所有持有者）。 */
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

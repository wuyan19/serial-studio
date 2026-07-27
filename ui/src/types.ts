import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";

export interface PortInfo {
  name: string;
  opened: boolean;
  /** 当前持有者数（多端共享时 >1） */
  holders: number;
  /** 用户自定义别名（描述端口下连接的设备）；无则为 undefined。后端注入。 */
  alias?: string;
}

/** 宏步骤（判别联合，与后端 MacroStep 对齐） */
export type MacroStep =
  | { type: "send"; data: string; format: string; auto_newline: boolean }
  | { type: "delay"; ms: number }
  | { type: "expect"; pattern: string; timeout_ms: number }
  | { type: "clear" };
export type StepType = MacroStep["type"];

export interface Macro {
  description?: string;
  steps: MacroStep[];
}

export interface MacroResult {
  name: string;
  success: boolean;
  message: string;
}

export interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  /** 串口内搜索（Ctrl+F）。随 xterm 实例常驻，搜的是该端口的 scrollback。 */
  search: SearchAddon;
}

export interface SerialConfig {
  baud_rate: number;
  data_bits: string;
  stop_bits: string;
  parity: string;
  flow_control: string;
  line_ending: string;
}

export interface ConnConfig {
  host: string;
  port: number;
}

export interface SrvSettings {
  ws_host: string;
  ws_port: number;
  telnet_port: number;
}

// ===== 快捷键（可改键；唯一真相源在 shortcuts.ts） =====

/**
 * 快捷键动作 id。与 shortcuts.ts 的 DEFAULT_BINDINGS 键严格对齐——
 * 漏写一个即编译错，借此强制两处同步。
 */
export type ActionId =
  | "search.open"
  | "theme.toggle"
  | "port.refresh"
  | "settings.open"
  | "about.open"
  | "activity.toggle-ports"
  | "activity.toggle-macros"
  | "port.close-active"
  | "macro.palette"
  | "zoom.in"
  | "zoom.out"
  | "zoom.reset";

/**
 * 作用域：
 * - global   = 全局窗口监听 + 桌面菜单 accelerator（焦点/模态抑制由 App 控制）
 * - terminal = 仅 xterm 聚焦时生效（字体缩放），不进菜单、不经全局 listener
 */
export type BindingScope = "global" | "terminal";

/**
 * 单条绑定。combo 规范形如 "mod+shift+f"：小写、修饰符在前、主键在后。
 * mod = 平台主修饰符（Win/Linux Ctrl、Mac ⌘）：匹配用 ctrlKey||metaKey，
 * 序列化成 Tauri accelerator 的 CmdOrCtrl（OS 按平台展开），配置天然跨平台。
 * 空 combo = 未绑定（动作仍可在桌面菜单点选，只是无快捷键）。
 */
export interface KeyBinding {
  combo: string;
  scope: BindingScope;
}

/** action → 绑定。 */
export type ShortcutMap = Record<ActionId, KeyBinding>;

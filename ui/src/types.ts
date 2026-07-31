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

/** 一个 JS 脚本定义(与后端 ss_core::Script 对齐)。code 为 JS 源码。 */
/** 脚本运行时参数定义(string / select),与后端 ss_core::ScriptParam 对齐。 */
export interface ScriptParam {
  /** 脚本里 args.<name> 取值的键名。 */
  name: string;
  /** UI 标签;缺省用 name。 */
  label?: string;
  /** "string" | "select"。 */
  type: "string" | "select";
  /** 缺省值(运行收集时预填)。 */
  default?: string;
  /** select 的可选项;string 留空。 */
  options?: string[];
}

export interface Script {
  description?: string;
  /** 声明的运行时参数(持久化);运行收集的值经 runScript 的 args 参数注入,不入库。 */
  params?: ScriptParam[];
  code: string;
}

/** 脚本执行结果(与 MacroResult 同构)。 */
export interface ScriptResult {
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
  /** 是否允许远程(WS/MCP)执行脚本。远程客户端经 version 握手拿到。 */
  enable_scripting: boolean;
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
  | "remote.open"
  | "activity.toggle-ports"
  | "activity.toggle-macros"
  | "activity.toggle-scripts"
  | "port.close-active"
  | "macro.palette"
  | "script.palette"
  | "port.palette"
  | "tab.select"
  | "tab.next"
  | "tab.prev"
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
  /**
   * 正则源（如 "^mod\\+alt\\+(\\d)$"）。存在即表示这是一族键对应一个动作的**参数化绑定**：
   * findAction 精确等值落空后，用 new RegExp(pattern) 匹配 combo，捕获组作为 arg 透传给 handler。
   * 此类绑定无单一 combo（combo 留空），不可改键、不进菜单 accelerator。例：Ctrl+Alt+1..9 切标签页。
   */
  pattern?: string;
}

/** action → 绑定。 */
export type ShortcutMap = Record<ActionId, KeyBinding>;

// ===== 窗口分栏（editor group + 布局树） =====

/** editor group：一个「标签栏 + 终端区」格子（模型 = VS Code 的 editor group）。
 *  端口全局唯一归属一个 group（不扇出）：一个 port 只在一个 group 的 ports 里。 */
export interface Group {
  id: string;
  /** 该 group 内的 tab（串口名），有序；端口全局唯一归属。 */
  ports: string[];
  /** 本 group 当前显示的端口（空串 = 无 tab）。 */
  activePort: string;
}

/** 分栏方向：row=左右排列（主轴 X），col=上下排列（主轴 Y）。 */
export type PaneDir = "row" | "col";

/** 拖拽落点半区（决定分裂方向与侧）：left/right→row，up/down→col。 */
export type PaneHalf = "up" | "down" | "left" | "right";

/** 布局树节点（纯数据，可序列化、可单测）：叶子=一个 group，分裂=两子树 + 比例。
 *  ratio ∈ (0,1)：children[0] 占比；分栏拖动（后续 Phase）只改 ratio。 */
export type PaneNode =
  | { type: "leaf"; groupId: string }
  | { type: "split"; dir: PaneDir; ratio: number; children: [PaneNode, PaneNode] };

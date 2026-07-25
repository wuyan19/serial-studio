import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface PortInfo {
  name: string;
  opened: boolean;
  /** 当前持有者数（多端共享时 >1） */
  holders: number;
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

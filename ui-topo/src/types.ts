/** 与 serial-studio 后端线协议对齐的类型子集（ui-topo 消费的部分）。 */

export interface SerialConfig {
  baud_rate: number;
  data_bits: string;
  stop_bits: string;
  parity: string;
  flow_control: string;
  line_ending: string;
}

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "lf",
};

export type SshAuth =
  | { type: "key"; keyPath: string }
  | { type: "agent" }
  | { type: "password"; password: string };

export type SshEndpoint = { name: string; type: "shell"; alias?: string };

export interface SshHost {
  id: string;
  host: string;
  port: number;
  username: string;
  nickname?: string;
  auth: SshAuth;
  endpoints: SshEndpoint[];
}

export type SshOpenError =
  | { kind: "auth_failed"; method: string }
  | { kind: "host_key_unknown"; fingerprint: string; keyType: string }
  | { kind: "host_key_changed"; known: string; received: string; keyType: string };

export interface RemoteDevice {
  id: string;
  host: string;
  port: number;
  nickname?: string;
}

export interface SrvSettings {
  ws_host: string;
  ws_port: number;
  telnet_port: number;
  enable_scripting: boolean;
  script_log_to_disk: boolean;
  lease: {
    ttl_minutes: number;
    max_ttl_minutes: number;
    enable_gate: boolean;
  };
}

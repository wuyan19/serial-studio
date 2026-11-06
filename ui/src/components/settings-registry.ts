/** 设置页声明式注册表：分类/条目/搜索关键词与搜索过滤。
 *  渲染在 settings-page.tsx 按 control 类型分发；状态全部落在既有模块
 *  （theme/term-font/shortcuts/updater + 连接 props），注册表只描述「有什么」。
 *  新增设置项：在此加条目 + settings-page.tsx 的控件 switch 加分支即可被搜索和渲染。 */
import type { ActionId } from "../types";
import { ACTION_LABELS } from "../shortcuts";
import { isTauri } from "../lib";

export type SettingsCategoryId = "appearance" | "connection" | "shortcuts" | "about";

export interface SettingItemDef {
  id: string;
  label: string;
  description?: string;
  /** 搜索补充词（含英文别名，如 zoom/font/dark） */
  keywords?: string[];
  /** 控件种类（settings-page.tsx 内 switch 分发）；"shortcut-action"/"shortcut-fixed" 的 id 是 ActionId */
  control: string;
}

export interface ShortcutGroupDef {
  title: string;
  actions: ActionId[];
}

export interface SettingsCategoryDef {
  id: SettingsCategoryId;
  label: string;
  /** 大标题下的分类描述（VS Code 设置页同款位置） */
  description: string;
  /** 分类级搜索词：命中则整类全量展示 */
  keywords?: string[];
  items: SettingItemDef[];
  /** 快捷键分组（仅 shortcuts 分类） */
  shortcutGroups?: ShortcutGroupDef[];
}

/** 快捷键分组展示顺序（原 ShortcutsDialog 的 SHORTCUT_GROUPS 迁入）。
 *  注意:新增 ActionId 时除了同步 types.ts 的 ActionId 联合与 shortcuts.ts 的
 *  DEFAULT_BINDINGS/ACTION_LABELS,也要加进对应组——设置页只渲染这些组,
 *  漏加则该动作在改键区不可见(快捷键仍生效,只是无法在此改键)。
 *  tab.select 特殊:一族固定键(Ctrl+Alt+1..9),落在「标签页」组渲染为说明行。 */
const SHORTCUT_GROUPS: { title: string; items: ActionId[] }[] = [
  {
    title: "面板与搜索",
    items: [
      "search.open",
      "macro.palette",
      "script.palette",
      "port.palette",
      "activity.toggle-ports",
      "activity.toggle-macros",
      "activity.toggle-scripts",
    ],
  },
  {
    title: "端口与设备",
    items: ["port.refresh", "port.close-active", "port.reconnect", "remote.open"],
  },
  { title: "标签页", items: ["tab.next", "tab.prev", "tab.select"] },
  { title: "显示与外观", items: ["zoom.in", "zoom.out", "zoom.reset", "theme.toggle"] },
  { title: "应用", items: ["settings.open", "about.open"] },
];

/** 构建分类注册表。showServer 决定连接分类走服务器监听条目还是前端连接条目；
 *  快捷键在 Web 端(desktop=false)剔除 remote.open(已处远程,再开远程无意义)。
 *  desktop 允许显式传入：纯函数测试环境无 window，不能走 isTauri 默认值。 */
export function buildSettingsCategories(showServer: boolean, desktop = isTauri()): SettingsCategoryDef[] {
  const shortcutGroups = SHORTCUT_GROUPS.map((g) => ({
    ...g,
    items: desktop ? g.items : g.items.filter((a) => a !== "remote.open"),
  })).map(({ title, items }) => ({ title, actions: items }));

  const connectionItems: SettingItemDef[] = showServer
    ? [
        { id: "srv.ws_host", label: "监听地址", description: "WS 服务绑定的地址，热重启生效", control: "srv-text" },
        { id: "srv.ws_port", label: "WS 端口", description: "前端/远程窗口的 WebSocket 连接端口，热重启生效", control: "srv-number" },
        { id: "srv.telnet_port", label: "Telnet 端口", description: "原始 Telnet 通道端口，热重启生效", control: "srv-number" },
        { id: "srv.enable_scripting", label: "远程脚本", description: "允许远程执行 JS 脚本（服务器无认证，开启后任何已连接的客户端都可执行脚本，可读写本机文件）", keywords: ["scripting", "脚本"], control: "srv-checkbox-scripting" },
        { id: "srv.script_log_to_disk", label: "脚本日志", description: "脚本的运行日志（log 函数的输出）自动落盘到 script-logs 目录", keywords: ["log", "日志"], control: "srv-checkbox-log" },
      ]
    : [
        { id: "conn.host", label: "主机", description: "要连接的 Serial Studio 服务地址", keywords: ["host", "服务器"], control: "conn-text" },
        { id: "conn.port", label: "端口", description: "服务的 WebSocket 端口", keywords: ["port"], control: "conn-number" },
      ];

  return [
    {
      id: "appearance",
      label: "外观",
      description: "主题与字号，改动立即生效。",
      keywords: ["appearance", "theme", "皮肤", "颜色", "配色", "字号", "字体"],
      items: [
        { id: "appearance.theme", label: "主题", description: "界面与终端配色，立即生效；Ctrl+Shift+L 可循环切换", keywords: ["theme", "dark", "light", "暗", "亮"], control: "theme-select" },
        { id: "appearance.font-size", label: "界面与终端字号", description: "全局字号（6–48），终端立即重排", keywords: ["font", "size", "zoom", "缩放"], control: "font-size-input" },
      ],
    },
    {
      id: "connection",
      label: "连接",
      description: showServer ? "本机服务监听配置，应用后热重启生效。" : "前端连接的 Serial Studio 服务，应用后重连。",
      keywords: ["connection", "server", "服务器", "端口", "串口服务"],
      items: connectionItems,
    },
    {
      id: "shortcuts",
      label: "快捷键",
      description: "点击键帽录制新组合；录制中 Backspace 清除、Esc 取消。",
      keywords: ["keyboard", "shortcut", "键", "改键", "热键"],
      items: shortcutGroups.flatMap((g) =>
        g.actions.map((action) => ({
          id: action,
          label: ACTION_LABELS[action],
          description: g.title,
          control: action === "tab.select" ? "shortcut-fixed" : "shortcut-action",
        })),
      ),
      shortcutGroups,
    },
    {
      id: "about",
      label: "关于",
      description: "版本、仓库与在线更新。",
      keywords: ["about", "version", "版本", "更新", "update", "仓库", "repo", "github"],
      items: [
        { id: "about.block", label: "Serial Studio", description: "版本信息与检查更新", control: "about-block" },
      ],
    },
  ];
}

export interface FilteredCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  /** 命中的普通条目（query 空时 = 全部） */
  items: SettingItemDef[];
  /** 命中的快捷键分组（仅 shortcuts 分类有值；query 空时 = 全部分组） */
  shortcutGroups: ShortcutGroupDef[];
}

/** 搜索过滤：子串匹配（大小写不敏感）。
 *  分类级命中（分类名/描述/关键词）→ 该分类全量展示；
 *  否则条目级命中逐条保留，快捷键分组内只保留命中的动作。 */
export function filterSettings(query: string, categories: SettingsCategoryDef[]): FilteredCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return categories.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      items: c.items,
      shortcutGroups: c.shortcutGroups ?? [],
    }));
  }
  const hit = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
  const itemHit = (item: SettingItemDef) =>
    hit(item.label) || hit(item.description) || (item.keywords ?? []).some(hit);
  const out: FilteredCategory[] = [];
  for (const c of categories) {
    const catHit =
      hit(c.label) || hit(c.description) || (c.keywords ?? []).some(hit);
    const items = catHit ? c.items : c.items.filter(itemHit);
    let groups: ShortcutGroupDef[] = [];
    if (c.shortcutGroups) {
      groups = catHit
        ? c.shortcutGroups
        : c.shortcutGroups
            .map((g) => ({ ...g, actions: g.actions.filter((a) => itemHit({ id: a, label: ACTION_LABELS[a], control: "" })) }))
            .filter((g) => g.actions.length > 0);
    }
    if (items.length > 0 || groups.length > 0) {
      out.push({ id: c.id, label: c.label, description: c.description, items, shortcutGroups: groups });
    }
  }
  return out;
}

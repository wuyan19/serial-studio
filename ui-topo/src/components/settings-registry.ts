/** 设置页声明式注册表（自 serial-studio ui 移植，条目换成 topo-hub 的设置面）。
 *  渲染在 settings-page.tsx 按 control 类型分发；状态全落在既有模块
 *  （theme + 服务器设置 props），注册表只描述「有什么」。
 *  新增设置项：在此加条目 + settings-page.tsx 的控件 switch 加分支即可被搜索和渲染。 */

export type SettingsCategoryId = "service" | "remote-access" | "appearance" | "about";

export interface SettingItemDef {
  id: string;
  label: string;
  description?: string;
  /** 搜索补充词（含英文别名，如 theme/dark/lease） */
  keywords?: string[];
  /** 控件种类（settings-page.tsx 内 switch 分发） */
  control: string;
}

export interface SettingsCategoryDef {
  id: SettingsCategoryId;
  label: string;
  /** 大标题下的分类描述 */
  description: string;
  /** 分类级搜索词：命中则整类全量展示 */
  keywords?: string[];
  items: SettingItemDef[];
}

export function buildSettingsCategories(): SettingsCategoryDef[] {
  return [
    {
      id: "service",
      label: "服务",
      description: "平台进程的监听与脚本、租约配置，应用后生效（监听地址/端口重启进程生效）。",
      keywords: ["server", "服务", "端口", "监听", "scripting", "脚本", "lease", "租约"],
      items: [
        { id: "srv.ws_host", label: "监听地址", description: "服务绑定的地址（重启进程生效）", control: "srv-text" },
        { id: "srv.ws_port", label: "服务端口", description: "Web 控制台与 MCP 的 HTTP/WS 端口（重启进程生效）", keywords: ["port"], control: "srv-number" },
        { id: "srv.enable_scripting", label: "远程脚本", description: "允许 Agent/远程客户端执行 JS 脚本（可读写本机文件）", keywords: ["scripting", "脚本"], control: "srv-checkbox-scripting" },
        { id: "lease.ttl_minutes", label: "租约时长", description: "设备占用租约的默认有效分钟数", keywords: ["lease", "ttl", "租约"], control: "lease-number" },
        { id: "lease.max_ttl_minutes", label: "租约上限", description: "单次申请/续租允许的最大分钟数", keywords: ["lease", "max", "租约"], control: "lease-number" },
        { id: "lease.enable_gate", label: "租约写闸", description: "开启后 I/O 工具须持设备租约才可写（推荐开启）", keywords: ["lease", "gate", "租约", "写闸"], control: "lease-checkbox" },
      ],
    },
    {
      id: "remote-access",
      label: "远程访问验证",
      description: "管理其他设备和浏览器访问本机连接时的验证。",
      keywords: ["access", "验证码", "二次认证", "安全", "保护范围", "TLS", "HTTPS", "撤销授权"],
      items: [
        { id: "srv.access", label: "远程访问验证", keywords: ["验证码", "刷新时间", "安全", "保护范围", "TLS", "HTTPS", "撤销授权"], control: "srv-access" },
      ],
    },
    {
      id: "appearance",
      label: "外观",
      description: "界面配色，改动立即生效。",
      keywords: ["appearance", "theme", "皮肤", "颜色", "配色"],
      items: [
        { id: "appearance.theme", label: "主题", description: "界面与终端配色，立即生效", keywords: ["theme", "dark", "light", "暗", "亮"], control: "theme-select" },
      ],
    },
    {
      id: "about",
      label: "关于",
      description: "版本与接入地址。",
      keywords: ["about", "version", "版本", "mcp", "接入"],
      items: [{ id: "about.block", label: "topo-hub", description: "版本信息与 MCP 接入地址", control: "about-block" }],
    },
  ];
}

export interface FilteredCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  /** 命中的普通条目（query 空时 = 全部） */
  items: SettingItemDef[];
}

/** 搜索过滤：子串匹配（大小写不敏感）。
 *  分类级命中（分类名/描述/关键词）→ 该分类全量展示；否则条目级命中逐条保留。 */
export function filterSettings(query: string, categories: SettingsCategoryDef[]): FilteredCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return categories.map(({ items, ...rest }) => ({ ...rest, items }));
  const hit = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
  const itemHit = (item: SettingItemDef) =>
    hit(item.label) || hit(item.description) || (item.keywords ?? []).some(hit);
  const out: FilteredCategory[] = [];
  for (const c of categories) {
    const catHit = hit(c.label) || hit(c.description) || (c.keywords ?? []).some(hit);
    const items = catHit ? c.items : c.items.filter(itemHit);
    if (items.length > 0) out.push({ id: c.id, label: c.label, description: c.description, items });
  }
  return out;
}

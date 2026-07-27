/**
 * 桌面原生菜单（B 层）：把 shortcuts.ts 的 global 绑定投影成菜单 + accelerator。
 *
 * ⚠ 当前未启用（dormant）：App.tsx 没有调用 setupAppMenu。原因——Windows 上建菜单会
 * 占一条菜单栏，而所有全局快捷键已由 App.tsx 的 listener 覆盖（菜单只是同一批动作的
 * 第二入口）。要启用：在 App.tsx mount 时调 setupAppMenu(dispatch)（web/远程自动 no-op）。
 *
 * 仅 isTauri() && !remote 时建。菜单项点击 / OS accelerator 触发 → 调用方传入的
 * dispatch(actionId)。改键时（subscribeBindings）→ 对应 menuItem.setAccelerator()，
 * action 闭包稳定（只 dispatch id），不必重建菜单。
 *
 * terminal 作用域（zoom 等）不进菜单——它们留在 xterm handler 里，不经此。
 * 参数化绑定（带 pattern，如 tab.select 一族键）也不进菜单——无单一 accelerator，
 * 且需要 arg，菜单项给不出；它们只走 App.tsx 的全局 listener。
 *
 * Tauri menu API 走动态 import（同 transport.ts 的 listen / lib.ts 的 tauriInvoke），
 * 避免在 web bundle 静态加载 @tauri-apps/api。
 *
 * 注：MenuItem 在类型位（顶部 import type）与值位（函数内动态 import 解构）各取一份，
 * 分属 TS 的类型/值两个名字空间，互不冲突。
 */
import type { ActionId } from "./types";
import type { MenuItem } from "@tauri-apps/api/menu";
import {
  ACTION_LABELS,
  comboToAccelerator,
  getBindings,
  subscribeBindings,
} from "./shortcuts";
import { getRemoteFromUrl, isTauri } from "./lib";

export type Dispatch = (action: ActionId, arg?: string) => void;

/** 菜单分组与顺序：[分组名, 动作列表]。仅 global 作用域子集。 */
const GROUPS: [string, ActionId[]][] = [
  ["视图", ["activity.toggle-ports", "activity.toggle-macros", "theme.toggle", "search.open"]],
  ["端口", ["port.refresh", "port.close-active"]],
  ["帮助", ["settings.open", "about.open"]],
];

/**
 * 建应用菜单。web/远程模式返回 null（无菜单、无副作用）。返回值为卸载订阅函数（桌面）。
 */
export async function setupAppMenu(dispatch: Dispatch): Promise<(() => void) | null> {
  if (!isTauri() || getRemoteFromUrl()) return null;

  const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
  const bindings = getBindings();
  const itemFor = new Map<ActionId, MenuItem>();

  const buildItem = async (action: ActionId): Promise<MenuItem> => {
    const accel = comboToAccelerator(bindings[action].combo) ?? undefined;
    const item = await MenuItem.new({
      id: action,
      text: ACTION_LABELS[action],
      accelerator: accel,
      action: () => dispatch(action),
    });
    itemFor.set(action, item);
    return item;
  };

  const groups: { text: string; items: MenuItem[] }[] = [];
  for (const [label, actions] of GROUPS) {
    const children: MenuItem[] = [];
    for (const a of actions) {
      if (bindings[a].pattern) continue; // 参数化动作（如 tab.select）无单一 accelerator，不进菜单
      children.push(await buildItem(a));
    }
    groups.push({ text: label, items: children });
  }

  const menu = await Menu.new({ items: groups });
  await menu.setAsAppMenu();

  // 改键 → 同步对应菜单项 accelerator（action 闭包不变，无需重建）
  const unsub = subscribeBindings((m) => {
    for (const [action, item] of itemFor) {
      const accel = comboToAccelerator(m[action].combo);
      // setAccelerator 失败（罕见符号键）静默忽略——listener 仍兜底该 combo
      item.setAccelerator(accel ?? null).catch(() => {});
    }
  });

  return unsub;
}

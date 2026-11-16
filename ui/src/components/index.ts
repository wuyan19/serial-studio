/** 组件目录 barrel：App 只从 "./components" 导入，不感知内部分文件。 */
export { ActivityIcon, CompositePortLabel, ConfigRow, GroupHead, InlineAliasInput, PortLabel, useDialogKeys, useEscClose } from "./primitives";
export { ContextMenu, type ContextMenuItem } from "./context-menu";
export { GroupView, SearchBar, TermView } from "./term";
export {
  ConfirmDialog,
  DeviceDetailDialog,
  type DeviceDetailInfo,
  PortDetailDialog,
  type PortDetailInfo,
  ExportMacrosDialog,
  ExportScriptsDialog,
  RemoteDialog,
  ScriptRunParamsDialog,
  ScriptSkillDialog,
  SerialConfigDialog,
  SshAuthDialog,
  SshManagerDialog,
  SshEditDialog,
  SshTrustDialog,
  sshAuthLabel,
} from "./dialogs";
export { SettingsPage } from "./settings-page";
export { buildSettingsCategories, filterSettings, type SettingsCategoryId } from "./settings-registry";
export { MacroPalette, PortPalette, ScriptPalette } from "./palettes";
export { MacroEditor, ScriptEditor, newStep, validateMacro } from "./editors";
export { RunCards, type RunCardView } from "./run-cards";

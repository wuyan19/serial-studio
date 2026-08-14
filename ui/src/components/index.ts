/** 组件目录 barrel：App 只从 "./components" 导入，不感知内部分文件。 */
export { ActivityIcon, ConfigRow, GroupHead, InlineAliasInput, PortLabel, useDialogKeys, useEscClose } from "./primitives";
export { GroupView, SearchBar, TermView } from "./term";
export {
  AboutDialog,
  ConfirmDialog,
  ExportMacrosDialog,
  ExportScriptsDialog,
  RemoteDialog,
  ScriptRunParamsDialog,
  ScriptSkillDialog,
  SerialConfigDialog,
  SettingsPanel,
  ShortcutsDialog,
} from "./dialogs";
export { MacroPalette, PortPalette, ScriptPalette } from "./palettes";
export { MacroEditor, ScriptEditor, newStep, validateMacro } from "./editors";
export { RunCards, type RunCardView } from "./run-cards";

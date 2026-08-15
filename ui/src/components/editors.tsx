/** 编辑器族：宏编辑器（步骤编排）与脚本编辑器（JS 代码），结构/样式互为镜像。
newStep/validateMacro 是宏步骤的纯函数入口（App 导入宏 spec 用）。 */
import { useEffect, useRef, useState } from "react";
import type { Macro, MacroStep, Script, ScriptParam, StepType } from "../types";
import { downloadJson, parseParamsFromCode } from "../lib";
import { IconAlert, IconBolt, IconChevronDown, IconChevronUp, IconClose, IconCode, IconCopy, IconExpand, IconExport, IconGrip, IconInfo, IconPlus, IconTrash } from "../icons";
import { getTheme, subscribe, themeDefOf, type Theme } from "../theme";
import { ConfigRow, useDialogA11y, useEscClose } from "./primitives";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// ===== CodeMirror 主题:容器底色走 CSS 变量(跟随应用主题),语法色复用终端 ANSI 调色板 =====

const cmBaseTheme = EditorView.theme({
  "&": {
    height: "320px",
    fontSize: "12.5px",
    backgroundColor: "transparent",
    border: "1px solid var(--hairline)",
    borderRadius: "var(--r-md, 8px)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  /* gutter 必须不透明:透明时横向滚动的内容会从行号底下透过去,视觉重叠 */
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--ink-faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(127, 127, 127, 0.07)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
});

/** 按主题生成 CM 的选中底色 + 语法高亮扩展——色值全部来自 theme.ts 注册表
 *  (term.selectionBackground 复用为 CM 选中底色,cm 色板与终端 ANSI 同源),
 *  tag→色的映射关系集中在这里,新增主题无需改本文件。
 *  结果按主题缓存(HighlightStyle/EditorView.theme 惰性单例):编辑器按键
 *  高频重渲染不再重复 define,也保住扩展数组引用稳定。 */
const cmThemeCache = new Map<Theme, ReturnType<typeof buildCmThemeExtensions>>();

function cmThemeExtensions(th: Theme) {
  let ext = cmThemeCache.get(th);
  if (!ext) {
    ext = buildCmThemeExtensions(th);
    cmThemeCache.set(th, ext);
  }
  return ext;
}

function buildCmThemeExtensions(th: Theme) {
  const def = themeDefOf(th);
  return [
    EditorView.theme(
      {
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: def.term.selectionBackground ?? "transparent",
        },
      },
      { dark: def.lum === "dark" }
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: def.cm.keyword },
        { tag: [t.string, t.special(t.string)], color: def.cm.string },
        { tag: [t.number, t.bool], color: def.cm.number },
        { tag: [t.comment, t.lineComment, t.blockComment], color: def.cm.comment, fontStyle: "italic" },
        { tag: [t.function(t.variableName), t.function(t.propertyName)], color: def.cm.func },
        { tag: [t.className, t.typeName], color: def.cm.type },
        { tag: [t.definition(t.variableName)], color: def.cm.defVar },
      ])
    ),
  ];
}

// ===== 宏编辑器 =====

export function newStep(type: StepType): MacroStep {
  switch (type) {
    case "send":
      return { type: "send", data: "", format: "text", auto_newline: true };
    case "delay":
      return { type: "delay", ms: 500 };
    case "expect":
      return { type: "expect", pattern: "", timeout_ms: 3000 };
    case "clear":
      return { type: "clear" };
  }
}

export function validateMacro(m: Macro): string | null {
  if (m.steps.length === 0) return "至少需要一个步骤";
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i];
    const tag = `步骤 ${i + 1}`;
    switch (s.type) {
      case "send":
        if (!s.data.trim()) return `${tag}：send 数据不能为空`;
        break;
      case "delay":
        if (!s.ms || s.ms <= 0) return `${tag}：delay 毫秒须 > 0`;
        break;
      case "expect":
        if (!s.pattern.trim()) return `${tag}：expect 匹配模式不能为空`;
        if (!s.timeout_ms || s.timeout_ms <= 0) return `${tag}：expect 超时须 > 0`;
        break;
    }
  }
  return null;
}

const STEP_TAG: Record<StepType, string> = { send: "SEND", delay: "DELAY", expect: "EXPECT", clear: "CLEAR" };

function StepGlyph({ type }: { type: StepType }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "send":
      return (
        <svg {...common}>
          <path d="M4 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case "delay":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="7.5" />
          <path d="M12 9.5v3.6l2.4 1.5" />
          <path d="M9.5 3.5h5" />
        </svg>
      );
    case "expect":
      return (
        <svg {...common}>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      );
    case "clear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M6.5 6.5l11 11" />
        </svg>
      );
  }
}

export function MacroEditor({
  name,
  macro,
  error,
  isNew,
  groups,
  onName,
  onMacroChange,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  macro: Macro;
  error: string;
  isNew: boolean;
  groups: string[];
  onName: (s: string) => void;
  onMacroChange: (m: Macro) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  useEscClose(onCancel);
  const [maximized, setMaximized] = useState(false);
  const setDesc = (description: string) => onMacroChange({ ...macro, description });
  const setGroup = (group: string) => onMacroChange({ ...macro, group: group || undefined });
  const setStep = (i: number, s: MacroStep) => {
    const steps = macro.steps.slice();
    steps[i] = s;
    onMacroChange({ ...macro, steps });
  };
  const addStep = (type: StepType) => onMacroChange({ ...macro, steps: [...macro.steps, newStep(type)] });
  const removeStep = (i: number) => onMacroChange({ ...macro, steps: macro.steps.filter((_, j) => j !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= macro.steps.length) return;
    const steps = macro.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onMacroChange({ ...macro, steps });
  };

  const duplicateStep = (i: number) => {
    const steps = macro.steps.slice();
    steps.splice(i + 1, 0, JSON.parse(JSON.stringify(steps[i])) as MacroStep);
    onMacroChange({ ...macro, steps });
  };

  // 拖拽排序（HTML5 DnD）。落点按指针在上/下半区决定 before/after。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overAfter, setOverAfter] = useState(false);
  const resetDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
    setOverAfter(false);
  };
  const onStepDragStart = (_e: React.DragEvent, i: number) => setDragIndex(i);
  const onStepDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOverIndex(i);
    setOverAfter(e.clientY - rect.top > rect.height / 2);
  };
  const onStepDrop = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    if (dragIndex === null) {
      resetDrag();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    const steps = macro.steps.slice();
    const [moved] = steps.splice(dragIndex, 1);
    let at = i + (after ? 1 : 0);
    if (dragIndex < at) at -= 1;
    at = Math.max(0, Math.min(at, steps.length));
    steps.splice(at, 0, moved);
    onMacroChange({ ...macro, steps });
    resetDrag();
  };
  const dropPosFor = (i: number): "before" | "after" | null => {
    if (dragIndex === null || overIndex !== i) return null;
    return overAfter ? "after" : "before";
  };
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="宏编辑器" className={`dialog dialog--med dialog--macro${maximized ? " dialog--max" : ""}`} onClick={(e) => e.stopPropagation()}>
        <button className="dialog__max" onMouseDown={(e) => e.preventDefault() /* 不抢焦点 */} onClick={() => setMaximized((v) => !v)} title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化窗口"}>
          <IconExpand />
        </button>
        <div className="macro-editor__head">
          <h3 className="dialog__title">
            <IconBolt /> MACRO
          </h3>
          <div className="dialog__sub">{isNew ? "新增宏" : name}</div>
          <ConfigRow label="名称">
            <input value={name} onChange={(e) => onName(e.target.value)} className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
          </ConfigRow>
          <ConfigRow label="描述">
            <input value={macro.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" spellCheck={false} />
          </ConfigRow>
          <ConfigRow label="分组">
            <input value={macro.group ?? ""} list="macro-groups" onChange={(e) => setGroup(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
            <datalist id="macro-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </ConfigRow>
        </div>

        <div className="macro-editor__scroll">
          <div className="dialog__group-label" style={{ marginTop: 6 }}>
            步骤
          </div>
        {macro.steps.length === 0 && <p className="sidebar__empty">无步骤（点下方新增步骤）</p>}
        {macro.steps.map((s, i) => (
          <StepEditor
            key={i}
            step={s}
            index={i}
            total={macro.steps.length}
            onChange={(ns) => setStep(i, ns)}
            onRemove={() => removeStep(i)}
            onMoveUp={() => moveStep(i, -1)}
            onMoveDown={() => moveStep(i, 1)}
            onDuplicate={() => duplicateStep(i)}
            isDragging={dragIndex === i}
            dropPos={dropPosFor(i)}
            onDragStart={(e) => onStepDragStart(e, i)}
            onDragOver={(e) => onStepDragOver(e, i)}
            onDrop={(e) => onStepDrop(e, i)}
            onDragEnd={resetDrag}
          />
        ))}

        <div className="add-step-row">
          <button className="add-step" data-kind="send" onClick={() => addStep("send")}>
            <IconPlus /> 发送
          </button>
          <button className="add-step" data-kind="delay" onClick={() => addStep("delay")}>
            <IconPlus /> 延时
          </button>
          <button className="add-step" data-kind="expect" onClick={() => addStep("expect")}>
            <IconPlus /> 等待
          </button>
          <button className="add-step" data-kind="clear" onClick={() => addStep("clear")}>
            <IconPlus /> 清空
          </button>
        </div>

        {error && (
          <div className="editor-error">
            <IconAlert /> {error}
          </div>
        )}

        <details>
          <summary className="json-summary">JSON 预览（只读）</summary>
          <pre className="json-preview">{JSON.stringify(macro, null, 2)}</pre>
        </details>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn--ghost btn--icon"
              onMouseDown={(e) => e.preventDefault() /* 不抢焦点 */}
              onClick={async () => {
                const n = name.trim() || "macro";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: macro });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
              aria-label="导出为 JSON 文件"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button
                className="btn btn--danger btn--icon"
                onClick={onDelete}
                onMouseDown={(e) => e.preventDefault() /* 不抢焦点:dirty/删除确认取消后,焦点还原回正在编辑的输入框 */}
                title="删除"
                aria-label="删除"
              >
                <IconTrash />
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--ghost" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn--primary" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脚本编辑器：JS 代码编辑（CodeMirror 6 语法高亮），结构/样式镜像 MacroEditor。 */
export function ScriptEditor({
  name,
  script,
  error,
  isNew,
  groups,
  onName,
  onScriptChange,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  script: Script;
  error: string | null;
  isNew: boolean;
  groups: string[];
  onName: (v: string) => void;
  onScriptChange: (s: Script) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  useEscClose(onCancel);
  // 高亮配色跟随应用主题(与终端 ANSI 调色板同源)
  const [cmTheme, setCmTheme] = useState<Theme>(getTheme());
  useEffect(() => subscribe(setCmTheme), []);
  const [helpOpen, setHelpOpen] = useState(false);
  const setDesc = (description: string) => onScriptChange({ ...script, description });
  const setGroup = (group: string) => onScriptChange({ ...script, group: group || undefined });
  const setCode = (code: string) => {
    // code 含 // @param 声明 → 自动解析填参数区(AI 生成自包含脚本,粘贴即用)。无声明则不动 params。
    const parsed = parseParamsFromCode(code);
    onScriptChange(parsed ? { ...script, code, params: parsed } : { ...script, code });
  };
  const setParams = (params: ScriptParam[]) => onScriptChange({ ...script, params });
  const setParam = (i: number, p: ScriptParam) => {
    const params = (script.params ?? []).slice();
    params[i] = p;
    setParams(params);
  };
  const addParam = () => setParams([...(script.params ?? []), { name: "", type: "string" }]);
  const removeParam = (i: number) => setParams((script.params ?? []).filter((_, j) => j !== i));
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="脚本编辑器" className="dialog dialog--macro dialog--max" onClick={(e) => e.stopPropagation()}>
        <button
          className="dialog__max"
          onMouseDown={(e) => e.preventDefault() /* 不抢焦点 */}
          onClick={() => setHelpOpen((v) => !v)}
          title="可用 API 与参数说明"
          aria-label="可用 API 与参数说明"
          aria-expanded={helpOpen}
        >
          <IconInfo />
        </button>
        {helpOpen && <ScriptHelpPanel onClose={() => setHelpOpen(false)} />}
        <div className="macro-editor__head">
          <h3 className="dialog__title">
            <IconCode /> SCRIPT
          </h3>
          <div className="dialog__sub">{isNew ? "新增脚本" : name}</div>
          <ConfigRow label="名称">
            <input value={name} onChange={(e) => onName(e.target.value)} className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
          </ConfigRow>
          <ConfigRow label="描述">
            <input value={script.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" spellCheck={false} />
          </ConfigRow>
          <ConfigRow label="分组">
            <input value={script.group ?? ""} list="script-groups" onChange={(e) => setGroup(e.target.value)} placeholder="可选" className="field" autoCapitalize="off" autoComplete="off" spellCheck={false} />
            <datalist id="script-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </ConfigRow>
        </div>

        {/* 固定双栏布局(打开即最大化):左=代码(独立滚动,由 CodeMirror 内部 scroller 承担),
            右=参数+JSON 预览(独立 overflow-y 滚动)。两栏互不联动。 */}
        <div className="macro-editor__scroll script-editor__grid">
          <div className="script-editor__col-code">
            <div className="dialog__group-label" style={{ marginTop: 6 }}>
              代码
            </div>
            <div className="script-editor__cm">
              <CodeMirror
                value={script.code}
                onChange={setCode}
                theme={[cmBaseTheme, ...cmThemeExtensions(cmTheme)]}
                extensions={[javascript()]}
                height="100%"
                placeholder="// 在此编写 JS 脚本…"
              />
            </div>
            {error && (
              <div className="editor-error">
                <IconAlert /> {error}
              </div>
            )}
          </div>
          <div className="script-editor__col-side">
            {/* 标头固定不滚;真正可滚的是下方 side-scroll */}
            <div className="dialog__group-label script-editor__side-head">参数（运行时收集，脚本用 args.键名 读取）</div>
            <div className="script-editor__side-scroll">
              {(script.params ?? []).map((p, i) => (
                <ParamEditor key={i} param={p} onChange={(np) => setParam(i, np)} onRemove={() => removeParam(i)} />
              ))}
              <button className="btn btn--ghost macro-editor__add" onClick={addParam} title="新增参数">
                <IconPlus /> 新增参数
              </button>
              <details>
                <summary className="json-summary">JSON 预览（只读）</summary>
                <pre className="json-preview">{JSON.stringify(script, null, 2)}</pre>
              </details>
            </div>
          </div>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn--ghost btn--icon"
              onMouseDown={(e) => e.preventDefault() /* 不抢焦点 */}
              onClick={async () => {
                const n = name.trim() || "script";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: script });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
              aria-label="导出为 JSON 文件"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button
                className="btn btn--danger btn--icon"
                onClick={onDelete}
                onMouseDown={(e) => e.preventDefault() /* 不抢焦点:dirty/删除确认取消后,焦点还原回正在编辑的输入框 */}
                title="删除"
                aria-label="删除"
              >
                <IconTrash />
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--ghost" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn--primary" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脚本参数编辑卡片:字段行(键名/标签/类型/缺省)+ select 型的选项 chip 列表。
 *  选项:输入回车(或失焦)添加、点 × 移除;已有选项时缺省改从下拉里选,杜绝无效缺省。 */
function ParamEditor({ param, onChange, onRemove }: {
  param: ScriptParam;
  onChange: (p: ScriptParam) => void;
  onRemove: () => void;
}) {
  const isSelect = param.type === "select";
  const options = param.options ?? [];
  const [optInput, setOptInput] = useState("");
  const addOption = () => {
    const v = optInput.trim();
    setOptInput("");
    if (!v || options.includes(v)) return; // 空/重复静默忽略
    onChange({ ...param, options: [...options, v] });
  };
  const removeOption = (v: string) =>
    // 移除的恰是缺省值时一并清缺省,否则下拉残留无效项
    onChange({
      ...param,
      options: options.filter((o) => o !== v),
      default: param.default === v ? undefined : param.default,
    });
  return (
    <div className="param-card">
      <div className="param-card__row">
        <input className="field param-card__name" value={param.name}
          onChange={(e) => onChange({ ...param, name: e.target.value })} placeholder="键名（args.键名）" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        <input className="field param-card__label" value={param.label ?? ""}
          onChange={(e) => onChange({ ...param, label: e.target.value || undefined })} placeholder="标签（可选）" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        <select className="field param-card__type" value={param.type}
          onChange={(e) => onChange({ ...param, type: e.target.value as "string" | "select" })}>
          <option value="string">string</option>
          <option value="select">select</option>
        </select>
        {isSelect && options.length > 0 ? (
          <select className="field param-card__default" value={param.default ?? ""}
            onChange={(e) => onChange({ ...param, default: e.target.value || undefined })}>
            <option value="">默认（可选）</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input className="field param-card__default" value={param.default ?? ""}
            onChange={(e) => onChange({ ...param, default: e.target.value || undefined })} placeholder="默认（可选）" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        )}
        <button className="btn btn--danger btn--icon" onClick={onRemove} title="删除参数" aria-label="删除参数"><IconTrash /></button>
      </div>
      {isSelect && (
        <div className="param-card__options">
          <span className="param-card__options-label">选项</span>
          {options.map((o) => (
            <span key={o} className="param-chip">
              {o}
              <button className="param-chip__x" onClick={() => removeOption(o)} title={`移除 ${o}`} aria-label={`移除选项 ${o}`}>×</button>
            </span>
          ))}
          <input className="param-chip-add" value={optInput}
            onChange={(e) => setOptInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // 别把回车带给对话框(误触保存)
                addOption();
              }
            }}
            onBlur={addOption}
            placeholder="输入后回车添加" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </div>
      )}
    </div>
  );
}

function StepEditor({
  step,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  isDragging,
  dropPos,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  step: MacroStep;
  index: number;
  total: number;
  onChange: (s: MacroStep) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  isDragging: boolean;
  dropPos: "before" | "after" | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const changeType = (type: StepType) => {
    if (type === step.type) return;
    onChange(newStep(type));
  };

  const cardRef = useRef<HTMLDivElement>(null);
  const onGripDragStart = (e: React.DragEvent) => {
    // 必须写 dataTransfer，否则部分浏览器/webview 会取消拖拽
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 14, 14);
    onDragStart(e);
  };

  return (
    <div
      ref={cardRef}
      className="step-card"
      data-kind={step.type}
      data-dragging={isDragging ? "true" : undefined}
      data-drop={dropPos ?? undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="step-head">
        <span
          className="step-grip"
          title="拖动排序"
          draggable
          onDragStart={onGripDragStart}
          onDragEnd={onDragEnd}
        >
          <IconGrip />
        </span>
        <span className="step-num">#{String(index + 1).padStart(2, "0")}</span>
        <span className="step-tag">
          <StepGlyph type={step.type} />
          {STEP_TAG[step.type]}
        </span>
        <select value={step.type} onChange={(e) => changeType(e.target.value as StepType)} className="field-select" style={{ flex: "0 0 auto", width: 92 }}>
          <option value="send">发送</option>
          <option value="delay">延时</option>
          <option value="expect">等待</option>
          <option value="clear">清空</option>
        </select>
        <div className="step-head__spacer" />
        <div className="step-actions">
          <button onClick={onDuplicate} title="复制" aria-label={`复制步骤 ${index + 1}`} className="mini-btn">
            <IconCopy />
          </button>
          <button onClick={onMoveUp} disabled={index === 0} title="上移" aria-label={`上移步骤 ${index + 1}`} className="mini-btn">
            <IconChevronUp />
          </button>
          <button onClick={onMoveDown} disabled={index === total - 1} title="下移" aria-label={`下移步骤 ${index + 1}`} className="mini-btn">
            <IconChevronDown />
          </button>
          <button onClick={onRemove} title="删除" aria-label={`删除步骤 ${index + 1}`} className="mini-btn mini-btn--danger">
            <IconClose />
          </button>
        </div>
      </div>
      <div className="step-body">
        {step.type === "send" && (
          <>
            <textarea value={step.data} onChange={(e) => onChange({ ...step, data: e.target.value })} placeholder="发送内容" rows={1} className="field-textarea" autoCapitalize="off" spellCheck={false} />
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
              <label className="inline-label">
                格式
                <select value={step.format} onChange={(e) => onChange({ ...step, format: e.target.value })} className="field-select" style={{ marginLeft: 6, flex: "0 0 auto", width: 74 }}>
                  <option value="text">text</option>
                  <option value="hex">hex</option>
                </select>
              </label>
              <label className="inline-label">
                <input type="checkbox" checked={step.auto_newline} onChange={(e) => onChange({ ...step, auto_newline: e.target.checked })} />
                自动换行（按端口设置）
              </label>
            </div>
          </>
        )}
        {step.type === "delay" && (
          <label className="inline-label">
            等待
            <input type="number" value={step.ms} onChange={(e) => onChange({ ...step, ms: Number(e.target.value) })} min={1} className="field" style={{ display: "inline-block", width: 84, margin: "0 6px" }} autoCapitalize="off" spellCheck={false} />
            毫秒
          </label>
        )}
        {step.type === "expect" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
            <label className="inline-label" style={{ flex: 1, minWidth: 140, flexDirection: "column", alignItems: "stretch" }}>
              等待匹配
              <input value={step.pattern} onChange={(e) => onChange({ ...step, pattern: e.target.value })} placeholder="正则 / 子串" className="field" style={{ display: "block", marginTop: 4 }} autoCapitalize="off" spellCheck={false} />
            </label>
            <label className="inline-label">
              超时
              <input type="number" value={step.timeout_ms} onChange={(e) => onChange({ ...step, timeout_ms: Number(e.target.value) })} min={1} className="field" style={{ display: "inline-block", width: 74, margin: "0 6px" }} autoCapitalize="off" spellCheck={false} />
              ms
            </label>
          </div>
        )}
        {step.type === "clear" && <div className="step-body__note">清空接收缓冲区</div>}
      </div>
    </div>
  );
}


/** 帮助速查浮层:独立组件以获得对话框栈/Esc/焦点圈闭——内联在编辑器里会变成伪模态
 *  (Esc 关掉的是编辑器、Tab 钻到遮罩底下)。挂载晚于编辑器 → 栈顶,Esc 先关它。 */
function ScriptHelpPanel({ onClose }: { onClose: () => void }) {
  useEscClose(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref);
  return (
    <>
      {/* 点击面板外(对话框内区域)关闭 */}
      <div className="script-help__backdrop" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="可用 API 与参数速查" className="script-help">
        <div className="script-help__head">
          <span>速查 · 详见「脚本编写指南」</span>
          <button className="banner__close" onClick={onClose} aria-label="关闭帮助">
            <IconClose />
          </button>
        </div>
        <div className="script-help__row"><code>await send(data, [port])</code></div>
        <div className="script-help__row"><code>await expect(pattern, ms, [port])</code></div>
        <div className="script-help__row"><code>await clear([port])</code></div>
        <div className="script-help__row"><code>await sleep(ms)</code></div>
        <div className="script-help__row"><code>log(data)</code></div>
        <div className="script-help__row"><code>args.键名</code></div>
        <div className="script-help__row"><code>// @param 名 string default=值</code></div>
        <div className="script-help__row"><code>// @param 名 select A|B default=A</code></div>
      </div>
    </>
  );
}

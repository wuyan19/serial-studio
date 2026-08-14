/** 编辑器族：宏编辑器（步骤编排）与脚本编辑器（JS 代码），结构/样式互为镜像。
newStep/validateMacro 是宏步骤的纯函数入口（App 导入宏 spec 用）。 */
import { useRef, useState } from "react";
import type { Macro, MacroStep, Script, ScriptParam, StepType } from "../types";
import { downloadJson, parseParamsFromCode } from "../lib";
import { IconAlert, IconBolt, IconChevronDown, IconChevronUp, IconClose, IconCode, IconCopy, IconExport, IconGrip, IconPlus, IconTrash } from "../icons";
import { ConfigRow, useEscClose } from "./primitives";

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

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--macro" onClick={(e) => e.stopPropagation()}>
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
        {macro.steps.length === 0 && <p className="sidebar__empty">无步骤（点下方添加）</p>}
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
              onClick={async () => {
                const n = name.trim() || "macro";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: macro });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button className="btn btn--danger btn--icon" onClick={onDelete} title="删除">
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

/** 脚本编辑器：JS 代码编辑（textarea），结构/样式镜像 MacroEditor。 */
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

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--med dialog--macro" onClick={(e) => e.stopPropagation()}>
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

        <div className="macro-editor__scroll">
          <div className="dialog__group-label" style={{ marginTop: 6 }}>
            代码
          </div>
          <div className="script-editor__hint">await send(data, [port]) · await expect(pattern, ms, [port]) · await clear([port]) · await sleep(ms) · log(data)</div>
          <div className="script-editor__hint">[port] 可选,缺省为当前活动端口,可指定其它已打开端口(跨多串口操作)</div>
          <textarea
            value={script.code}
            onChange={(e) => setCode(e.target.value)}
            className="field script-editor__code"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="// 在此编写 JS 脚本…"
            style={{
              fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
              minHeight: 300,
              resize: "vertical",
              width: "100%",
            }}
          />

          <div className="dialog__group-label" style={{ marginTop: 12 }}>
            参数(运行时收集,脚本用 args.键名 读取)
          </div>
          <div className="script-editor__hint">string=文本框;select=下拉(选项以 chip 方式添加/移除,缺省从选项中选)。无参数则直接运行不弹窗。</div>
          {(script.params ?? []).map((p, i) => (
            <ParamEditor key={i} param={p} onChange={(np) => setParam(i, np)} onRemove={() => removeParam(i)} />
          ))}
          <button className="btn btn--ghost macro-editor__add" onClick={addParam} title="新增参数">
            <IconPlus /> 新增参数
          </button>

        {error && (
          <div className="editor-error">
            <IconAlert /> {error}
          </div>
        )}

        <details>
          <summary className="json-summary">JSON 预览（只读）</summary>
          <pre className="json-preview">{JSON.stringify(script, null, 2)}</pre>
        </details>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn--ghost btn--icon"
              onClick={async () => {
                const n = name.trim() || "script";
                try {
                  await downloadJson(`${n.replace(/[<>:"/\\|?*]/g, "_")}.json`, { [n]: script });
                } catch (e) {
                  console.error("导出失败", e);
                }
              }}
              title="导出为 JSON 文件（可分享 / 导入）"
            >
              <IconExport />
            </button>
            {!isNew && (
              <button className="btn btn--danger btn--icon" onClick={onDelete} title="删除">
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
          onChange={(e) => onChange({ ...param, name: e.target.value })} placeholder="键名(args.键名)" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        <input className="field param-card__label" value={param.label ?? ""}
          onChange={(e) => onChange({ ...param, label: e.target.value || undefined })} placeholder="标签(可选)" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        <select className="field param-card__type" value={param.type}
          onChange={(e) => onChange({ ...param, type: e.target.value as "string" | "select" })}>
          <option value="string">string</option>
          <option value="select">select</option>
        </select>
        {isSelect && options.length > 0 ? (
          <select className="field param-card__default" value={param.default ?? ""}
            onChange={(e) => onChange({ ...param, default: e.target.value || undefined })}>
            <option value="">缺省(可选)</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input className="field param-card__default" value={param.default ?? ""}
            onChange={(e) => onChange({ ...param, default: e.target.value || undefined })} placeholder="缺省(可选)" autoCapitalize="off" autoComplete="off" spellCheck={false} />
        )}
        <button className="btn btn--danger btn--icon" onClick={onRemove} title="删除参数"><IconTrash /></button>
      </div>
      {isSelect && (
        <div className="param-card__options">
          <span className="param-card__options-label">选项</span>
          {options.map((o) => (
            <span key={o} className="param-chip">
              {o}
              <button className="param-chip__x" onClick={() => removeOption(o)} title={`移除 ${o}`}>×</button>
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
          <button onClick={onDuplicate} title="复制" className="mini-btn">
            <IconCopy />
          </button>
          <button onClick={onMoveUp} disabled={index === 0} title="上移" className="mini-btn">
            <IconChevronUp />
          </button>
          <button onClick={onMoveDown} disabled={index === total - 1} title="下移" className="mini-btn">
            <IconChevronDown />
          </button>
          <button onClick={onRemove} title="删除" className="mini-btn mini-btn--danger">
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


/** 运行卡片（宏/脚本共用）：running 显示停止按钮，done 显示结果；脚本可展开实时日志。 */
// ===== 运行卡片（宏/脚本共用） =====

/** 运行卡片视图模型：宏卡片无 logs，脚本卡片带实时 logs（结构兼容两种 RunCard 类型）。 */
export interface RunCardView {
  name: string;
  devId: string;
  status: "running" | "done";
  success?: boolean;
  message?: string;
  logs?: string[];
  /** 暂停态(仅脚本):驱动 暂停/继续 按钮文案与状态文本。 */
  paused?: boolean;
}

/** 运行卡片列表（宏/脚本共用）：running 显示「⟳ 名称 + 停止」；done 显示结果行（✓/✗ + 关闭）。
 *  hasLogs=true（脚本）时卡片头可点开实时/完整日志，一次展开一张卡。
 *  onPauseToggle 提供时（仅脚本面板）running 卡额外显示 暂停/继续 按钮；宏不支持暂停。 */
export function RunCards({
  runs,
  kindLabel,
  hasLogs,
  expandedLog,
  onToggleExpand,
  onStop,
  onPauseToggle,
  onDismiss,
}: {
  runs: Map<string, RunCardView>;
  /** 中文名（「宏」/「脚本」），停止按钮 title 用。 */
  kindLabel: string;
  hasLogs: boolean;
  expandedLog: string | null;
  onToggleExpand: (runId: string) => void;
  onStop: (runId: string, devId: string) => void;
  /** 暂停/继续切换(仅脚本面板提供)。nextPaused = 目标态(当前未暂停 → 暂停)。 */
  onPauseToggle?: (runId: string, nextPaused: boolean) => void;
  onDismiss: (runId: string) => void;
}) {
  return (
    <>
      {[...runs.entries()].map(([runId, card]) => {
        const logs = hasLogs ? card.logs ?? [] : [];
        return (
          <div
            key={runId}
            className={
              card.status === "running"
                ? `script-task${hasLogs && expandedLog === runId ? " script-task--open" : ""}`
                : `script-task script-task--${card.success ? "ok" : "err"}`
            }
          >
            {card.status === "running" ? (
              <>
                <div
                  className="script-task__head"
                  title={`${card.name} ${card.paused ? "已暂停" : "运行中"}`}
                  {...expandableHeadProps(runId, card.name, hasLogs, expandedLog === runId, onToggleExpand)}
                >
                  <span className="script-task__name" title={card.name}>{card.paused ? "⏸" : "⟳"} {card.name}</span>
                  <span className="script-task__status">{card.paused ? "已暂停" : "运行中…"}</span>
                  {onPauseToggle && (
                    <button
                      className="script-task__pause"
                      title={card.paused ? `继续${kindLabel}` : `暂停${kindLabel}（冻结于当前位置，可继续）`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPauseToggle(runId, !card.paused);
                      }}
                    >{card.paused ? "继续" : "暂停"}</button>
                  )}
                  <button
                    className="script-task__stop"
                    title={`停止${kindLabel}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStop(runId, card.devId);
                    }}
                  >停止</button>
                </div>
                {hasLogs && expandedLog === runId && (
                  <div className="script-log-list script-log-list--live">
                    {logs.length === 0 && (
                      <div className="script-log-list__line script-log-list__line--muted">（等待 log 输出…）</div>
                    )}
                    {logs.map((line, i) => (
                      <div key={i} className="script-log-list__line">{line}</div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  className="script-task__head"
                  {...expandableHeadProps(runId, card.name, logs.length > 0, expandedLog === runId, onToggleExpand)}
                >
                  <span className="script-task__msg">{card.success ? "✓" : "✗"} {card.name}: {card.message}</span>
                  <button
                    className="macro-result__close"
                    title="关闭"
                    aria-label="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(runId);
                    }}
                  >×</button>
                </div>
                {expandedLog === runId && logs.length > 0 && (
                  <div className="script-log-list">
                    {logs.map((line, i) => (
                      <div key={i} className="script-log-list__line">{line}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** 可展开卡头的公共交互属性(点击/Enter/Space 展开 + role/aria),expandable=false 时不注入。
 *  running 卡(有日志)与 done 卡(有日志)两分支共用,避免逐字复制键盘处理块。 */
function expandableHeadProps(
  runId: string,
  name: string,
  expandable: boolean,
  expanded: boolean,
  onToggleExpand: (id: string) => void
) {
  if (!expandable) return {};
  return {
    onClick: () => onToggleExpand(runId),
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `展开 ${name} 日志`,
    "aria-expanded": expanded,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggleExpand(runId);
      }
    },
  };
}


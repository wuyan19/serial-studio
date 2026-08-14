/** 命令面板族：宏（Ctrl+O）、脚本（Ctrl+B）、串口（Ctrl+I）。模糊搜索 + 键盘导航。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Macro, PortId, PortInfo, Script } from "../types";
import { PortLabel } from "./primitives";

// ===== 宏命令面板（Ctrl+O） =====

/** 模糊匹配：查询字符按序出现在 target 里即命中（大小写不敏感）。
 *  返回 {score, first}：score = 匹配字符间间隙累加（越小越紧凑），first = 首个命中下标（越靠前越好）。 */
function fuzzyMatch(query: string, target: string): { score: number; first: number } | null {
  if (!query) return { score: 0, first: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -1;
  let first = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first === -1) first = ti;
      else score += ti - last - 1;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? { score, first: first === -1 ? 0 : first } : null;
}

/** 宏命令面板：顶部搜索框 + 模糊过滤的宏列表，方向键选择，回车执行。
 *  模态打开时 App 的全局 listener 已被抑制；这里在输入框上自处理方向键 / 回车 / Esc。 */
export function MacroPalette({
  macros,
  activePort,
  onRun,
  onClose,
}: {
  macros: Record<string, Macro>;
  activePort: string;
  onRun: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { name: string; score: number; first: number }[] = [];
    for (const name of Object.keys(macros)) {
      const m = fuzzyMatch(query, name);
      if (m) matched.push({ name, score: m.score, first: m.first });
    }
    matched.sort(
      (a, b) => a.score - b.score || a.first - b.first || a.name.localeCompare(b.name)
    );
    return matched.map((x) => x.name);
  }, [macros, query]);

  // 查询变化 → 回到首项、清提示
  useEffect(() => {
    setSelected(0);
    setHint("");
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (name: string) => {
    if (!activePort) {
      setHint("先打开一个端口再运行宏");
      return;
    }
    onRun(name);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const name = filtered[selected] ?? filtered[0];
      if (name) commit(name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索宏…（${Object.keys(macros).length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配宏</div>}
          {filtered.map((name, i) => (
            <button
              type="button"
              key={name}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(name)}
            >
              <span className="palette__name">{name}</span>
              {macros[name].description && (
                <span className="palette__desc">{macros[name].description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="palette__footer">
          {hint ? (
            <span className="palette__hint">{hint}</span>
          ) : activePort ? (
            <span>↑↓ 选择 · 回车运行</span>
          ) : (
            <span className="palette__hint palette__hint--faint">未打开端口</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== 脚本选择面板（Ctrl+B）=====
/** 脚本选择面板：模糊搜索脚本，方向键选择，回车运行。镜像 MacroPalette。 */
export function ScriptPalette({
  scripts,
  activePort,
  onRun,
  onClose,
}: {
  scripts: Record<string, Script>;
  activePort: string;
  onRun: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { name: string; score: number; first: number }[] = [];
    for (const name of Object.keys(scripts)) {
      const m = fuzzyMatch(query, name);
      if (m) matched.push({ name, score: m.score, first: m.first });
    }
    matched.sort(
      (a, b) => a.score - b.score || a.first - b.first || a.name.localeCompare(b.name)
    );
    return matched.map((x) => x.name);
  }, [scripts, query]);

  // 查询变化 → 回到首项、清提示
  useEffect(() => {
    setSelected(0);
    setHint("");
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (name: string) => {
    if (!activePort) {
      setHint("先打开一个端口再运行脚本");
      return;
    }
    onRun(name);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const name = filtered[selected] ?? filtered[0];
      if (name) commit(name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索脚本…（${Object.keys(scripts).length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配脚本</div>}
          {filtered.map((name, i) => (
            <button
              type="button"
              key={name}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(name)}
            >
              <span className="palette__name">{name}</span>
              {scripts[name].description && (
                <span className="palette__desc">{scripts[name].description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="palette__footer">
          {hint ? (
            <span className="palette__hint">{hint}</span>
          ) : activePort ? (
            <span>↑↓ 选择 · 回车运行</span>
          ) : (
            <span className="palette__hint palette__hint--faint">未打开端口</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== 串口选择面板（Ctrl+I）=====

/** 串口选择面板：模糊搜索端口，方向键选择，回车打开（onSelect 走与点端口行同一流程）。 */
export function PortPalette({
  ports,
  onSelect,
  onClose,
}: {
  ports: (PortInfo & { pid: PortId })[];
  onSelect: (pid: PortId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const matched: { pid: PortId; score: number; first: number }[] = [];
    for (const p of ports) {
      const hay = p.alias ? `${p.alias} ${p.name}` : p.name;
      const m = fuzzyMatch(query, hay);
      if (m) matched.push({ pid: p.pid, score: m.score, first: m.first });
    }
    matched.sort((a, b) => a.score - b.score || a.first - b.first || a.pid.localeCompare(b.pid));
    return matched.map((x) => x.pid);
  }, [ports, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const byPid = useMemo(() => {
    const m: Record<string, PortInfo> = {};
    for (const p of ports) m[p.pid] = p;
    return m;
  }, [ports]);

  const commit = (pid: PortId) => {
    onSelect(pid);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pid = filtered[selected] ?? filtered[0];
      if (pid) commit(pid);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={`搜索串口…（${ports.length} 个）`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">无匹配串口</div>}
          {filtered.map((pid, i) => (
            <button
              type="button"
              key={pid}
              className={"palette__item" + (i === selected ? " palette__item--selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => commit(pid)}
            >
              <span className="palette__name">
                <PortLabel name={byPid[pid]?.name ?? pid} alias={byPid[pid]?.alias} />
              </span>
            </button>
          ))}
        </div>
        <div className="palette__footer">
          <span>↑↓ 选择 · 回车打开</span>
        </div>
      </div>
    </div>
  );
}


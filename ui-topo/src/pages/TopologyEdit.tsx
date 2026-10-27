import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type MemberInput, type PortView, type Topology } from "../api";

/** 成员编辑行：键（datalist 给端口/设备建议）+ 备注。 */
function MemberRow({
  value,
  onChange,
  onRemove,
  suggestions,
}: {
  value: MemberInput;
  onChange: (v: MemberInput) => void;
  onRemove: () => void;
  suggestions: string[];
}) {
  return (
    <div className="member-row">
      <input
        list="member-keys"
        className="mono"
        placeholder="设备 id 或端口键（如 sshUuid、sshUuid::shell、COM3）"
        value={value.key}
        onChange={(e) => onChange({ ...value, key: e.target.value })}
      />
      <input
        placeholder="备注（可选）"
        value={value.note ?? ""}
        onChange={(e) => onChange({ ...value, note: e.target.value || undefined })}
      />
      <button className="link" onClick={onRemove}>
        移除
      </button>
      <datalist id="member-keys">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export default function TopologyEdit() {
  const { id } = useParams();
  const editing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<MemberInput[]>([{ key: "" }]);
  const [ports, setPorts] = useState<PortView[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.ports().then(setPorts).catch(() => {});
    if (!editing) return;
    api
      .topology(id!)
      .then((t: Topology) => {
        setName(t.name);
        setDescription(t.description);
        setMembers(t.members.map((m) => ({ key: m.key, note: m.note })));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id, editing]);

  /** 建议清单：设备 id（去重）+ 端口键。 */
  const suggestions = useMemo(() => {
    const ids = new Set<string>();
    for (const p of ports) {
      if (p.device && p.device.id !== "local") ids.add(p.device.id);
    }
    return [...ids, ...ports.map((p) => p.name)];
  }, [ports]);

  const save = async () => {
    setSaving(true);
    setError("");
    const body = {
      name,
      description,
      members: members.filter((m) => m.key.trim()),
    };
    try {
      const t = editing
        ? await api.updateTopology(id!, body)
        : await api.createTopology(body);
      navigate(`/topologies/${t.id}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="page-head">
        <h1>{editing ? "编辑拓扑" : "新建拓扑"}</h1>
      </div>
      <div className="form">
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="同表唯一；AI 经 MCP 按名称或 id 引用"
          />
        </label>
        <label>
          描述
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="用途说明（可选）"
          />
        </label>
        <div>
          <div className="form-label">成员</div>
          {members.map((m, i) => (
            <MemberRow
              key={i}
              value={m}
              suggestions={suggestions}
              onChange={(v) => setMembers(members.map((x, j) => (i === j ? v : x)))}
              onRemove={() => setMembers(members.filter((_, j) => j !== i))}
            />
          ))}
          <button className="link" onClick={() => setMembers([...members, { key: "" }])}>
            + 添加成员
          </button>
          <p className="muted">
            设备 id = 该设备全部端点；端口键 = 单端点。可输入别名，保存时服务端定型。
          </p>
        </div>
        {error && <p className="error whitespace">{error}</p>}
        <div className="row-actions">
          <button className="btn" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button className="btn secondary" onClick={() => navigate(-1)}>
            返回
          </button>
        </div>
      </div>
    </section>
  );
}

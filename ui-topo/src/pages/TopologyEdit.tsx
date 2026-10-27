/** 拓扑编辑：成员=被测设备引用（下拉选设备），连线=成员设备间。 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Device, type LinkInput, type MemberInput, type Topology } from "../api";

export default function TopologyEdit() {
  const { id } = useParams();
  const editing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<MemberInput[]>([]);
  const [links, setLinks] = useState<LinkInput[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.devices().then(setDevices).catch(() => {});
    if (!editing) return;
    api
      .topology(id!)
      .then((t: Topology) => {
        setName(t.name);
        setDescription(t.description);
        setMembers(t.members.map((m) => ({ device: m.device, note: m.note })));
        setLinks(t.links.map((l) => ({ from: l.from, to: l.to, label: l.label })));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id, editing]);

  const devName = useMemo(
    () => new Map(devices.map((d) => [d.id, d.name])),
    [devices],
  );
  /** 连线选单：成员设备（id 显示名）。 */
  const memberOptions = members
    .filter((m) => m.device)
    .map((m) => ({ id: m.device, name: devName.get(m.device) ?? m.device }));

  const save = async () => {
    setSaving(true);
    setError("");
    const body = {
      name,
      description,
      members: members.filter((m) => m.device),
      links: links.filter((l) => l.from && l.to),
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
    <section className="page">
      <div className="page-head">
        <h1>{editing ? "编辑拓扑" : "新建拓扑"}</h1>
      </div>
      <div className="form">
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="同表唯一；AI 经 MCP 按名称或 id 引用" />
        </label>
        <label>
          描述
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用途说明（可选）" />
        </label>
        <div>
          <div className="form-label">成员设备</div>
          {members.map((m, i) => (
            <div className="member-row" key={i}>
              <select
                value={m.device}
                onChange={(e) =>
                  setMembers(members.map((x, j) => (i === j ? { ...x, device: e.target.value } : x)))
                }
              >
                <option value="">选设备…</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <input
                placeholder="备注（可选）"
                value={m.note ?? ""}
                onChange={(e) =>
                  setMembers(members.map((x, j) => (i === j ? { ...x, note: e.target.value || undefined } : x)))
                }
              />
              <button className="link" onClick={() => setMembers(members.filter((_, j) => j !== i))}>
                移除
              </button>
            </div>
          ))}
          <button className="link" onClick={() => setMembers([...members, { device: "" }])}>
            + 添加成员
          </button>
          {devices.length === 0 && (
            <p className="muted">暂无被测设备——先到「设备」页注册（成员只能引用已注册设备）。</p>
          )}
        </div>
        <div>
          <div className="form-label">连线</div>
          {links.map((l, i) => (
            <div className="link-row" key={i}>
              <select
                value={l.from}
                onChange={(e) => setLinks(links.map((x, j) => (i === j ? { ...x, from: e.target.value } : x)))}
              >
                <option value="">起点…</option>
                {memberOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span>↔</span>
              <select
                value={l.to}
                onChange={(e) => setLinks(links.map((x, j) => (i === j ? { ...x, to: e.target.value } : x)))}
              >
                <option value="">终点…</option>
                {memberOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <input
                placeholder="说明（可选）"
                value={l.label ?? ""}
                onChange={(e) =>
                  setLinks(links.map((x, j) => (i === j ? { ...x, label: e.target.value || undefined } : x)))
                }
              />
              <button className="link" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                移除
              </button>
            </div>
          ))}
          <button className="link" onClick={() => setLinks([...links, { from: "", to: "" }])}>
            + 添加连线
          </button>
          <p className="muted">连线两端从成员设备里选（拓扑图渲染用）。</p>
        </div>
        {error && <p className="error whitespace">{error}</p>}
        <div className="row-actions">
          <button className="btn btn--primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button className="btn btn--ghost" onClick={() => navigate(-1)}>
            返回
          </button>
        </div>
      </div>
    </section>
  );
}

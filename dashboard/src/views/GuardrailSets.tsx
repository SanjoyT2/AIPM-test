import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import type { GuardrailSet } from "../types";

/** Standalone guardrail sets — bundles of catalog rules, attachable to many agents. */
export default function GuardrailSets() {
  const [sets, setSets] = useState<GuardrailSet[]>([]);
  const [catalog, setCatalog] = useState<{ id: string; severity: string; stage: string; detail?: string }[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = () => api.guardrailSets().then(setSets).catch(() => setSets([]));
  useEffect(() => {
    load();
    api.guardrailCatalog().then((c) => setCatalog(c.all_rule_ids.map((id) => ({ id, ...c.rules[id] })))).catch(() => setCatalog([]));
  }, []);

  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const create = async () => {
    if (!name.trim() || picked.size === 0) return;
    await api.createGuardrailSet(name.trim(), [...picked]);
    setName(""); setPicked(new Set()); load();
  };
  const del = async (id: string) => { await api.deleteGuardrailSet(id); load(); };

  return (
    <>
      <h1>Guardrails</h1>
      <div className="sub">Compose a set of rules once, attach it to any agents from the Studio. Rules come from the guardrails config catalog.</div>

      <Panel title="Create a guardrail set">
        <input className="chip" style={{ width: 240, marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="set name (e.g. No hype)" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {catalog.map((r) => (
            <button key={r.id} className={`chip ${picked.has(r.id) ? "on" : ""}`} title={`${r.stage} · ${r.severity}${r.detail ? " · " + r.detail : ""}`} onClick={() => togglePick(r.id)}>
              {r.id}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="chip" onClick={create} disabled={!name.trim() || picked.size === 0}>Create set ({picked.size} rules)</button>
        </div>
      </Panel>

      {sets.length === 0 ? <Empty>No guardrail sets yet.</Empty> : (
        <table>
          <thead><tr><th>Set</th><th>Rules</th><th>Attached to</th><th></th></tr></thead>
          <tbody>
            {sets.map((s) => (
              <tr key={s.gr_id}>
                <td>{s.name}</td>
                <td>{s.rule_ids.map((r) => <span key={r} className="pill" style={{ marginRight: 4 }}>{r}</span>)}</td>
                <td>{(s.attached_agents ?? []).length ? (s.attached_agents ?? []).map((x) => <span key={x} className="pill accent" style={{ marginRight: 4 }}>{x}</span>) : <span className="sub">none</span>}</td>
                <td><button className="chip" onClick={() => del(s.gr_id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

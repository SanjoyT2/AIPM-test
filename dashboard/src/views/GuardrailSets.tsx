import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import type { GuardrailRuleDef, GuardrailSet } from "../types";

/**
 * Guardrails — plain-English rules, enforced by an LLM critic pass (nothing
 * deterministic). Create a rule by typing a sentence; bundle rules into sets;
 * attach sets to agents from the Studio.
 */
export default function GuardrailSets() {
  const [sets, setSets] = useState<GuardrailSet[]>([]);
  const [rules, setRules] = useState<GuardrailRuleDef[]>([]);
  const [setName, setSetName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // new rule form
  const [rName, setRName] = useState("");
  const [rDesc, setRDesc] = useState("");
  const [rSev, setRSev] = useState("block");

  const loadSets = () => api.guardrailSets().then(setSets).catch(() => setSets([]));
  const loadRules = () => api.guardrailCatalog().then((c) => setRules(c.rules)).catch(() => setRules([]));
  useEffect(() => { loadSets(); loadRules(); }, []);

  const createRule = async () => {
    if (!rName.trim() || !rDesc.trim()) return;
    await api.createRule(rName.trim(), rDesc.trim(), rSev);
    setRName(""); setRDesc(""); loadRules();
  };
  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const createSet = async () => {
    if (!setName.trim() || picked.size === 0) return;
    await api.createGuardrailSet(setName.trim(), [...picked]);
    setSetName(""); setPicked(new Set()); loadSets();
  };

  return (
    <>
      <h1>Guardrails</h1>
      <div className="sub">Plain-English rules, enforced by an LLM critic on every agent message — no code. Bundle rules into a set, attach the set to agents from the Studio.</div>

      <Panel title="Create a rule — just describe it">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <input className="chip" style={{ width: 190 }} value={rName} onChange={(e) => setRName(e.target.value)} placeholder="short name (e.g. No salary figures)" />
          <input className="chip" style={{ flex: 1, minWidth: 300 }} value={rDesc} onChange={(e) => setRDesc(e.target.value)}
            placeholder="Block any message that promises a specific salary or income figure." onKeyDown={(e) => e.key === "Enter" && createRule()} />
          <select className="chip" value={rSev} onChange={(e) => setRSev(e.target.value)} style={{ width: 110 }}>
            <option value="block">block</option>
            <option value="escalate">escalate</option>
            <option value="warn">warn</option>
          </select>
          <button className="chip" onClick={createRule} disabled={!rName.trim() || !rDesc.trim()}>Create rule</button>
        </div>
      </Panel>

      <Panel title="Create a set — bundle rules to attach together">
        <input className="chip" style={{ width: 240, marginBottom: 10 }} value={setName} onChange={(e) => setSetName(e.target.value)} placeholder="set name (e.g. Trainer safety)" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {rules.map((r) => (
            <button key={r.rule_id} className={`chip ${picked.has(r.rule_id) ? "on" : ""}`} title={`${r.severity} · ${r.description}`} onClick={() => togglePick(r.rule_id)}>
              {r.name}{r.source === "custom" && <span style={{ color: "var(--accent)" }}> ●</span>}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="chip" onClick={createSet} disabled={!setName.trim() || picked.size === 0}>Create set ({picked.size} rules)</button>
          <span className="sub" style={{ marginLeft: 8 }}>● = your custom rule</span>
        </div>
      </Panel>

      {sets.length === 0 ? <Empty>No guardrail sets yet.</Empty> : (
        <table>
          <thead><tr><th>Set</th><th>Rules</th><th>Attached to</th><th></th></tr></thead>
          <tbody>
            {sets.map((s) => (
              <tr key={s.gr_id}>
                <td>{s.name}</td>
                <td>{s.rule_ids.map((r) => { const d = rules.find((x) => x.rule_id === r); return <span key={r} className="pill" style={{ marginRight: 4 }} title={d?.description}>{d?.name ?? r}</span>; })}</td>
                <td>{(s.attached_agents ?? []).length ? (s.attached_agents ?? []).map((x) => <span key={x} className="pill accent" style={{ marginRight: 4 }}>{x}</span>) : <span className="sub">none</span>}</td>
                <td><button className="chip" onClick={async () => { await api.deleteGuardrailSet(s.gr_id); loadSets(); }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

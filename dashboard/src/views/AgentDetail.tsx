import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtTime, fmtUsd } from "../api";
import { Panel } from "../components";
import type { AgentDetail as AD, GuardrailSet, KnowledgeBase } from "../types";

/** One agent's page: config, attached knowledge + guardrail sets, playground, conversations. */
export default function AgentDetail() {
  const { name } = useParams<{ name: string }>();
  const [a, setA] = useState<AD | null>(null);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [sets, setSets] = useState<GuardrailSet[]>([]);
  const nav = useNavigate();

  // playground
  const [subject, setSubject] = useState("priya-sharma");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ reply: string; sources: string[]; retrieved: string[]; cost: number; status: string; guardrails: string[] } | null>(null);

  const load = () => { if (name) api.agent(name).then(setA).catch(() => setA(null)); };
  useEffect(load, [name]);
  useEffect(() => { api.kbs().then(setKbs).catch(() => {}); api.guardrailSets().then(setSets).catch(() => {}); }, []);

  if (!a) return <div className="sub">Loading…</div>;

  const toggle = async (type: "kb" | "guardrail", id: string, attached: boolean) => {
    await api.attachResource(a.name, type, id, attached ? "detach" : "attach");
    load();
  };

  const run = async () => {
    if (!name || !text.trim()) return;
    setRunning(true); setResult(null);
    try {
      const r = await api.testAgent(name, subject, text);
      const tx = r.transaction;
      const g = [...(tx.guardrails.input ?? []), ...(tx.guardrails.output ?? [])];
      setResult({
        reply: (tx.output as { text?: string })?.text ?? JSON.stringify(tx.output),
        sources: tx.evidence.sources, retrieved: r.retrieved.map((x) => x.title),
        cost: tx.cost.total_usd, status: tx.status,
        guardrails: g.map((x) => `${x.id}${x.passed ? "" : " ✗"}`),
      });
    } finally { setRunning(false); }
  };

  return (
    <>
      <div className="crumb"><Link to="/studio">agent studio</Link><span>/</span><span className="mono">{a.name}</span></div>
      <h1 style={{ display: "flex", gap: 10, alignItems: "center" }}>{a.name}
        <span className={`pill ${a.tier === "deep" ? "info" : ""}`}>{a.tier}</span>
        <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>v{a.version}</span>
      </h1>
      <div className="sub" style={{ marginBottom: 14 }}>guardrail policy <b>{a.guardrail_policy}</b> · critic policy <b>{a.critic_policy}</b></div>

      <Panel title="Playground — test on a learner's behalf (never sends WhatsApp)">
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input className="chip" style={{ width: 160 }} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="learner id" />
          <input className="chip" style={{ flex: 1, minWidth: 220 }} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()} placeholder={a.name === "trainer" ? "START" : "type a message as this learner…"} />
          <button className="chip" disabled={running || !text.trim()} onClick={run}>{running ? "Running…" : "Run"}</button>
        </div>
        {result && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div className="sub">reply · <span className={`pill ${result.status === "blocked" ? "danger" : "ok"}`}>{result.status}</span> · {fmtUsd(result.cost)}</div>
            <pre className="code" style={{ marginTop: 6 }}>{result.reply}</pre>
            {result.retrieved.length > 0 && <div className="sub" style={{ marginTop: 6 }}>RAG injected: {result.retrieved.join(", ")}</div>}
            <div className="sub" style={{ marginTop: 4 }}>guardrails: {result.guardrails.join(", ")}</div>
          </div>
        )}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Panel title="Knowledge bases (RAG)">
          {kbs.length === 0 ? <div className="sub">None yet — create in <Link className="link" to="/knowledge">Knowledge</Link>.</div> :
            kbs.map((kb) => {
              const on = a.attached_kbs.includes(kb.kb_id);
              return (
                <div key={kb.kb_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0" }}>
                  <span>{kb.name} <span className="sub">· {kb.doc_count ?? 0} docs</span></span>
                  <button className={`chip ${on ? "on" : ""}`} onClick={() => toggle("kb", kb.kb_id, on)}>{on ? "Attached" : "Attach"}</button>
                </div>
              );
            })}
        </Panel>
        <Panel title="Guardrail sets">
          {sets.length === 0 ? <div className="sub">None yet — create in <Link className="link" to="/guardrails">Guardrails</Link>.</div> :
            sets.map((s) => {
              const on = a.attached_guardrail_sets.includes(s.gr_id);
              return (
                <div key={s.gr_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0" }}>
                  <span>{s.name} <span className="sub">· {s.rule_ids.length} rules</span></span>
                  <button className={`chip ${on ? "on" : ""}`} onClick={() => toggle("guardrail", s.gr_id, on)}>{on ? "Attached" : "Attach"}</button>
                </div>
              );
            })}
        </Panel>
      </div>

      <Panel title="System prompt">
        <pre className="code" style={{ maxHeight: 220, overflowY: "auto" }}>{a.system_prompt}</pre>
      </Panel>

      <Panel title={`Recent conversations (${a.recent_transactions.length})`}>
        {a.recent_transactions.length === 0 ? <div className="sub">No runs yet.</div> : (
          <table>
            <thead><tr><th>When</th><th>Subject</th><th>Status</th><th>Critique</th><th className="num">Cost</th></tr></thead>
            <tbody>
              {a.recent_transactions.map((t) => (
                <tr key={t.transaction_id} className="row" onClick={() => nav(`/transactions/${t.transaction_id}`)}>
                  <td className="mono">{fmtTime(t.timestamp)}</td>
                  <td className="mono">{t.subject_id ?? "—"}</td>
                  <td><span className={`pill ${t.status === "completed" ? "ok" : t.status === "blocked" ? "danger" : "warn"}`}>{t.status}</span></td>
                  <td className="sub">{t.verdict}</td>
                  <td className="num">{fmtUsd(t.total_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

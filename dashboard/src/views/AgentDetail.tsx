import { useEffect, useRef, useState } from "react";
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

  // playground — WhatsApp-style chat
  type Msg =
    | { dir: "out"; text: string; t: string }
    | { dir: "in"; text: string; t: string; cost: number; status: string; guardrails: { id: string; passed: boolean }[]; retrieved: string[] };
  const [subject, setSubject] = useState("priya-sharma");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [chat, setChat] = useState<Msg[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = () => { if (name) api.agent(name).then(setA).catch(() => setA(null)); };
  useEffect(load, [name]);
  useEffect(() => { api.kbs().then(setKbs).catch(() => {}); api.guardrailSets().then(setSets).catch(() => {}); }, []);
  useEffect(() => { setChat([]); }, [subject]);
  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [chat, running]);

  if (!a) return <div className="sub">Loading…</div>;

  const toggle = async (type: "kb" | "guardrail", id: string, attached: boolean) => {
    await api.attachResource(a.name, type, id, attached ? "detach" : "attach");
    load();
  };

  const now = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const send = async () => {
    if (!name || !text.trim() || running) return;
    const outMsg = text.trim();
    setText("");
    setChat((c) => [...c, { dir: "out", text: outMsg, t: now() }]);
    setRunning(true);
    try {
      const r = await api.testAgent(name, subject, outMsg);
      const tx = r.transaction;
      setChat((c) => [...c, {
        dir: "in",
        text: (tx.output as { text?: string })?.text ?? JSON.stringify(tx.output),
        t: now(), cost: tx.cost.total_usd, status: tx.status,
        guardrails: [...(tx.guardrails.output ?? [])].map((x) => ({ id: x.id, passed: x.passed })),
        retrieved: r.retrieved.map((x) => x.title),
      }]);
    } catch (e) {
      setChat((c) => [...c, { dir: "in", text: `⚠︎ ${String(e)}`, t: now(), cost: 0, status: "error", guardrails: [], retrieved: [] }]);
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

      <Panel title="Playground — chat on a learner's behalf (test mode · never sends WhatsApp)">
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <span className="sub">chatting as</span>
          <input className="chip" style={{ width: 170 }} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="learner id" />
        </div>
        <div className="wa">
          <div className="wa-head">
            <div className="wa-avatar">{a.name.slice(0, 2).toUpperCase()}</div>
            <div>
              <div className="who">{a.name}</div>
              <div className="status">{running ? "typing…" : "online · test mode"}</div>
            </div>
          </div>
          <div className="wa-body" ref={bodyRef}>
            {chat.length === 0 && !running && (
              <div className="wa-empty">Send a message as <b>{subject}</b> to test {a.name}.<br />{a.name === "trainer" ? "Try “START”." : "Try a real question."}</div>
            )}
            {chat.map((m, i) => (
              <div key={i}>
                <div className={`wa-row ${m.dir}`}>
                  <div className="wa-msg">{m.text}<span className="t">{m.t}</span></div>
                </div>
                {m.dir === "in" && (
                  <div className="wa-meta">
                    <span className={`m ${m.status === "blocked" || m.status === "error" ? "bad" : "ok"}`}>{m.status}</span>
                    <span className="m">{fmtUsd(m.cost)}</span>
                    {m.retrieved.length > 0 && <span className="m">RAG: {m.retrieved.join(", ")}</span>}
                    {m.guardrails.map((g) => (
                      <span key={g.id} className={`m ${g.passed ? "" : "bad"}`}>{g.passed ? "✓" : "✗"} {g.id}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {running && <div className="wa-row in"><div className="wa-msg" style={{ color: "#8696a0" }}>…</div></div>}
          </div>
          <div className="wa-inbar">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={a.name === "trainer" ? "Type START…" : "Type a message…"} />
            <button className="wa-send" onClick={send} disabled={running || !text.trim()} aria-label="send">➤</button>
          </div>
        </div>
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

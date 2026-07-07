import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTime, fmtUsd } from "../api";
import { Panel, StatusPill, VerdictPill } from "../components";
import type { AgentTransaction } from "../types";

/** One agent transaction, fully opened: output, evidence, critique, guardrails, cost calls. */
export default function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const [tx, setTx] = useState<AgentTransaction | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (id) api.transaction(id).then(setTx).catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <div className="empty">{err}</div>;
  if (!tx) return <div className="sub">Loading…</div>;

  const grs = [...(tx.guardrails.input ?? []).map((g) => ({ ...g, stage: "input" })),
               ...(tx.guardrails.output ?? []).map((g) => ({ ...g, stage: "output" }))];

  return (
    <>
      <div className="crumb"><Link to="/transactions">transactions</Link><span>/</span><span className="mono">{tx.transaction_id}</span></div>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="mono">{tx.transaction_id}</span>
        <StatusPill status={tx.status} />
        <VerdictPill verdict={tx.critique.verdict} />
      </h1>
      <div className="sub" style={{ marginBottom: 18 }}>
        {fmtTime(tx.timestamp)} · agent{" "}
        <Link className="link" to={`/transactions?agent=${tx.agent.name}`}>{tx.agent.name}@{tx.agent.version}</Link>
        {tx.subject_id && <> · subject <Link className="link" to={`/transactions?subject=${tx.subject_id}`}>{tx.subject_id}</Link></>}
        {" "}· plan <Link className="link" to={`/transactions?plan=${tx.plan_ref.plan_id}`}>{tx.plan_ref.plan_id}</Link> / {tx.plan_ref.step_id}
      </div>

      <Panel title="Output">
        <pre className="code">{JSON.stringify(tx.output, null, 2)}</pre>
      </Panel>

      <Panel title="Evidence — what justifies this output">
        <div className="kv">
          <div className="k">Sources</div>
          <div>{tx.evidence.sources.map((s) => <div key={s} className="mono">{s}</div>)}</div>
          <div className="k">Reasoning</div><div>{tx.evidence.reasoning_summary}</div>
          {tx.evidence.confidence != null && (<><div className="k">Confidence</div><div className="mono">{(tx.evidence.confidence * 100).toFixed(0)}%</div></>)}
          {tx.evidence.framework_version && (<><div className="k">Framework version</div><div className="mono">{tx.evidence.framework_version}</div></>)}
          {tx.evidence.rubric_version && (<><div className="k">Rubric version</div><div className="mono">{tx.evidence.rubric_version}</div></>)}
        </div>
      </Panel>

      <Panel title={`Critique — ${tx.critique.policy ?? "policy n/a"} · ${tx.critique.revisions ?? 0} revision(s)`}>
        {(tx.critique.critics ?? []).length === 0 ? (
          <div className="sub">No critic ran (sampled out by policy or guardrail-only fast path).</div>
        ) : (
          <table>
            <thead><tr><th>Critic model</th><th>Verdict</th><th>Justification</th></tr></thead>
            <tbody>
              {tx.critique.critics!.map((c, i) => (
                <tr key={i}>
                  <td className="mono">{c.model}</td>
                  <td><VerdictPill verdict={c.verdict} /></td>
                  <td>{c.justification ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Guardrails">
        {grs.length === 0 ? <div className="sub">None recorded.</div> : (
          <table>
            <thead><tr><th>Rule</th><th>Stage</th><th>Result</th><th>Severity</th><th>Detail</th></tr></thead>
            <tbody>
              {grs.map((g, i) => (
                <tr key={i}>
                  <td className="mono">{g.id}</td>
                  <td>{g.stage}</td>
                  <td><span className={`pill ${g.passed ? "ok" : "danger"}`}>{g.passed ? "passed" : "FAILED"}</span></td>
                  <td>{g.severity}</td>
                  <td>{g.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Cost — ${fmtUsd(tx.cost.total_usd)} · ${tx.cost.total_tokens.toLocaleString()} tokens${tx.cost.total_ms ? ` · ${tx.cost.total_ms}ms` : ""}`}>
        <table>
          <thead><tr><th>Role</th><th>Model</th><th className="num">In tokens</th><th className="num">Out tokens</th><th className="num">USD</th><th className="num">ms</th></tr></thead>
          <tbody>
            {tx.cost.calls.map((c, i) => (
              <tr key={i}>
                <td><span className={`pill ${c.role === "critic" ? "info" : c.role === "guardrail" ? "warn" : "accent"}`}>{c.role}</span></td>
                <td className="mono">{c.model}</td>
                <td className="num">{c.input_tokens?.toLocaleString() ?? "—"}</td>
                <td className="num">{c.output_tokens?.toLocaleString() ?? "—"}</td>
                <td className="num">{fmtUsd(c.usd)}</td>
                <td className="num">{c.ms ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {tx.links?.evidence_events_emitted?.length ? (
        <Panel title="Domain evidence events emitted">
          {tx.links.evidence_events_emitted.map((e) => <div key={e} className="mono">{e}</div>)}
        </Panel>
      ) : null}
    </>
  );
}

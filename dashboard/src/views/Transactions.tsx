import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtTime, fmtUsd } from "../api";
import { Empty, StatusPill, VerdictPill } from "../components";
import type { AgentTransaction } from "../types";

const STATUSES = ["completed", "revised", "escalated", "blocked", "failed"];

export default function Transactions() {
  const [params, setParams] = useSearchParams();
  const [txs, setTxs] = useState<AgentTransaction[]>([]);
  const nav = useNavigate();

  const status = params.get("status") ?? "";
  const agent = params.get("agent") ?? "";
  const subject = params.get("subject") ?? "";
  const plan = params.get("plan") ?? "";

  useEffect(() => {
    api
      .transactions({ status: status || undefined, agent: agent || undefined, subject: subject || undefined })
      .then(setTxs)
      .catch(() => setTxs([]));
  }, [status, agent, subject]);

  const rows = useMemo(
    () => (plan ? txs.filter((t) => t.plan_ref.plan_id === plan) : txs),
    [txs, plan],
  );
  const agents = useMemo(() => [...new Set(txs.map((t) => t.agent.name))].sort(), [txs]);

  const toggle = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (next.get(key) === value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <h1>Transactions</h1>
      <div className="sub">Every agent action, individually inspectable. Click a row for evidence, critique, guardrails, and cost.</div>

      <div className="filters">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => toggle("status", s)}>{s}</button>
        ))}
        {agents.map((a) => (
          <button key={a} className={`chip ${agent === a ? "on" : ""}`} onClick={() => toggle("agent", a)}>{a}</button>
        ))}
        {subject && <button className="chip on" onClick={() => toggle("subject", subject)}>subject: {subject} ✕</button>}
        {plan && <button className="chip on" onClick={() => toggle("plan", plan)}>plan: {plan} ✕</button>}
      </div>

      {rows.length === 0 ? (
        <Empty>Nothing matches this filter.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Transaction</th><th>Agent</th><th>Subject</th><th>Plan / step</th><th>Status</th><th>Critique</th><th className="num">Cost</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.transaction_id} className="row" onClick={() => nav(`/transactions/${t.transaction_id}`)}>
                <td className="mono">{fmtTime(t.timestamp)}</td>
                <td className="mono">{t.transaction_id}</td>
                <td>{t.agent.name}</td>
                <td className="mono">{t.subject_id ?? "—"}</td>
                <td className="mono">{t.plan_ref.plan_id} / {t.plan_ref.step_id}</td>
                <td><StatusPill status={t.status} /></td>
                <td><VerdictPill verdict={t.critique.verdict} /></td>
                <td className="num">{fmtUsd(t.cost.total_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtTime, fmtUsd } from "../api";
import { ActionCard, Empty, StatusPill, VerdictPill } from "../components";
import type { AgentTransaction, Health } from "../types";

/** The operator's "4 cards, 4 clicks" — decisions first, charts never. */
export default function Overview() {
  const [health, setHealth] = useState<Health | null>(null);
  const [txs, setTxs] = useState<AgentTransaction[]>([]);
  const nav = useNavigate();

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.transactions({ limit: 500 }).then(setTxs).catch(() => setTxs([]));
  }, []);

  const escalated = txs.filter((t) => t.status === "escalated").length;
  const blocked = txs.filter((t) => t.status === "blocked" || t.guardrails.blocked).length;
  const spend = txs.reduce((a, t) => a + t.cost.total_usd, 0);
  const recent = txs.slice(0, 12);

  return (
    <>
      <h1>Cockpit</h1>
      <div className="sub">What needs a human right now. Every number is a click.</div>

      <div className="cards">
        <ActionCard label="Escalations" value={escalated} hint="Resolve in queue" to="/transactions?status=escalated" tone={escalated ? "alert" : undefined} />
        <ActionCard label="Guardrail blocks" value={blocked} hint="See what fired" to="/transactions?status=blocked" tone={blocked ? "bad" : undefined} />
        <ActionCard label="Spend (ledger)" value={fmtUsd(spend)} hint="Open the cost train" to="/costs" />
        <ActionCard
          label="System"
          value={health ? (health.gateway === "live" ? "live" : "stub") : "…"}
          hint={health ? `${health.storage} · ${Object.keys(health.framework_versions).length} frameworks` : "checking"}
          to="/frameworks"
          tone={health?.gateway === "live" ? "good" : undefined}
        />
      </div>

      <h2>Recent transactions</h2>
      {recent.length === 0 ? (
        <Empty>No transactions yet. Run the seed script (`npm run seed` in service/) or wire an agent.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Agent</th><th>Subject</th><th>Status</th><th>Critique</th><th className="num">Cost</th></tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.transaction_id} className="row" onClick={() => nav(`/transactions/${t.transaction_id}`)}>
                <td className="mono">{fmtTime(t.timestamp)}</td>
                <td>{t.agent.name}</td>
                <td className="mono">{t.subject_id ?? "—"}</td>
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

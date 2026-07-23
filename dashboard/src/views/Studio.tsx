import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtUsd } from "../api";
import { Empty } from "../components";
import type { AgentSummary } from "../types";

/** Agent Studio home — leaderboard + superlatives across all agents. */
export default function Studio() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const nav = useNavigate();

  useEffect(() => { api.agents().then(setAgents).catch(() => setAgents([])); }, []);

  const withTx = agents.filter((a) => a.transactions > 0);
  const superlatives = useMemo(() => {
    if (!withTx.length) return null;
    const by = (f: (a: AgentSummary) => number, dir = 1) => [...withTx].sort((x, y) => (f(y) - f(x)) * dir)[0];
    return {
      popular: by((a) => a.transactions),
      performing: by((a) => a.success_rate ?? 0),
      expensive: by((a) => a.total_usd),
      fastest: by((a) => a.avg_ms, -1),
    };
  }, [agents]);

  const card = (label: string, a: AgentSummary | undefined, metric: string) => (
    <div className="card" onClick={() => a && nav(`/studio/${a.name}`)} style={{ cursor: a ? "pointer" : "default" }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 20 }}>{a?.name ?? "—"}</div>
      <div className="hint">{a ? metric : "no data yet"}</div>
    </div>
  );

  return (
    <>
      <h1>Agent Studio</h1>
      <div className="sub">Manage prompts, knowledge, and guardrails per agent — and test any agent on a learner's behalf.</div>

      {superlatives && (
        <div className="cards">
          {card("Most used", superlatives.popular, `${superlatives.popular.transactions} runs`)}
          {card("Best performing", superlatives.performing, `${((superlatives.performing.success_rate ?? 0) * 100).toFixed(0)}% success`)}
          {card("Most expensive", superlatives.expensive, fmtUsd(superlatives.expensive.total_usd))}
          {card("Fastest", superlatives.fastest, `${superlatives.fastest.avg_ms} ms avg`)}
        </div>
      )}

      <h2>All agents</h2>
      {agents.length === 0 ? <Empty>No agents loaded.</Empty> : (
        <table>
          <thead>
            <tr><th>Agent</th><th>Tier</th><th className="num">Runs</th><th className="num">Success</th><th className="num">Cost</th><th className="num">Avg ms</th><th>Knowledge</th><th>Guardrail sets</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name} className="row" onClick={() => nav(`/studio/${a.name}`)}>
                <td>{a.name} <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>v{a.version}</span></td>
                <td><span className={`pill ${a.tier === "deep" ? "info" : ""}`}>{a.tier}</span></td>
                <td className="num">{a.transactions}</td>
                <td className="num">{a.success_rate == null ? "—" : `${(a.success_rate * 100).toFixed(0)}%`}</td>
                <td className="num">{fmtUsd(a.total_usd)}</td>
                <td className="num">{a.avg_ms || "—"}</td>
                <td>{a.attached_kbs.length ? <span className="pill accent">{a.attached_kbs.length}</span> : <span className="sub">none</span>}</td>
                <td>{a.attached_guardrail_sets.length ? <span className="pill accent">{a.attached_guardrail_sets.length}</span> : <span className="sub">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

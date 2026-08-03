import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTime, fmtUsd } from "../api";
import { Panel, StatusPill, VerdictPill } from "../components";
import type { LearnerMeasurement, AgentTransaction, LearnerSummaryReport } from "../types";

/** One learner's measurement: composite breakdown, mastery per competency, integrity, evidence. */
export default function LearnerDetail() {
  const { id } = useParams<{ id: string }>();
  const [m, setM] = useState<LearnerMeasurement | null>(null);
  const [txs, setTxs] = useState<AgentTransaction[]>([]);
  const [report, setReport] = useState<LearnerSummaryReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => {
    if (id) {
      api.learner(id).then(setM).catch((e) => setErr(String(e)));
      api.transactions({ subject: id }).then(setTxs).catch(() => setTxs([]));
      setLoadingReport(true);
      api.learnerSummaryReport(id)
        .then(setReport)
        .catch(() => setReport(null))
        .finally(() => setLoadingReport(false));
    }
  };
  useEffect(load, [id]);

  const decide = async (competency: string, decision: "cleared" | "upheld") => {
    if (!id) return;
    setBusy(competency + decision);
    try { await api.resolveIntegrity(id, competency, decision); load(); }
    finally { setBusy(""); }
  };

  if (err) return <div className="empty">{err}</div>;
  if (!m) return <div className="sub">Loading…</div>;

  const c = m.composite;
  const clearedSet = new Set((m.integrity_decisions ?? []).filter((d) => d.decision === "cleared").map((d) => d.competency_id));

  return (
    <>
      <div className="crumb"><Link to="/learners">learners</Link><span>/</span><span className="mono">{m.learner_id}</span></div>
      <h1>{m.learner_id}</h1>
      <div className="sub" style={{ marginBottom: 16 }}>
        framework {c.framework_version} · formula {c.formula_version} · {m.evidence_count} evidence events
      </div>

      {loadingReport ? (
        <Panel title="AI Summary & Engagement Metrics">
          <div className="sub">Generating AI summary and compiling engagement metrics...</div>
        </Panel>
      ) : report ? (
        <Panel title="AI Summary & Engagement Metrics">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginBottom: 14 }}>
            <div>
              <h3>AI PM Coach Summary</h3>
              <div className="code" style={{ whiteSpace: "pre-wrap", padding: 12, borderRadius: 6, background: "var(--bg-card, #f9f9f9)", fontSize: 13, borderLeft: "4px solid var(--accent)" }}>
                {report.ai_summary}
              </div>
            </div>
            <div>
              <h3>Engagement & Behavioral Metrics</h3>
              <div className="kv" style={{ marginTop: 10 }}>
                <div className="k">Attendance</div>
                <div>💬 <b>{report.days_active} days</b> active on WhatsApp</div>

                <div className="k">Reading habits</div>
                <div>📖 <b>{report.total_micros_read} micro-lessons</b> completed</div>

                <div className="k">Response speed</div>
                <div>⏱ <b>{report.avg_response_time_minutes ? `${report.avg_response_time_minutes} minutes` : "instant / no gap"}</b> average response interval</div>
              </div>

              <h3 style={{ marginTop: 16 }}>Assessment Scores Breakdown</h3>
              <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                <div style={{ flex: 1, padding: 8, background: "var(--bg-light, #f1f5f9)", borderRadius: 6, textAlign: "center" }}>
                  <div className="sub" style={{ fontSize: 11 }}>Quizzes</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{report.scores_breakdown.quizzes.avg !== null ? `${report.scores_breakdown.quizzes.avg}%` : "—"}</div>
                  <div className="sub" style={{ fontSize: 10 }}>{report.scores_breakdown.quizzes.count} graded</div>
                </div>
                <div style={{ flex: 1, padding: 8, background: "var(--bg-light, #f1f5f9)", borderRadius: 6, textAlign: "center" }}>
                  <div className="sub" style={{ fontSize: 11 }}>Tasks</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{report.scores_breakdown.tasks.avg !== null ? `${report.scores_breakdown.tasks.avg}%` : "—"}</div>
                  <div className="sub" style={{ fontSize: 10 }}>{report.scores_breakdown.tasks.count} graded</div>
                </div>
                <div style={{ flex: 1, padding: 8, background: "var(--bg-light, #f1f5f9)", borderRadius: 6, textAlign: "center" }}>
                  <div className="sub" style={{ fontSize: 11 }}>Vivas</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{report.scores_breakdown.vivas.avg !== null ? `${report.scores_breakdown.vivas.avg}%` : "—"}</div>
                  <div className="sub" style={{ fontSize: 10 }}>{report.scores_breakdown.vivas.count} graded</div>
                </div>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel title="Composite score">
        <div style={{ display: "flex", gap: 28, alignItems: "baseline", flexWrap: "wrap", marginBottom: 14 }}>
          <div><div className="sub">Base</div><div className="mono" style={{ fontSize: 22 }}>{c.base.toFixed(1)}</div></div>
          <div style={{ color: "var(--muted)", fontSize: 22 }}>×</div>
          <div><div className="sub">Integrity</div><div className="mono" style={{ fontSize: 22, color: c.integrity_multiplier < 1 ? "var(--danger)" : "var(--ink)" }}>{c.integrity_multiplier.toFixed(2)}</div></div>
          <div style={{ color: "var(--muted)", fontSize: 22 }}>=</div>
          <div><div className="sub">Final</div><div className="mono" style={{ fontSize: 26, fontWeight: 500, color: "var(--accent)" }}>{c.final.toFixed(1)}</div></div>
          <div style={{ marginLeft: "auto" }}><span className="pill accent">{c.rank_band}</span></div>
        </div>
        <table>
          <thead><tr><th>Source</th><th className="num">Weight</th><th className="num">Score</th><th className="num">Contribution</th><th className="num">Evidence</th></tr></thead>
          <tbody>
            {c.sources.map((s) => (
              <tr key={s.source}>
                <td>{s.source}</td>
                <td className="num">{(s.weight * 100).toFixed(0)}%</td>
                <td className="num">{s.score.toFixed(1)}</td>
                <td className="num">{(s.weight * s.score).toFixed(1)}</td>
                <td className="num" style={{ color: s.evidence_count ? "var(--ink)" : "var(--muted)" }}>{s.evidence_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {m.integrity.length > 0 && (
        <Panel title="Integrity — async vs. sync (looks-good-on-paper vs. can-explain-live)">
          <table>
            <thead><tr><th>Competency</th><th className="num">Async</th><th className="num">Live</th><th className="num">Delta</th><th>Status</th><th>Decision</th></tr></thead>
            <tbody>
              {m.integrity.map((f) => {
                const cleared = clearedSet.has(f.competency_id);
                return (
                  <tr key={f.competency_id}>
                    <td className="mono">{f.competency_id}</td>
                    <td className="num">{f.async_score.toFixed(0)}</td>
                    <td className="num">{f.sync_score.toFixed(0)}</td>
                    <td className="num" style={{ color: f.review ? "var(--danger)" : "var(--warn)" }}>+{f.delta.toFixed(1)}</td>
                    <td>{cleared ? <span className="pill ok">cleared</span> : f.review ? <span className="pill danger">review</span> : <span className="pill warn">minor</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="chip" disabled={!!busy} onClick={() => decide(f.competency_id, "cleared")}>Clear</button>{" "}
                      <button className="chip" disabled={!!busy} onClick={() => decide(f.competency_id, "upheld")}>Uphold</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="sub" style={{ marginTop: 8 }}>Clearing a flag removes its penalty and recomputes the composite immediately. Every decision is recorded.</div>
        </Panel>
      )}

      <Panel title="Mastery by competency">
        <table>
          <thead><tr><th>Competency</th><th className="num">Estimate</th><th style={{ width: "30%" }}></th><th className="num">Threshold</th><th>Status</th><th className="num">Evidence</th></tr></thead>
          <tbody>
            {m.mastery.map((c2) => (
              <tr key={c2.competency_id}>
                <td><span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>{c2.competency_id}</span><br />{c2.name}</td>
                <td className="num">{c2.estimate.toFixed(0)}</td>
                <td><div className="bar-track"><div className="bar-fill" style={{ width: `${c2.estimate}%`, background: c2.at_threshold ? "var(--ok)" : "var(--muted)" }} /></div></td>
                <td className="num">{c2.threshold}</td>
                <td>{c2.evidence_count === 0 ? <span className="pill">no data</span> : c2.at_threshold ? <span className="pill ok">met</span> : <span className="pill warn">below</span>}</td>
                <td className="num">{c2.evidence_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={`Agent Transactions (${txs.length})`}>
        {txs.length === 0 ? (
          <div className="sub">No agent transactions recorded for this learner.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Transaction ID</th>
                <th>Agent</th>
                <th>Plan / Step</th>
                <th>Status</th>
                <th>Critique</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.transaction_id} className="row" onClick={() => window.open(`/transactions/${t.transaction_id}`, '_blank')}>
                  <td className="mono">{fmtTime(t.timestamp)}</td>
                  <td className="mono">{t.transaction_id}</td>
                  <td>{t.agent.name}</td>
                  <td className="mono">{t.plan_ref.plan_id} / {t.plan_ref.step_id}</td>
                  <td><StatusPill status={t.status} /></td>
                  <td><VerdictPill verdict={t.critique.verdict} /></td>
                  <td className="num">{fmtUsd(t.cost.total_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Evidence log (${m.evidence.length})`}>
        <table>
          <thead><tr><th>When</th><th>Competency</th><th>Activity</th><th>Modality</th><th>Stakes</th><th className="num">Score</th></tr></thead>
          <tbody>
            {m.evidence.map((e) => (
              <tr key={e.event_id}>
                <td className="mono">{fmtTime(e.timestamp)}</td>
                <td className="mono">{e.competency_id}</td>
                <td>{e.activity_type}</td>
                <td><span className={`pill ${e.modality === "sync" ? "info" : ""}`}>{e.modality}</span></td>
                <td>{e.stakes}</td>
                <td className="num">{e.score}/{e.scale_max}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

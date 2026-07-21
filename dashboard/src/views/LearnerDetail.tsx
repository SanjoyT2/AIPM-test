import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTime } from "../api";
import { Panel } from "../components";
import type { LearnerMeasurement } from "../types";

/** One learner's measurement: composite breakdown, mastery per competency, integrity, evidence. */
export default function LearnerDetail() {
  const { id } = useParams<{ id: string }>();
  const [m, setM] = useState<LearnerMeasurement | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => { if (id) api.learner(id).then(setM).catch((e) => setErr(String(e))); }, [id]);

  if (err) return <div className="empty">{err}</div>;
  if (!m) return <div className="sub">Loading…</div>;

  const c = m.composite;

  return (
    <>
      <div className="crumb"><Link to="/learners">learners</Link><span>/</span><span className="mono">{m.learner_id}</span></div>
      <h1>{m.learner_id}</h1>
      <div className="sub" style={{ marginBottom: 16 }}>
        framework {c.framework_version} · formula {c.formula_version} · {m.evidence_count} evidence events
      </div>

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
            <thead><tr><th>Competency</th><th className="num">Async</th><th className="num">Live</th><th className="num">Delta</th><th>Status</th></tr></thead>
            <tbody>
              {m.integrity.map((f) => (
                <tr key={f.competency_id}>
                  <td className="mono">{f.competency_id}</td>
                  <td className="num">{f.async_score.toFixed(0)}</td>
                  <td className="num">{f.sync_score.toFixed(0)}</td>
                  <td className="num" style={{ color: f.review ? "var(--danger)" : "var(--warn)" }}>+{f.delta.toFixed(1)}</td>
                  <td>{f.review ? <span className="pill danger">review</span> : <span className="pill warn">minor</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

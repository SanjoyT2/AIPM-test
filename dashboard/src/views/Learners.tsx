import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Empty } from "../components";
import type { LearnerSummary } from "../types";

/** Leaderboard — composite score per learner, integrity flags surfaced, clickable to detail. */
export default function Learners() {
  const [rows, setRows] = useState<LearnerSummary[]>([]);
  const nav = useNavigate();

  useEffect(() => { api.learners().then(setRows).catch(() => setRows([])); }, []);

  const bandTone = (id: string) =>
    id === "L1_RANK" ? "ok" : id === "L2_RANK" ? "accent" : id === "L3_RANK" ? "info" : "";

  return (
    <>
      <h1>Learners</h1>
      <div className="sub">Composite score is computed deterministically from evidence — click a learner to see the breakdown and every event behind it.</div>

      {rows.length === 0 ? (
        <Empty>No learners yet. Seed evidence (`npm run seed:evidence` in service/).</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th><th>Learner</th><th className="num">Composite</th>
              <th>Rank</th><th className="num">Mastery</th><th>Integrity</th><th className="num">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={l.learner_id} className="row" onClick={() => nav(`/learners/${l.learner_id}`)}>
                <td className="mono" style={{ color: "var(--muted)" }}>{i + 1}</td>
                <td>{l.learner_id}</td>
                <td className="num" style={{ fontWeight: 500 }}>{l.composite.toFixed(1)}</td>
                <td><span className={`pill ${bandTone(l.rank_band_id)}`}>{l.rank_band}</span></td>
                <td className="num">{l.competencies_at_threshold}/{l.competencies_total}</td>
                <td>{l.integrity_review > 0
                  ? <span className="pill danger">{l.integrity_review} to review</span>
                  : <span className="pill ok">clean</span>}</td>
                <td className="num">{l.evidence_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

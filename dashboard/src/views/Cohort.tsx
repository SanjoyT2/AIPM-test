import { useEffect, useState } from "react";
import { api, opKey } from "../api";
import { Empty, Panel } from "../components";
import type { CohortRow, Journey } from "../types";

/** Coach view — the cohort roster, each learner's project + weekly milestones, and a check-in. */
export default function Cohort() {
  const [rows, setRows] = useState<CohortRow[]>([]);
  const [openId, setOpenId] = useState("");
  const [journey, setJourney] = useState<Journey | null>(null);
  const [checkin, setCheckin] = useState<{ message: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // operator "drive the journey" chat
  const [chat, setChat] = useState<{ dir: "out" | "in"; text: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [driving, setDriving] = useState(false);

  const reloadJourney = () => { if (openId) api.journey(openId).then(setJourney).catch(() => setJourney(null)); };
  useEffect(() => { api.cohort().then(setRows).catch(() => setRows([])); }, []);
  useEffect(() => { setCheckin(null); setChat([]); reloadJourney(); }, [openId]);

  const runCheckin = async () => {
    if (!openId) return; setBusy(true);
    try { setCheckin(await api.checkin(openId)); } finally { setBusy(false); }
  };
  const drive = async () => {
    if (!openId || !msg.trim() || driving) return;
    const key = opKey();
    if (!key) { setChat((c) => [...c, { dir: "in", text: "⚠︎ No operator key set — add it at the bottom of the sidebar." }]); return; }
    const out = msg.trim(); setMsg(""); setChat((c) => [...c, { dir: "out", text: out }]); setDriving(true);
    try {
      const r = await api.advance(openId, out, key);
      setChat((c) => [...c, { dir: "in", text: r.reply }]);
      reloadJourney();
    } catch (e) { setChat((c) => [...c, { dir: "in", text: `⚠︎ ${String(e)}` }]); }
    finally { setDriving(false); }
  };
  const tone = (s: string) => s === "flag" ? "danger" : s === "at_risk" ? "warn" : "ok";

  return (
    <>
      <h1>Cohort</h1>
      <div className="sub">Your students, their one solution, and where each stands on the weekly milestones.</div>

      {rows.length === 0 ? <Empty>No enrolled learners yet. Learners enroll when they start their journey on WhatsApp.</Empty> : (
        <table>
          <thead><tr><th>Learner</th><th>Course</th><th className="num">Lessons</th><th className="num">Weeks</th><th>Project</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.learner_id} className="row" onClick={() => setOpenId(openId === r.learner_id ? "" : r.learner_id)}>
                <td>{r.learner_id}</td>
                <td className="sub">{r.course}</td>
                <td className="num">{r.completed}/{r.total}</td>
                <td className="num">{r.modules_complete}/{r.modules_total}</td>
                <td>{r.project ? <>{r.project.title} <span className="sub">· {r.project.stakeholder}</span></> : <span className="sub">not scoped</span>}</td>
                <td><span className={`pill ${r.status === "completed" ? "ok" : "info"}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openId && journey?.enrolled && (
        <Panel title={`${openId} — journey`}>
          {journey.project && (
            <div className="kv" style={{ marginBottom: 12 }}>
              <div className="k">One solution</div><div>{journey.project.title} <span className="sub">for {journey.project.stakeholder}</span></div>
              <div className="k">Problem</div><div>{journey.project.problem || "—"}</div>
              <div className="k">Success metric</div><div>{journey.project.success_metric || "—"}</div>
            </div>
          )}
          <table>
            <thead><tr><th>Week</th><th className="num">Lessons</th><th>Milestone</th><th></th></tr></thead>
            <tbody>
              {(journey.modules ?? []).map((m, i) => (
                <tr key={i}>
                  <td>{m.title}</td>
                  <td className="num">{m.done}/{m.total}</td>
                  <td className="sub">{m.milestone?.title ?? "—"}</td>
                  <td>{m.complete ? <span className="pill ok">shipped</span> : m.done > 0 ? <span className="pill warn">in progress</span> : <span className="pill">not started</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12 }}>
            <button className="chip" disabled={busy} onClick={runCheckin}>{busy ? "Coach thinking…" : "Run Coach check-in"}</button>
          </div>
          {checkin && (
            <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <span className={`pill ${tone(checkin.status)}`}>{checkin.status}</span>
              <pre className="code" style={{ marginTop: 8 }}>{checkin.message}</pre>
            </div>
          )}

          <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div className="sub" style={{ marginBottom: 8 }}>Drive the journey as this learner (operator — real messages, real generations):</div>
            <div className="wa" style={{ maxWidth: 460 }}>
              <div className="wa-body" style={{ minHeight: 120, maxHeight: 300 }}>
                {chat.length === 0 && <div className="wa-empty">Send “START” to serve the next lesson, or an answer to an assessment.</div>}
                {chat.map((m, i) => (
                  <div key={i} className={`wa-row ${m.dir}`}><div className="wa-msg">{m.text}</div></div>
                ))}
                {driving && <div className="wa-row in"><div className="wa-msg" style={{ color: "#8696a0" }}>…</div></div>}
              </div>
              <div className="wa-inbar">
                <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && drive()} placeholder="Type as the learner…" />
                <button className="wa-send" onClick={drive} disabled={driving || !msg.trim()} aria-label="send">➤</button>
              </div>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}

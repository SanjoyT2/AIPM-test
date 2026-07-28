import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import { useSession } from "../session";
import type { Journey } from "../types";

/**
 * What a learner account sees. Reads /api/me/*, which resolves the learner id from
 * the session — no id in the URL, so there is nothing to edit to see someone else.
 */
export default function MyJourney() {
  const { user } = useSession();
  const [journey, setJourney] = useState<Journey | null>(null);
  const [checkin, setCheckin] = useState<{ message: string; status: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.myJourney()
      .then((j) => { setJourney(j); setErr(null); })
      .catch((e) => { setJourney(null); setErr(e instanceof Error ? e.message : String(e)); });
  }, []);

  const askCoach = async () => {
    setBusy(true); setErr(null);
    try { setCheckin(await api.myCheckin()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const first = user?.name?.split(" ")[0] ?? "there";
  const done = journey?.completed ?? 0;
  const total = journey?.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <h1>Hi {first}</h1>
      <div className="sub">Your journey to becoming an AI Implementation Executive.</div>

      {err && <div className="banner danger" onClick={() => setErr(null)}>⚠︎ {err} <span className="sub">(click to dismiss)</span></div>}

      {journey && !journey.enrolled && (
        <Empty>
          You're registered but not enrolled in a course yet. Your coach will enroll you —
          or just message us on WhatsApp and we'll get you started.
        </Empty>
      )}

      {journey?.enrolled && (
        <>
          <Panel title={journey.course_title ?? "Your course"}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
              <b style={{ fontFamily: "var(--serif)", fontSize: 22 }}>{done} of {total} lessons</b>
              <span className="sub">{pct}% complete</span>
            </div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>

            {journey.next_lesson ? (
              <div style={{ marginTop: 16 }}>
                <h3>Up next</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="pill accent">{journey.next_lesson.type}</span>
                  <b>{journey.next_lesson.title}</b>
                </div>
                <div className="sub" style={{ marginTop: 4 }}>
                  In {journey.next_lesson.module} — we'll send this to you on WhatsApp.
                </div>
              </div>
            ) : (
              <div className="sub" style={{ marginTop: 14 }}>Nothing pending right now. Nice work.</div>
            )}
          </Panel>

          {journey.project && (
            <Panel title="Your solution">
              <div className="kv">
                <div className="k">Project</div><div>{journey.project.title}</div>
                <div className="k">Stakeholder</div><div>{journey.project.stakeholder}</div>
                <div className="k">Status</div><div><span className="pill">{journey.project.status}</span></div>
                {journey.project.success_metric && (<><div className="k">Success metric</div><div>{journey.project.success_metric}</div></>)}
              </div>
            </Panel>
          )}

          <Panel title="Your weeks">
            {(journey.modules ?? []).map((m, i) => (
              <div key={i} className="lesson-row">
                <span className={`pill ${m.complete ? "ok" : ""}`} style={{ minWidth: 58, justifyContent: "center" }}>
                  {m.done}/{m.total}
                </span>
                <span>{m.title}</span>
                {m.milestone && <span className="sub" style={{ marginLeft: "auto" }}>🎯 {m.milestone.title}</span>}
              </div>
            ))}
          </Panel>

          <div className="filters">
            <button className="chip on" disabled={busy} onClick={askCoach}>
              {busy ? "Asking…" : "Ask my coach where I stand"}
            </button>
          </div>
          {checkin && (
            <Panel title="From your coach">
              <div style={{ whiteSpace: "pre-wrap" }}>{checkin.message}</div>
            </Panel>
          )}
        </>
      )}
    </>
  );
}

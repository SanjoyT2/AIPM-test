import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";

/** Courses — the curriculum: modules (weeks), lessons (briefs), and milestones. */
export default function Courses() {
  const [courses, setCourses] = useState<{ course_id: string; title: string; outcome: string; status: string }[]>([]);
  const [open, setOpen] = useState<any>(null);

  useEffect(() => { api.courses().then(setCourses).catch(() => setCourses([])); }, []);
  const load = (id: string) => api.course(id).then(setOpen).catch(() => setOpen(null));

  return (
    <>
      <h1>Courses</h1>
      <div className="sub">The curriculum. Lessons are briefs — the Trainer renders each one personally for every learner.</div>

      {courses.length === 0 ? <Empty>No courses yet. Seed one (`npm run seed:lms` in service/).</Empty> : (
        <div className="cards">
          {courses.map((c) => (
            <div key={c.course_id} className="card" onClick={() => load(c.course_id)}>
              <div className="label">{c.status}</div>
              <div style={{ fontFamily: "var(--serif)", fontSize: 20, margin: "6px 0" }}>{c.title}</div>
              <div className="hint">{c.outcome}</div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Panel title={open.title}>
          {(open.modules ?? []).map((m: any) => (
            <div key={m.module_id} style={{ padding: "10px 0", borderTop: "1px solid var(--line2)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <b>{m.title}</b>
                {m.milestone && <span className="pill accent">🎯 {m.milestone.title}</span>}
              </div>
              {m.human_spine && <div className="sub" style={{ margin: "4px 0" }}>Human spine: {m.human_spine}</div>}
              <div style={{ marginTop: 6 }}>
                {(m.lessons ?? []).map((l: any) => (
                  <div key={l.lesson_id} style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
                    <span className="pill" style={{ minWidth: 64, justifyContent: "center" }}>{l.type}</span>
                    <span>{l.title}</span>
                    <span className="sub mono" style={{ marginLeft: "auto" }}>{l.competency_id}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

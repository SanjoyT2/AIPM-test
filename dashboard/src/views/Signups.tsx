import { useEffect, useState } from "react";
import { api, fmtTime } from "../api";
import { Empty } from "../components";
import type { CourseSummary, Signup } from "../types";

/**
 * Signups — the real people who came through the landing page, and the one place to
 * turn a registrant into an enrolled learner. This is PII, so the list is fetched
 * with the operator key rather than being public like /api/signup/stats.
 */
export default function Signups() {
  const [rows, setRows] = useState<Signup[] | null>(null);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [course, setCourse] = useState("");
  const [filter, setFilter] = useState<"all" | "verified" | "pending">("all");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () =>
    api.signups()
      .then((r) => { setRows(r); setErr(null); })
      .catch((e) => { setRows([]); setErr(e instanceof Error ? e.message : String(e)); });

  useEffect(() => { reload(); }, []);
  useEffect(() => {
    api.courses()
      .then((cs) => {
        setCourses(cs);
        // Default to a published course — enrolling into a draft is almost never intended.
        setCourse((cs.find((c) => c.status === "published") ?? cs[0])?.course_id ?? "");
      })
      .catch(() => setCourses([]));
  }, []);

  const enroll = async (s: Signup) => {
    if (!course) return;
    setBusy(s.learner_id); setErr(null); setNote(null);
    try {
      await api.enroll(s.learner_id, course);
      setNote(`Enrolled ${s.name ?? s.learner_id} into ${courses.find((c) => c.course_id === course)?.title ?? course}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = (rows ?? []).filter((r) => filter === "all" || r.status === filter);
  const verified = (rows ?? []).filter((r) => r.status === "verified").length;
  const pending = (rows ?? []).filter((r) => r.status === "pending").length;

  return (
    <>
      <h1>Signups</h1>
      <div className="sub">Everyone who started at the landing page. Verified means they confirmed the WhatsApp code.</div>

      {err && <div className="banner danger" onClick={() => setErr(null)}>⚠︎ {err} <span className="sub">(click to dismiss)</span></div>}
      {note && <div className="banner ok" onClick={() => setNote(null)}>✓ {note} <span className="sub">(click to dismiss)</span></div>}

      <div className="filters">
        {(["all", "verified", "pending"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? `All ${rows ? `(${rows.length})` : ""}` : f === "verified" ? `Verified (${verified})` : `Pending (${pending})`}
          </button>
        ))}
        <span style={{ marginLeft: "auto" }} className="sub">Enroll into</span>
        <select className="chip" value={course} onChange={(e) => setCourse(e.target.value)}>
          {courses.length === 0 && <option value="">No courses</option>}
          {courses.map((c) => <option key={c.course_id} value={c.course_id}>{c.title}{c.status !== "published" ? " (draft)" : ""}</option>)}
        </select>
        <button className="chip" onClick={reload}>Refresh</button>
      </div>

      {rows === null ? <div className="sub">Loading…</div>
        : shown.length === 0 ? <Empty>{rows.length === 0 ? "No signups yet. Share the landing page to start the funnel." : "Nothing matches this filter."}</Empty>
        : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Registered</th><th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.learner_id}>
                  <td>{s.name ?? <span className="sub">—</span>}</td>
                  <td className="mono">{s.phone}</td>
                  <td className="mono">{s.email ?? <span className="sub">—</span>}</td>
                  <td>
                    <span className={`pill ${s.status === "verified" ? "ok" : "warn"}`}>{s.status}</span>
                  </td>
                  <td className="sub">{fmtTime(s.created_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="chip"
                      disabled={!course || busy === s.learner_id}
                      title={s.status === "pending" ? "This learner has not verified their number yet" : "Enroll into the selected course"}
                      onClick={() => enroll(s)}
                    >
                      {busy === s.learner_id ? "Enrolling…" : "Enroll"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </>
  );
}

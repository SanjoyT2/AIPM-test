import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import { LESSON_TYPES, type CourseDetail, type CourseSummary, type LessonType, type ModuleRow } from "../types";

/**
 * Courses — the authoring surface. Course -> modules (weeks) -> lessons (briefs),
 * plus the milestone each module has to clear. Every write here goes through the
 * operator-gated endpoints, so the key is prompted for once and cached per browser.
 */
export default function Courses() {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [open, setOpen] = useState<CourseDetail | null>(null);
  const [comps, setComps] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadCourses = () => api.courses().then(setCourses).catch(() => setCourses([]));
  const load = (id: string) => api.course(id).then(setOpen).catch(() => setOpen(null));

  useEffect(() => { reloadCourses(); }, []);

  // Competency IDs come from the framework itself — never hardcode the list here,
  // or the picker silently drifts when the SME edits the YAML.
  useEffect(() => {
    api.framework("competency-framework")
      .then((f: any) => {
        const flat: { id: string; name: string }[] = [];
        for (const lvl of f?.levels ?? []) for (const c of lvl.competencies ?? []) flat.push({ id: c.id, name: c.name });
        for (const c of f?.cross_cutting ?? []) flat.push({ id: c.id, name: c.name });
        setComps(flat);
      })
      .catch(() => setComps([]));
  }, []);

  /** Wraps a write so one failure surfaces as a message instead of a dead button. */
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setErr(null);
    try { await fn(); after?.(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h1>Courses</h1>
      <div className="sub">The curriculum. Lessons are briefs — the Trainer renders each one personally for every learner.</div>

      {err && <div className="banner danger" onClick={() => setErr(null)}>⚠︎ {err} <span className="sub">(click to dismiss)</span></div>}

      <NewCourse busy={busy} onCreate={(t, o) => run(() => api.createCourse(t, o), () => reloadCourses())} />

      {courses.length === 0 ? <Empty>No courses yet. Create the first one above.</Empty> : (
        <div className="cards">
          {courses.map((c) => (
            <div key={c.course_id} className={`card ${open?.course_id === c.course_id ? "on" : ""}`} onClick={() => load(c.course_id)}>
              <div className="label">
                <span className={`pill ${c.status === "published" ? "ok" : ""}`}>{c.status}</span>
              </div>
              <div style={{ fontFamily: "var(--serif)", fontSize: 20, margin: "6px 0" }}>{c.title}</div>
              <div className="hint">{c.outcome}</div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <>
          <div className="filters" style={{ marginTop: 22 }}>
            <b style={{ fontFamily: "var(--serif)", fontSize: 22, marginRight: "auto" }}>{open.title}</b>
            <button
              className="chip"
              disabled={busy}
              onClick={() => run(
                () => api.setCourseStatus(open.course_id, open.status === "published" ? "draft" : "published"),
                () => { load(open.course_id); reloadCourses(); },
              )}
            >
              {open.status === "published" ? "Unpublish" : "Publish"}
            </button>
          </div>

          {(open.modules ?? []).length === 0 && <Empty>No modules yet. Add the first week below.</Empty>}

          {(open.modules ?? []).map((m) => (
            <ModuleBlock
              key={m.module_id}
              module={m}
              comps={comps}
              busy={busy}
              onAddLesson={(l) => run(() => api.addLesson(m.module_id, l), () => load(open.course_id))}
              onDeleteLesson={(id) => run(() => api.deleteLesson(id), () => load(open.course_id))}
            />
          ))}

          <NewModule
            busy={busy}
            comps={comps}
            nextOrder={(open.modules ?? []).length + 1}
            onCreate={(m) => run(() => api.addModule(open.course_id, m), () => load(open.course_id))}
          />
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- new course */

function NewCourse({ busy, onCreate }: { busy: boolean; onCreate: (title: string, outcome: string) => void }) {
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");

  if (!show) return (
    <div className="filters">
      <button className="chip on" onClick={() => setShow(true)}>+ New course</button>
    </div>
  );

  return (
    <Panel title="New course">
      <div className="form">
        <label>
          <span>Title</span>
          <input className="chip" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="AIE Foundation (6 weeks)" />
        </label>
        <label>
          <span>Outcome</span>
          <input className="chip" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What the learner can do at the end." />
        </label>
      </div>
      <div className="filters">
        <button
          className="chip on"
          disabled={busy || !title.trim()}
          onClick={() => { onCreate(title.trim(), outcome.trim()); setTitle(""); setOutcome(""); setShow(false); }}
        >
          Create course
        </button>
        <button className="chip" onClick={() => setShow(false)}>Cancel</button>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- new module */

function NewModule({
  busy, comps, nextOrder, onCreate,
}: {
  busy: boolean;
  comps: { id: string; name: string }[];
  nextOrder: number;
  onCreate: (m: { title: string; order: number; competencies: string[]; human_spine?: string; milestone?: { title: string; definition_of_done: string } }) => void;
}) {
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [order, setOrder] = useState(nextOrder);
  const [picked, setPicked] = useState<string[]>([]);
  const [spine, setSpine] = useState("");
  const [msTitle, setMsTitle] = useState("");
  const [msDod, setMsDod] = useState("");

  useEffect(() => { setOrder(nextOrder); }, [nextOrder]);

  if (!show) return (
    <div className="filters" style={{ marginTop: 14 }}>
      <button className="chip on" onClick={() => setShow(true)}>+ Add module (week)</button>
    </div>
  );

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Panel title="New module">
      <div className="form">
        <label>
          <span>Title</span>
          <input className="chip" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Week 1 — Prompting that survives a client" />
        </label>
        <label>
          <span>Order</span>
          <input className="chip" type="number" min={1} value={order} onChange={(e) => setOrder(Number(e.target.value))} />
        </label>
        <label>
          <span>Human spine</span>
          <input className="chip" value={spine} onChange={(e) => setSpine(e.target.value)} placeholder="The offline work this week — e.g. shadow one client call" />
        </label>
        <label>
          <span>Milestone</span>
          <input className="chip" value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder="First working prompt in production" />
        </label>
        <label>
          <span>Definition of done</span>
          <input className="chip" value={msDod} onChange={(e) => setMsDod(e.target.value)} placeholder="How you know it's genuinely finished." />
        </label>
      </div>

      <h3 style={{ marginTop: 14 }}>Competencies this module builds</h3>
      <div className="filters">
        {comps.length === 0 && <span className="sub">Framework not loaded.</span>}
        {comps.map((c) => (
          <button key={c.id} className={`chip ${picked.includes(c.id) ? "on" : ""}`} title={c.name} onClick={() => toggle(c.id)}>
            {c.id}
          </button>
        ))}
      </div>

      <div className="filters">
        <button
          className="chip on"
          disabled={busy || !title.trim()}
          onClick={() => {
            onCreate({
              title: title.trim(),
              order,
              competencies: picked,
              human_spine: spine.trim() || undefined,
              // A milestone needs both halves to mean anything; send it only when complete.
              milestone: msTitle.trim() && msDod.trim() ? { title: msTitle.trim(), definition_of_done: msDod.trim() } : undefined,
            });
            setTitle(""); setPicked([]); setSpine(""); setMsTitle(""); setMsDod(""); setShow(false);
          }}
        >
          Add module
        </button>
        <button className="chip" onClick={() => setShow(false)}>Cancel</button>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------- module block + lessons */

function ModuleBlock({
  module: m, comps, busy, onAddLesson, onDeleteLesson,
}: {
  module: ModuleRow;
  comps: { id: string; name: string }[];
  busy: boolean;
  onAddLesson: (l: { order: number; type: LessonType; competency_id: string; title: string; objective: string; key_points: string[]; pass_mark: number }) => void;
  onDeleteLesson: (lessonId: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [type, setType] = useState<LessonType>("micro");
  const [comp, setComp] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [points, setPoints] = useState("");
  const [pass, setPass] = useState(60);

  // Default the competency to one the module already claims to build.
  const options = m.competencies?.length ? comps.filter((c) => m.competencies!.includes(c.id)) : comps;
  useEffect(() => { if (!comp && options.length) setComp(options[0].id); }, [options, comp]);

  const lessons = m.lessons ?? [];

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <b>{m.order}. {m.title}</b>
        {m.milestone && <span className="pill accent">🎯 {m.milestone.title}</span>}
      </div>
      {m.human_spine && <div className="sub" style={{ margin: "4px 0" }}>Human spine: {m.human_spine}</div>}

      <div style={{ marginTop: 8 }}>
        {lessons.length === 0 && <div className="sub">No lessons yet.</div>}
        {lessons.map((l) => (
          <div key={l.lesson_id} className="lesson-row">
            <span className="pill" style={{ minWidth: 64, justifyContent: "center" }}>{l.type}</span>
            <span>{l.title}</span>
            <span className="sub mono" style={{ marginLeft: "auto" }}>{l.competency_id}</span>
            <button
              className="chip danger-hover"
              disabled={busy}
              title="Delete lesson"
              onClick={() => { if (confirm(`Delete lesson "${l.title}"? This cannot be undone.`)) onDeleteLesson(l.lesson_id); }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {!show ? (
        <div className="filters">
          <button className="chip" onClick={() => setShow(true)}>+ Add lesson</button>
        </div>
      ) : (
        <>
          <h3 style={{ marginTop: 14 }}>New lesson</h3>
          <div className="form">
            <label>
              <span>Type</span>
              <select className="chip" value={type} onChange={(e) => setType(e.target.value as LessonType)}>
                {LESSON_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>
              <span>Competency</span>
              <select className="chip" value={comp} onChange={(e) => setComp(e.target.value)}>
                {options.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
              </select>
            </label>
            <label>
              <span>Title</span>
              <input className="chip" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Anatomy of a durable prompt" />
            </label>
            <label>
              <span>Objective</span>
              <input className="chip" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What the learner can do after this lesson." />
            </label>
            <label>
              <span>Key points</span>
              <input className="chip" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="One per line or comma-separated" />
            </label>
            <label>
              <span>Pass mark</span>
              <input className="chip" type="number" min={0} max={100} value={pass} onChange={(e) => setPass(Number(e.target.value))} />
            </label>
          </div>
          <div className="filters">
            <button
              className="chip on"
              disabled={busy || !title.trim() || !objective.trim() || !comp}
              onClick={() => {
                onAddLesson({
                  order: lessons.length + 1,
                  type,
                  competency_id: comp,
                  title: title.trim(),
                  objective: objective.trim(),
                  key_points: points.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
                  pass_mark: pass,
                });
                setTitle(""); setObjective(""); setPoints(""); setShow(false);
              }}
            >
              Add lesson
            </button>
            <button className="chip" onClick={() => setShow(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

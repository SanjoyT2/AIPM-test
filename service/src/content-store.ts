/**
 * LMS store — Course → Module → Lesson, plus Enrollment + Progress.
 *
 * A LESSON is a BRIEF, not fixed text: an objective + key points the Trainer agent
 * renders into hyper-personalized content per learner at delivery (see learning.ts).
 * Operators author the briefs and the journey; the agent produces each learner's
 * actual content. Assessment answers become evidence events (measurement engine).
 *
 * Postgres JSONB / in-memory, same pattern as the other stores.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS courses     (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS modules     (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  course_id TEXT GENERATED ALWAYS AS (doc->>'course_id') STORED,
  ord INT GENERATED ALWAYS AS ((doc->>'order')::int) STORED);
CREATE TABLE IF NOT EXISTS lessons     (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  module_id TEXT GENERATED ALWAYS AS (doc->>'module_id') STORED,
  ord INT GENERATED ALWAYS AS ((doc->>'order')::int) STORED);
CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  learner_id TEXT GENERATED ALWAYS AS (doc->>'learner_id') STORED,
  course_id TEXT GENERATED ALWAYS AS (doc->>'course_id') STORED,
  status TEXT GENERATED ALWAYS AS (doc->>'status') STORED);
CREATE INDEX IF NOT EXISTS idx_mod_course ON modules (course_id, ord);
CREATE INDEX IF NOT EXISTS idx_les_module ON lessons (module_id, ord);
CREATE INDEX IF NOT EXISTS idx_enr_learner ON enrollments (learner_id);
CREATE TABLE IF NOT EXISTS lms_progress (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  learner_id TEXT GENERATED ALWAYS AS (doc->>'learner_id') STORED);
`;

export type LessonType = "micro" | "quiz" | "task" | "roleplay";
export interface Course { course_id: string; title: string; outcome: string; status: "draft" | "published"; ts: string; }
export interface Milestone { title: string; definition_of_done: string; }
export interface Module { module_id: string; course_id: string; title: string; order: number; competencies: string[]; milestone?: Milestone; human_spine?: string; ts: string; }
/** A learner's ONE business solution — the spine of the FDE program. */
export interface Project { project_id: string; learner_id: string; title: string; stakeholder: string; problem: string; success_metric: string; status: "scoping" | "building" | "deployed" | "handed_over"; ts: string; }
export interface Lesson {
  lesson_id: string; module_id: string; order: number;
  type: LessonType; competency_id: string; title: string;
  objective: string;            // the brief: what to teach / assess
  key_points: string[];         // guidance the agent must cover
  difficulty: "intro" | "core" | "stretch";
  personalize: boolean;         // micro/task rendered per-learner by the Trainer
  pass_mark: number;            // assessed types
  ts: string;
}
export interface Enrollment { enrollment_id: string; learner_id: string; course_id: string; status: "active" | "completed"; started_at: string; ts: string; }
export interface Progress { id: string; learner_id: string; course_id: string; completed: string[]; awaiting_lesson_id: string | null; awaiting_item?: string; updated_at: string; }

/** A resolved journey step: a lesson with its module context. */
export interface JourneyStep extends Lesson { module_title: string; }

export class LmsStore {
  private pool: pg.Pool | null = null;
  private mem = { courses: [] as Course[], modules: [] as Module[], lessons: [] as Lesson[], enrollments: [] as Enrollment[], progress: [] as Progress[], projects: [] as Project[] };

  async init(pool: pg.Pool | null): Promise<void> { this.pool = pool; if (pool) await pool.query(DDL); }
  private now() { return new Date().toISOString(); }
  private async ins(table: string, id: string, doc: unknown): Promise<void> {
    if (this.pool) await this.pool.query(`INSERT INTO ${table} (id, doc, ts) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc, ts=EXCLUDED.ts`, [id, JSON.stringify(doc), this.now()]);
  }

  // ---- Courses ----
  async createCourse(title: string, outcome: string): Promise<Course> {
    const c: Course = { course_id: `crs-${randomUUID()}`, title, outcome, status: "draft", ts: this.now() };
    if (this.pool) await this.ins("courses", c.course_id, c); else this.mem.courses.push(c);
    return c;
  }
  async listCourses(): Promise<Course[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM courses ORDER BY ts")).rows.map((r) => r.doc);
    return [...this.mem.courses];
  }
  async getCourse(id: string): Promise<Course | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM courses WHERE id=$1", [id])).rows[0]?.doc ?? null;
    return this.mem.courses.find((c) => c.course_id === id) ?? null;
  }
  async setCourseStatus(id: string, status: Course["status"]): Promise<void> {
    const c = await this.getCourse(id); if (!c) return; c.status = status;
    if (this.pool) await this.ins("courses", id, c); else this.mem.courses = this.mem.courses.map((x) => x.course_id === id ? c : x);
  }

  // ---- Modules ----
  async addModule(courseId: string, title: string, order: number, competencies: string[], extra?: { milestone?: Milestone; human_spine?: string }): Promise<Module> {
    const m: Module = { module_id: `mod-${randomUUID()}`, course_id: courseId, title, order, competencies, milestone: extra?.milestone, human_spine: extra?.human_spine, ts: this.now() };
    if (this.pool) await this.ins("modules", m.module_id, m); else this.mem.modules.push(m);
    return m;
  }
  async listModules(courseId: string): Promise<Module[]> {
    let rows: Module[];
    if (this.pool) rows = (await this.pool.query("SELECT doc FROM modules WHERE course_id=$1 ORDER BY ord", [courseId])).rows.map((r) => r.doc);
    else rows = this.mem.modules.filter((m) => m.course_id === courseId);
    return rows.sort((a, b) => a.order - b.order);
  }

  // ---- Lessons ----
  async addLesson(moduleId: string, l: Omit<Lesson, "lesson_id" | "module_id" | "ts">): Promise<Lesson> {
    const lesson: Lesson = { ...l, lesson_id: `les-${randomUUID()}`, module_id: moduleId, ts: this.now() };
    if (this.pool) await this.ins("lessons", lesson.lesson_id, lesson); else this.mem.lessons.push(lesson);
    return lesson;
  }
  async listLessons(moduleId: string): Promise<Lesson[]> {
    let rows: Lesson[];
    if (this.pool) rows = (await this.pool.query("SELECT doc FROM lessons WHERE module_id=$1 ORDER BY ord", [moduleId])).rows.map((r) => r.doc);
    else rows = this.mem.lessons.filter((l) => l.module_id === moduleId);
    return rows.sort((a, b) => a.order - b.order);
  }
  async getLesson(id: string): Promise<Lesson | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM lessons WHERE id=$1", [id])).rows[0]?.doc ?? null;
    return this.mem.lessons.find((l) => l.lesson_id === id) ?? null;
  }
  async updateLesson(id: string, patch: Partial<Lesson>): Promise<Lesson | null> {
    const cur = await this.getLesson(id); if (!cur) return null;
    const next = { ...cur, ...patch, lesson_id: id, ts: this.now() };
    if (this.pool) await this.ins("lessons", id, next); else this.mem.lessons = this.mem.lessons.map((l) => l.lesson_id === id ? next : l);
    return next;
  }
  async deleteLesson(id: string): Promise<void> {
    if (this.pool) await this.pool.query("DELETE FROM lessons WHERE id=$1", [id]); else this.mem.lessons = this.mem.lessons.filter((l) => l.lesson_id !== id);
  }

  /** The ordered journey = every lesson across the course's modules, in order. */
  async courseJourney(courseId: string): Promise<JourneyStep[]> {
    const mods = await this.listModules(courseId);
    const steps: JourneyStep[] = [];
    for (const m of mods) for (const l of await this.listLessons(m.module_id)) steps.push({ ...l, module_title: m.title });
    return steps;
  }

  // ---- Enrollment ----
  async enroll(learnerId: string, courseId: string): Promise<Enrollment> {
    const e: Enrollment = { enrollment_id: `enr-${learnerId}-${courseId}`, learner_id: learnerId, course_id: courseId, status: "active", started_at: this.now(), ts: this.now() };
    if (this.pool) await this.ins("enrollments", e.enrollment_id, e); else { this.mem.enrollments = this.mem.enrollments.filter((x) => x.enrollment_id !== e.enrollment_id); this.mem.enrollments.push(e); }
    return e;
  }
  async activeEnrollment(learnerId: string): Promise<Enrollment | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM enrollments WHERE learner_id=$1 AND status='active' ORDER BY ts DESC LIMIT 1", [learnerId])).rows[0]?.doc ?? null;
    return this.mem.enrollments.filter((e) => e.learner_id === learnerId && e.status === "active").at(-1) ?? null;
  }
  async completeEnrollment(learnerId: string, courseId: string): Promise<void> {
    const id = `enr-${learnerId}-${courseId}`;
    let e: Enrollment | null;
    if (this.pool) e = (await this.pool.query("SELECT doc FROM enrollments WHERE id=$1", [id])).rows[0]?.doc ?? null;
    else e = this.mem.enrollments.find((x) => x.enrollment_id === id) ?? null;
    if (!e) return;
    e.status = "completed";
    if (this.pool) await this.ins("enrollments", id, e);
    else this.mem.enrollments = this.mem.enrollments.map((x) => x.enrollment_id === id ? e! : x);
  }
  async listEnrollments(courseId?: string): Promise<Enrollment[]> {
    if (this.pool) {
      const r = courseId ? await this.pool.query("SELECT doc FROM enrollments WHERE course_id=$1", [courseId]) : await this.pool.query("SELECT doc FROM enrollments");
      return r.rows.map((x) => x.doc);
    }
    return this.mem.enrollments.filter((e) => !courseId || e.course_id === courseId);
  }

  // ---- Progress ----
  async getProgress(learnerId: string, courseId: string): Promise<Progress> {
    const id = `prg-${learnerId}-${courseId}`;
    let p: Progress | null;
    if (this.pool) p = (await this.pool.query("SELECT doc FROM lms_progress WHERE id=$1", [id])).rows[0]?.doc ?? null;
    else p = this.mem.progress.find((x) => x.id === id) ?? null;
    return p ?? { id, learner_id: learnerId, course_id: courseId, completed: [], awaiting_lesson_id: null, updated_at: this.now() };
  }
  async saveProgress(p: Progress): Promise<void> {
    p.updated_at = this.now();
    if (this.pool) await this.ins("lms_progress", p.id, p);
    else { this.mem.progress = this.mem.progress.filter((x) => x.id !== p.id); this.mem.progress.push(p); }
  }
  async nextStep(learnerId: string, courseId: string): Promise<JourneyStep | null> {
    const p = await this.getProgress(learnerId, courseId);
    const done = new Set(p.completed);
    return (await this.courseJourney(courseId)).find((s) => !done.has(s.lesson_id)) ?? null;
  }

  /** Per-module completion for a learner — the weekly milestone view. */
  async moduleProgress(learnerId: string, courseId: string): Promise<{ module: Module; done: number; total: number; complete: boolean }[]> {
    const p = await this.getProgress(learnerId, courseId);
    const done = new Set(p.completed);
    const mods = await this.listModules(courseId);
    const out = [];
    for (const m of mods) {
      const lessons = await this.listLessons(m.module_id);
      const n = lessons.filter((l) => done.has(l.lesson_id)).length;
      out.push({ module: m, done: n, total: lessons.length, complete: lessons.length > 0 && n === lessons.length });
    }
    return out;
  }

  // ---- Project (the learner's one solution) ----
  async setProject(p: Omit<Project, "project_id" | "ts">): Promise<Project> {
    const proj: Project = { ...p, project_id: `prj-${p.learner_id}`, ts: this.now() };
    if (this.pool) await this.ins("projects", proj.project_id, proj);
    else { this.mem.projects = this.mem.projects.filter((x) => x.learner_id !== p.learner_id); this.mem.projects.push(proj); }
    return proj;
  }
  async getProject(learnerId: string): Promise<Project | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM projects WHERE learner_id=$1", [learnerId])).rows[0]?.doc ?? null;
    return this.mem.projects.find((x) => x.learner_id === learnerId) ?? null;
  }
}

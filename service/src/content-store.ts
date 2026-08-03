/**
 * LMS store — Course → Module → Lesson, plus Enrollment + Progress + Project.
 * MongoDB implementation.
 *
 * A LESSON is a BRIEF, not fixed text: an objective + key points the Trainer agent
 * renders into hyper-personalized content per learner at delivery (see learning.ts).
 */
import { randomUUID } from "node:crypto";
import type { Db, Collection } from "mongodb";

export type LessonType = "micro" | "quiz" | "task" | "roleplay";
export interface Course { course_id: string; title: string; outcome: string; status: "draft" | "published"; ts: string; }
export interface Milestone { title: string; definition_of_done: string; }
export interface Module { module_id: string; course_id: string; title: string; order: number; competencies: string[]; milestone?: Milestone; human_spine?: string; ts: string; }
/** A learner's ONE business solution — the spine of the FDE program. */
export interface Project { project_id: string; learner_id: string; title: string; stakeholder: string; problem: string; success_metric: string; status: "scoping" | "building" | "deployed" | "handed_over"; ts: string; }
export interface Lesson {
  lesson_id: string; module_id: string; order: number;
  type: LessonType; competency_id: string; title: string;
  objective: string;
  key_points: string[];
  difficulty: "intro" | "core" | "stretch";
  personalize: boolean;
  pass_mark: number;
  ts: string;
}
export interface Enrollment { enrollment_id: string; learner_id: string; course_id: string; status: "active" | "completed"; started_at: string; ts: string; }
export interface Progress {
  id: string; learner_id: string; course_id: string;
  completed: string[]; awaiting_lesson_id: string | null; awaiting_item?: string;
  /** The personalized content most recently served on WhatsApp — what the web view shows. */
  last_rendered?: { lesson_id: string; title: string; module_title: string; body: string; at: string };
  updated_at: string;
  diagnostic_stage?: "not_started" | "m1" | "m2" | "m3" | "m4" | "completed";
  diagnostic_scores?: Record<string, number>;
  skipped_modules?: string[];
}

/** A resolved journey step: a lesson with its module context. */
export interface JourneyStep extends Lesson { module_title: string; }

export class LmsStore {
  private db: Db | null = null;
  private col: { courses: Collection; modules: Collection; lessons: Collection; enrollments: Collection; progress: Collection; projects: Collection } | null = null;
  private mem = {
    courses: [] as Course[], modules: [] as Module[], lessons: [] as Lesson[],
    enrollments: [] as Enrollment[], progress: [] as Progress[], projects: [] as Project[],
  };

  async init(db: Db | null): Promise<void> {
    if (!db) return;
    this.db = db;
    this.col = {
      courses: db.collection("courses"),
      modules: db.collection("modules"),
      lessons: db.collection("lessons"),
      enrollments: db.collection("enrollments"),
      progress: db.collection("lms_progress"),
      projects: db.collection("projects"),
    };
    await this.col.modules.createIndex({ course_id: 1, order: 1 });
    await this.col.lessons.createIndex({ module_id: 1, order: 1 });
    await this.col.enrollments.createIndex({ learner_id: 1 });
    await this.col.projects.createIndex({ learner_id: 1 });
  }

  private now() { return new Date().toISOString(); }

  private async upsert(col: Collection, id: string, doc: unknown): Promise<void> {
    await col.replaceOne({ _id: id as any }, { _id: id as any, ...(doc as any) }, { upsert: true });
  }

  private strip<T>(doc: any): T { const { _id, ...rest } = doc; return rest as T; }

  // ---- Courses ----
  async createCourse(title: string, outcome: string): Promise<Course> {
    const c: Course = { course_id: `crs-${randomUUID()}`, title, outcome, status: "draft", ts: this.now() };
    if (this.col) await this.upsert(this.col.courses, c.course_id, c); else this.mem.courses.push(c);
    return c;
  }
  async listCourses(): Promise<Course[]> {
    if (this.col) return (await this.col.courses.find({}).sort({ ts: 1 }).toArray()).map((d) => this.strip<Course>(d));
    return [...this.mem.courses];
  }
  async getCourse(id: string): Promise<Course | null> {
    if (this.col) { const d = await this.col.courses.findOne({ _id: id as any }); return d ? this.strip<Course>(d) : null; }
    return this.mem.courses.find((c) => c.course_id === id) ?? null;
  }
  async setCourseStatus(id: string, status: Course["status"]): Promise<void> {
    const c = await this.getCourse(id); if (!c) return; c.status = status;
    if (this.col) await this.upsert(this.col.courses, id, c);
    else this.mem.courses = this.mem.courses.map((x) => x.course_id === id ? c : x);
  }

  // ---- Modules ----
  async addModule(courseId: string, title: string, order: number, competencies: string[], extra?: { milestone?: Milestone; human_spine?: string }): Promise<Module> {
    const m: Module = { module_id: `mod-${randomUUID()}`, course_id: courseId, title, order, competencies, milestone: extra?.milestone, human_spine: extra?.human_spine, ts: this.now() };
    if (this.col) await this.upsert(this.col.modules, m.module_id, m); else this.mem.modules.push(m);
    return m;
  }
  async listModules(courseId: string): Promise<Module[]> {
    if (this.col) return (await this.col.modules.find({ course_id: courseId }).sort({ order: 1 }).toArray()).map((d) => this.strip<Module>(d));
    return this.mem.modules.filter((m) => m.course_id === courseId).sort((a, b) => a.order - b.order);
  }

  // ---- Lessons ----
  async addLesson(moduleId: string, l: Omit<Lesson, "lesson_id" | "module_id" | "ts">): Promise<Lesson> {
    const lesson: Lesson = { ...l, lesson_id: `les-${randomUUID()}`, module_id: moduleId, ts: this.now() };
    if (this.col) await this.upsert(this.col.lessons, lesson.lesson_id, lesson); else this.mem.lessons.push(lesson);
    return lesson;
  }
  async listLessons(moduleId: string): Promise<Lesson[]> {
    if (this.col) return (await this.col.lessons.find({ module_id: moduleId }).sort({ order: 1 }).toArray()).map((d) => this.strip<Lesson>(d));
    return this.mem.lessons.filter((l) => l.module_id === moduleId).sort((a, b) => a.order - b.order);
  }
  async getLesson(id: string): Promise<Lesson | null> {
    if (this.col) { const d = await this.col.lessons.findOne({ _id: id as any }); return d ? this.strip<Lesson>(d) : null; }
    return this.mem.lessons.find((l) => l.lesson_id === id) ?? null;
  }
  async updateLesson(id: string, patch: Partial<Lesson>): Promise<Lesson | null> {
    const cur = await this.getLesson(id); if (!cur) return null;
    const next = { ...cur, ...patch, lesson_id: id, ts: this.now() };
    if (this.col) await this.upsert(this.col.lessons, id, next);
    else this.mem.lessons = this.mem.lessons.map((l) => l.lesson_id === id ? next : l);
    return next;
  }
  async deleteLesson(id: string): Promise<void> {
    if (this.col) await this.col.lessons.deleteOne({ _id: id as any });
    else this.mem.lessons = this.mem.lessons.filter((l) => l.lesson_id !== id);
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
    if (this.col) await this.upsert(this.col.enrollments, e.enrollment_id, e);
    else { this.mem.enrollments = this.mem.enrollments.filter((x) => x.enrollment_id !== e.enrollment_id); this.mem.enrollments.push(e); }
    return e;
  }
  async activeEnrollment(learnerId: string): Promise<Enrollment | null> {
    if (this.col) {
      const d = await this.col.enrollments.findOne({ learner_id: learnerId, status: "active" }, { sort: { ts: -1 } });
      return d ? this.strip<Enrollment>(d) : null;
    }
    return this.mem.enrollments.filter((e) => e.learner_id === learnerId && e.status === "active").at(-1) ?? null;
  }
  async completeEnrollment(learnerId: string, courseId: string): Promise<void> {
    const id = `enr-${learnerId}-${courseId}`;
    const e = await (this.col
      ? (async () => { const d = await this.col!.enrollments.findOne({ _id: id as any }); return d ? this.strip<Enrollment>(d) : null; })()
      : Promise.resolve(this.mem.enrollments.find((x) => x.enrollment_id === id) ?? null));
    if (!e) return;
    e.status = "completed";
    if (this.col) await this.upsert(this.col.enrollments, id, e);
    else this.mem.enrollments = this.mem.enrollments.map((x) => x.enrollment_id === id ? e! : x);
  }
  async listEnrollments(courseId?: string): Promise<Enrollment[]> {
    if (this.col) {
      const q = courseId ? { course_id: courseId } : {};
      return (await this.col.enrollments.find(q).toArray()).map((d) => this.strip<Enrollment>(d));
    }
    return this.mem.enrollments.filter((e) => !courseId || e.course_id === courseId);
  }

  // ---- Progress ----
  async getProgress(learnerId: string, courseId: string): Promise<Progress> {
    const id = `prg-${learnerId}-${courseId}`;
    let p: Progress | null = null;
    if (this.col) { const d = await this.col.progress.findOne({ _id: id as any }); p = d ? this.strip<Progress>(d) : null; }
    else p = this.mem.progress.find((x) => x.id === id) ?? null;
    return p ?? { id, learner_id: learnerId, course_id: courseId, completed: [], awaiting_lesson_id: null, updated_at: this.now() };
  }
  async saveProgress(p: Progress): Promise<void> {
    p.updated_at = this.now();
    if (this.col) await this.upsert(this.col.progress, p.id, p);
    else { this.mem.progress = this.mem.progress.filter((x) => x.id !== p.id); this.mem.progress.push(p); }
  }
  async nextStep(learnerId: string, courseId: string): Promise<JourneyStep | null> {
    const p = await this.getProgress(learnerId, courseId);
    const done = new Set(p.completed);
    const skipped = new Set(p.skipped_modules ?? []);
    return (await this.courseJourney(courseId)).find((s) => !done.has(s.lesson_id) && !skipped.has(s.module_id)) ?? null;
  }

  /** Per-module completion for a learner — the weekly milestone view. */
  async moduleProgress(learnerId: string, courseId: string): Promise<{ module: Module; done: number; total: number; complete: boolean }[]> {
    const p = await this.getProgress(learnerId, courseId);
    const done = new Set(p.completed);
    const skipped = new Set(p.skipped_modules ?? []);
    const mods = await this.listModules(courseId);
    const out = [];
    for (const m of mods) {
      const lessons = await this.listLessons(m.module_id);
      const isSkipped = skipped.has(m.module_id);
      const n = isSkipped ? lessons.length : lessons.filter((l) => done.has(l.lesson_id)).length;
      out.push({ module: m, done: n, total: lessons.length, complete: isSkipped || (lessons.length > 0 && n === lessons.length) });
    }
    return out;
  }

  // ---- Project (the learner's one solution) ----
  async setProject(p: Omit<Project, "project_id" | "ts">): Promise<Project> {
    const proj: Project = { ...p, project_id: `prj-${p.learner_id}`, ts: this.now() };
    if (this.col) await this.upsert(this.col.projects, proj.project_id, proj);
    else { this.mem.projects = this.mem.projects.filter((x) => x.learner_id !== p.learner_id); this.mem.projects.push(proj); }
    return proj;
  }
  async getProject(learnerId: string): Promise<Project | null> {
    if (this.col) { const d = await this.col.projects.findOne({ learner_id: learnerId }); return d ? this.strip<Project>(d) : null; }
    return this.mem.projects.find((x) => x.learner_id === learnerId) ?? null;
  }
}

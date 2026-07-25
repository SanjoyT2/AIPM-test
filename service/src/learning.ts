/**
 * Learning engine — walks a learner through a FIXED course journey over WhatsApp,
 * with HYPER-PERSONALIZED content and AGENT-DECIDED course progression.
 *
 * Design (locked with product):
 *   - Journey inside a course = fixed (authored order of modules/lessons).
 *   - Lesson content = generated per learner by the Trainer agent from the lesson
 *     brief + the learner's recent performance.
 *   - Which course comes NEXT = decided by the Advisor (Mentor) from the authored
 *     course catalog, at enrollment and at each course completion.
 *
 * One learner message advances one step. Assessment answers become evidence
 * events (measurement engine). Grading + generation run through the LLM gateway,
 * so they're metered like everything else.
 */
import { randomUUID } from "node:crypto";
import type { LmsStore, JourneyStep, Lesson } from "./content-store.js";
import type { DailyLoop } from "./daily-loop.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { LlmGateway } from "./gateway.js";
import type { EvidenceEvent } from "./types.js";

const isQuestion = (t: string) => /\?\s*$/.test(t) || /^\s*(help|doubt|samajh|question)\b/i.test(t);
const ACTIVITY: Record<Lesson["type"], EvidenceEvent["activity_type"]> = { micro: "quiz", quiz: "quiz", task: "task", roleplay: "gate_viva" };

export interface WalkResult {
  reply: string;
  course_id?: string;
  served_lesson_id?: string;
  graded?: { lesson_id: string; score: number; passed: boolean };
  event_id?: string;
  course_completed?: string;
  advisor?: { next_course_id: string | null; reason: string };
  done?: boolean;
}

export class LearningEngine {
  constructor(
    private lms: LmsStore,
    private evidence: EvidenceStore,
    private gateway: LlmGateway,
    private dailyLoop: DailyLoop,
    private frameworkVersion: string,
  ) {}

  async onMessage(learnerId: string, text: string): Promise<WalkResult> {
    let enr = await this.lms.activeEnrollment(learnerId);
    // No active course -> Advisor picks the first one from the catalog.
    if (!enr) {
      const pick = await this.advise(learnerId, null);
      if (!pick.next_course_id) return { reply: "No courses are published yet. Please check back soon.", advisor: pick };
      enr = await this.lms.enroll(learnerId, pick.next_course_id);
      const first = await this.serveNext(learnerId, enr.course_id);
      return { ...first, advisor: pick };
    }
    const courseId = enr.course_id;
    const p = await this.lms.getProgress(learnerId, courseId);

    // 1. Awaiting an assessment answer?
    if (p.awaiting_lesson_id) {
      const lesson = await this.lms.getLesson(p.awaiting_lesson_id);
      if (lesson && isQuestion(text)) {
        const { tx } = await this.dailyLoop.runAgent("mentor", learnerId, `Learner is mid-assessment on "${lesson.title}" and asks: ${text}. Coach without giving the answer.`, { baseSources: ["mid-assessment-doubt"] });
        return { reply: (tx.output as { text?: string })?.text ?? "" };
      }
      if (lesson) {
        const g = await this.grade(lesson, text, learnerId);
        p.completed.push(lesson.lesson_id); p.awaiting_lesson_id = null;
        await this.lms.saveProgress(p);
        const next = await this.serveNext(learnerId, courseId);
        const { reply: nextReply, ...nextRest } = next;
        return { reply: `${g.passed ? "✅" : "▫︎"} ${g.feedback}\n\n${nextReply}`, graded: { lesson_id: lesson.lesson_id, score: g.score, passed: g.passed }, event_id: g.event_id, ...nextRest };
      }
      p.awaiting_lesson_id = null; await this.lms.saveProgress(p);
    }

    // 2. A general question -> Mentor coaching.
    if (isQuestion(text)) {
      const { tx } = await this.dailyLoop.runAgent("mentor", learnerId, `Learner asks: ${text}`, { baseSources: ["learner-question"] });
      return { reply: (tx.output as { text?: string })?.text ?? "" };
    }

    // 3. Serve the next step.
    return this.serveNext(learnerId, courseId);
  }

  private async serveNext(learnerId: string, courseId: string): Promise<WalkResult> {
    const step = await this.lms.nextStep(learnerId, courseId);
    if (!step) return this.completeCourse(learnerId, courseId);

    if (step.type === "micro") {
      const body = await this.renderMicro(learnerId, step);
      const p = await this.lms.getProgress(learnerId, courseId);
      p.completed.push(step.lesson_id); await this.lms.saveProgress(p);
      return { reply: `📖 *${step.title}*  ·  _${step.module_title}_\n\n${body}\n\n_Send anything to continue._`, course_id: courseId, served_lesson_id: step.lesson_id };
    }
    const p = await this.lms.getProgress(learnerId, courseId);
    p.awaiting_lesson_id = step.lesson_id; await this.lms.saveProgress(p);
    const lead = step.type === "roleplay" ? "🎭 *Role-play*" : step.type === "task" ? "🛠️ *Task*" : "❓ *Quiz*";
    return { reply: `${lead} — ${step.title}\n\n${step.objective}\n\n_Reply with your answer._`, course_id: courseId, served_lesson_id: step.lesson_id };
  }

  /** Trainer renders the lesson brief into personalized content for this learner. */
  private async renderMicro(learnerId: string, step: JourneyStep): Promise<string> {
    if (!step.personalize) return step.objective;
    const ctx = await this.learnerContext(learnerId);
    const { tx } = await this.dailyLoop.runAgent("trainer", learnerId,
      `Write this micro-lesson personally for this learner. Keep it under 130 words, simple, warm, natural Hindi/English mix. Cover the key points; end with one line on why it matters for an MSME.\n\n` +
      `Lesson: ${step.title}\nObjective: ${step.objective}\nKey points: ${step.key_points.join("; ")}\nDifficulty: ${step.difficulty}\nLearner context: ${ctx}`,
      { baseSources: [`lesson:${step.lesson_id}`] });
    return (tx.output as { text?: string })?.text || step.objective;
  }

  /** Advisor (Mentor) picks the next course from the published catalog. */
  private async advise(learnerId: string, justCompletedCourseId: string | null): Promise<{ next_course_id: string | null; reason: string }> {
    const courses = (await this.lms.listCourses()).filter((c) => c.status === "published" && c.course_id !== justCompletedCourseId);
    const done = new Set((await this.lms.listEnrollments()).filter((e) => e.learner_id === learnerId && e.status === "completed").map((e) => e.course_id));
    const options = courses.filter((c) => !done.has(c.course_id));
    if (options.length === 0) return { next_course_id: null, reason: "No further courses available." };
    if (options.length === 1) return { next_course_id: options[0].course_id, reason: "Only one course available." };

    const ctx = await this.learnerContext(learnerId);
    const res = await this.gateway.complete({
      tier: "deep", role: "critic",
      system: "You are a learning advisor. Pick the single best next course for this learner from the options, based on their performance. Respond with ONLY JSON: {\"course_id\":\"...\",\"reason\":\"one line\"}.",
      user: `Learner context: ${ctx}\n\nOptions:\n${options.map((c) => `- ${c.course_id}: ${c.title} — ${c.outcome}`).join("\n")}`,
      maxTokens: 200,
    });
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
      const chosen = options.find((c) => c.course_id === j.course_id) ?? options[0];
      return { next_course_id: chosen.course_id, reason: String(j.reason || "Advisor selection.") };
    } catch { return { next_course_id: options[0].course_id, reason: "Default selection." }; }
  }

  private async completeCourse(learnerId: string, courseId: string): Promise<WalkResult> {
    await this.lms.completeEnrollment(learnerId, courseId);
    const pick = await this.advise(learnerId, courseId);
    if (!pick.next_course_id) {
      return { reply: "🎓 You've completed this course — and every course we have right now. Brilliant work. We'll message you when your next one opens.", course_completed: courseId, advisor: pick, done: true };
    }
    const next = await this.lms.enroll(learnerId, pick.next_course_id);
    const served = await this.serveNext(learnerId, next.course_id);
    const course = await this.lms.getCourse(pick.next_course_id);
    return { reply: `🎓 Course complete! Your advisor picked your next course: *${course?.title}* — ${pick.reason}\n\n${served.reply}`, course_completed: courseId, advisor: pick, course_id: next.course_id, served_lesson_id: served.served_lesson_id };
  }

  private async learnerContext(learnerId: string): Promise<string> {
    const evs = (await this.evidence.forLearner(learnerId)).slice(0, 8);
    if (!evs.length) return "New learner, no history yet.";
    const avg = Math.round(evs.reduce((a, e) => a + (e.score / e.scale_max) * 100, 0) / evs.length);
    const weak = evs.filter((e) => e.score / e.scale_max < 0.6).map((e) => e.competency_id);
    return `Recent avg ${avg}/100 over ${evs.length} items.` + (weak.length ? ` Weak on: ${[...new Set(weak)].join(", ")}.` : " Doing well.");
  }

  private async grade(lesson: Lesson, answer: string, learnerId: string): Promise<{ score: number; passed: boolean; feedback: string; event_id: string }> {
    const deep = lesson.type === "roleplay" || lesson.type === "task";
    const res = await this.gateway.complete({
      tier: deep ? "deep" : "fast", role: "critic",
      system: "You grade a learner's answer for a vocational AI-skills program. Fair, encouraging, honest. Respond with ONLY JSON: {\"score\":0-100,\"feedback\":\"one or two warm concrete lines\"}.",
      user: `Type: ${lesson.type}\nCompetency: ${lesson.competency_id}\nItem: ${lesson.objective}\nKey points: ${lesson.key_points.join("; ")}\n\nLearner's answer:\n${answer}`,
      maxTokens: 300,
    });
    let score = 0, feedback = "Recorded.";
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
      score = Math.max(0, Math.min(100, Number(j.score) || 0));
      feedback = String(j.feedback || feedback);
    } catch { score = res.stub ? 72 : 50; feedback = res.stub ? "Recorded (grading offline in test mode)." : "Recorded."; }
    const passed = score >= (lesson.pass_mark ?? 60);
    const ev: EvidenceEvent = {
      event_id: `ev-${randomUUID()}`, learner_id: learnerId, timestamp: new Date().toISOString(), source: "learning",
      competency_id: lesson.competency_id, activity_type: ACTIVITY[lesson.type],
      modality: lesson.type === "roleplay" ? "sync" : "async", stakes: lesson.type === "roleplay" ? "summative" : "formative",
      score, scale_max: 100, grader: { type: "llm", model: res.call.model }, framework_version: this.frameworkVersion, evidence_refs: [`lesson:${lesson.lesson_id}`],
    };
    await this.evidence.append(ev);
    return { score, passed, feedback, event_id: ev.event_id };
  }
}

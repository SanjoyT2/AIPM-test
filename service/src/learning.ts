/**
 * Learning engine — walks a learner through a FIXED course journey over WhatsApp,
 * with HYPER-PERSONALIZED content and AGENT-DECIDED course progression.
 */
import { randomUUID } from "node:crypto";
import type { LmsStore, JourneyStep, Lesson } from "./content-store.js";
import type { DailyLoop } from "./daily-loop.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { LlmGateway } from "./gateway.js";
import type { EvidenceEvent } from "./types.js";
import type { Signups } from "./signups.js";

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

const DIAG_QUESTIONS = [
  {
    stage: "m1" as const,
    nextStage: "m2" as const,
    title: "Question 1: Prompting & Scaffolding",
    competency: "L1.GENAI.PROMPTING",
    question: "Let's check your prompt engineering skills. You want to build a WhatsApp assistant that formats invoices from raw text. Draft a system prompt that specifies the role, structured JSON output format, and a constraint to reject invalid input.",
    rubric: "Score 60+ if prompt defines a clear role, requests valid JSON, and specifies a boundary constraint (e.g. refuse non-invoice text)."
  },
  {
    stage: "m2" as const,
    nextStage: "m3" as const,
    title: "Question 2: Grounding & Evaluation",
    competency: "L4.DOMAIN.MEASUREMENT",
    question: "Imagine your WhatsApp assistant is fetching answers from a database of product manuals (RAG) but keeps hallucinating fake features. What steps would you take to diagnose and solve this retrieval-quality issue?",
    rubric: "Score 60+ if they suggest checking chunk size/overlap, inspect retrieved manual text before generation, or construct an evaluation test set."
  },
  {
    stage: "m3" as const,
    nextStage: "m4" as const,
    title: "Question 3: Agents & Deployment",
    competency: "L3.AUTO.DELIVERY",
    question: "You want to deploy this assistant so a merchant's customers can use it live. Explain the technical differences between running your assistant locally in a Python script vs. deploying it as a live web service (using FastAPI and Docker) with environment secrets.",
    rubric: "Score 60+ if they mention that live service handles multiple concurrent webhook requests, environment variables keep secrets out of GitHub, and Docker isolates dependencies."
  },
  {
    stage: "m4" as const,
    nextStage: "completed" as const,
    title: "Question 4: Adoption & Communication",
    competency: "XC.COMMUNICATION",
    question: "After deploying, the merchant says they prefer typing orders manually in Excel because the assistant feels unfamiliar. In 3-4 sentences, how would you respond to address their objection and help them adopt the solution?",
    rubric: "Score 60+ if they demonstrate empathy, offer a quick onboarding walkthrough/demo, explain how it saves time, and propose starting with a small trial."
  }
];

export class LearningEngine {
  constructor(
    private lms: LmsStore,
    private evidence: EvidenceStore,
    private gateway: LlmGateway,
    private dailyLoop: DailyLoop,
    private frameworkVersion: string,
    private signups: Signups,
    /** Mints the learner's magic web-view link (null => no link line in replies). */
    private journeyLink?: (learnerId: string) => Promise<string | null>,
  ) {}

  /** "🔗 Dekho online: <link>" trailer for WhatsApp replies; empty when unavailable. */
  private async linkLine(learnerId: string): Promise<string> {
    try {
      const url = await this.journeyLink?.(learnerId);
      return url ? `\n\n🔗 View your journey: ${url}` : "";
    } catch {
      return "";
    }
  }

  /** Coach (AI Program Manager) weekly check-in over the learner's project + milestones. */
  async checkIn(learnerId: string, trigger = "weekly check-in"): Promise<{ message: string; status: string; flag_reason?: string }> {
    const enr = await this.lms.activeEnrollment(learnerId);
    const project = await this.lms.getProject(learnerId);
    const mods = enr ? await this.lms.moduleProgress(learnerId, enr.course_id) : [];
    const ctx = await this.learnerContext(learnerId);
    const modLine = mods.map((m) => `${m.module.title}: ${m.done}/${m.total}${m.module.milestone ? ` (milestone: ${m.module.milestone.title})` : ""}`).join(" | ");
    const { tx } = await this.dailyLoop.runAgent("coach", learnerId,
      `Trigger: ${trigger}.\nProject: ${project ? `${project.title} for ${project.stakeholder} — ${project.problem} — status ${project.status}` : "not scoped yet"}\n` +
      `Weekly progress: ${modLine || "not enrolled"}\nRecent performance: ${ctx}\n\n` +
      `Give a weekly check-in message, then on a final line output: STATUS: on_track|at_risk|flag — reason.`,
      { baseSources: ["coach-checkin"] });
    const text = (tx.output as { text?: string })?.text ?? "";
    const m = /STATUS:\s*(on_track|at_risk|flag)\s*[-—:]?\s*(.*)$/im.exec(text);
    const status = m?.[1]?.toLowerCase() ?? "on_track";
    return { message: text.replace(/STATUS:.*$/im, "").trim(), status, flag_reason: status === "flag" ? (m?.[2] || "stopped shipping") : undefined };
  }

  async onMessage(learnerId: string, text: string): Promise<WalkResult> {
    await this.signups.update(learnerId, { last_active_at: new Date().toISOString() }).catch(() => {});
    // 0. Onboarding check
    const learner = await this.signups.getByLearnerId(learnerId);
    if (learner && !learner.bypass_onboarding) {
      const kyc = learner.kyc ?? {};
      const needsId = kyc.id_status !== "verified";
      const needsCv = kyc.cv_status !== "received";
      if (needsId || needsCv) {
        let msg = "Welcome to Degree2Destiny! Before we begin your learning journey, we need to verify your onboarding details.\n\n";
        if (needsId && needsCv) {
          msg += "Please upload a clear photo/PDF of your Aadhaar card and share your CV/resume.";
        } else if (needsId) {
          msg += "We have received your CV. Please upload a clear photo/PDF of your Aadhaar card to complete your identity verification.";
        } else {
          msg += "We have verified your identity. Please upload your CV/resume to complete your profile.";
        }
        return { reply: msg };
      }
    }

    let enr = await this.lms.activeEnrollment(learnerId);
    // No active course -> Advisor picks the first one from the catalog.
    if (!enr) {
      const pick = await this.advise(learnerId, null);
      if (!pick.next_course_id) return { reply: "No courses are published yet. Please check back soon.", advisor: pick };
      enr = await this.lms.enroll(learnerId, pick.next_course_id);
    }
    const courseId = enr.course_id;
    const p = await this.lms.getProgress(learnerId, courseId);

    // 1. Diagnostic Placement Exam
    if (p.diagnostic_stage !== "completed") {
      const mods = await this.lms.listModules(courseId);
      const stage = p.diagnostic_stage ?? "not_started";
      
      if (stage === "not_started") {
        p.diagnostic_stage = "m1";
        await this.lms.saveProgress(p);
        const q = DIAG_QUESTIONS[0];
        return { reply: `Welcome! Let's start with a brief placement check to see if you can skip any modules. Here is Question 1 (Prompting & Foundations):\n\n${q.question}` };
      }

      const curIdx = DIAG_QUESTIONS.findIndex(q => q.stage === stage);
      if (curIdx !== -1) {
        const q = DIAG_QUESTIONS[curIdx];
        const g = await this.gradeDiagnostic(q.question, q.competency, q.rubric, text, learnerId);
        
        p.diagnostic_scores = p.diagnostic_scores ?? {};
        p.diagnostic_scores[q.title] = g.score;

        if (g.score >= 60 && mods[curIdx]) {
          p.skipped_modules = p.skipped_modules ?? [];
          p.skipped_modules.push(mods[curIdx].module_id);
        }

        const nextStage = q.nextStage;
        p.diagnostic_stage = nextStage;
        await this.lms.saveProgress(p);

        if (nextStage !== "completed") {
          const nextQ = DIAG_QUESTIONS[curIdx + 1];
          return { reply: `Score: ${g.score}/100 - ${g.feedback}\n\nHere is Question ${curIdx + 2} (${nextQ.title}):\n\n${nextQ.question}` };
        } else {
          let summary = `Placement check completed!\nYour scores:\n`;
          DIAG_QUESTIONS.forEach(dq => {
            summary += `▫︎ ${dq.title}: ${p.diagnostic_scores?.[dq.title] ?? 0}/100\n`;
          });
          
          const skippedNames = (p.skipped_modules ?? []).map(mid => {
            const m = mods.find(mod => mod.module_id === mid);
            return m ? m.title : "";
          }).filter(Boolean);

          if (skippedNames.length > 0) {
            summary += `\nBased on your scores, you have skipped:\n${skippedNames.map(n => `✅ ${n}`).join("\n")}\n\nWe will start your training on the remaining modules!`;
          } else {
            summary += `\nWe will start your training from the beginning!`;
          }

          const next = await this.serveNext(learnerId, courseId);
          const { reply: nextReply, ...nextRest } = next;
          return { reply: `${summary}\n\n${nextReply}`, ...nextRest };
        }
      }
    }

    // 2. Awaiting an assessment answer?
    if (p.awaiting_lesson_id) {
      const lesson = await this.lms.getLesson(p.awaiting_lesson_id);
      if (lesson && isQuestion(text)) {
        const { tx } = await this.dailyLoop.runAgent("mentor", learnerId, `Learner is mid-assessment on "${lesson.title}" and asks: ${text}. Coach without giving the answer.`, { baseSources: ["mid-assessment-doubt"] });
        return { reply: (tx.output as { text?: string })?.text ?? "" };
      }
      if (lesson) {
        const g = await this.grade(lesson, text, learnerId, p.awaiting_item);
        if (g.passed) {
          p.completed.push(lesson.lesson_id);
          p.awaiting_lesson_id = null;
          p.awaiting_item = undefined;
          await this.lms.saveProgress(p);
          const next = await this.serveNext(learnerId, courseId);
          const { reply: nextReply, ...nextRest } = next;
          return { reply: `✅ ${g.feedback}\n\n${nextReply}`, graded: { lesson_id: lesson.lesson_id, score: g.score, passed: g.passed }, event_id: g.event_id, ...nextRest };
        } else {
          // Gated: failed. Generate a new practice question of the same type.
          const step = await this.lms.nextStep(learnerId, courseId);
          if (step && step.lesson_id === lesson.lesson_id) {
            const newItem = await this.generateItem(learnerId, step);
            p.awaiting_item = newItem;
            p.last_rendered = { lesson_id: step.lesson_id, title: step.title, module_title: step.module_title, body: newItem, at: new Date().toISOString() };
            await this.lms.saveProgress(p);
            const lead = step.type === "roleplay" ? "🎭 *Role-play*" : step.type === "task" ? "🛠️ *Task*" : "❓ *Quiz*";
            const link = await this.linkLine(learnerId);
            return {
              reply: `▫︎ ${g.feedback}\n\nLet's try again! Here is an alternative prompt for ${lead} — ${step.title}:\n\n${newItem}\n\n_Reply with your answer._${link}`,
              graded: { lesson_id: lesson.lesson_id, score: g.score, passed: g.passed },
              event_id: g.event_id,
              course_id: courseId,
              served_lesson_id: step.lesson_id
            };
          }
        }
      }
      p.awaiting_lesson_id = null; await this.lms.saveProgress(p);
    }

    // 3. A general question -> Mentor coaching.
    if (isQuestion(text)) {
      const { tx } = await this.dailyLoop.runAgent("mentor", learnerId, `Learner asks: ${text}`, { baseSources: ["learner-question"] });
      return { reply: (tx.output as { text?: string })?.text ?? "" };
    }

    // 4. Serve the next step.
    return this.serveNext(learnerId, courseId);
  }

  private async serveNext(learnerId: string, courseId: string): Promise<WalkResult> {
    const step = await this.lms.nextStep(learnerId, courseId);
    if (!step) return this.completeCourse(learnerId, courseId);

    if (step.type === "micro") {
      const body = await this.renderMicro(learnerId, step);
      const p = await this.lms.getProgress(learnerId, courseId);
      p.completed.push(step.lesson_id);
      p.last_rendered = { lesson_id: step.lesson_id, title: step.title, module_title: step.module_title, body, at: new Date().toISOString() };
      await this.lms.saveProgress(p);
      const link = await this.linkLine(learnerId);
      return { reply: `📖 *${step.title}*  ·  _${step.module_title}_\n\n${body}\n\n_Send anything to continue._${link}`, course_id: courseId, served_lesson_id: step.lesson_id };
    }

    const item = await this.generateItem(learnerId, step);
    const p = await this.lms.getProgress(learnerId, courseId);
    p.awaiting_lesson_id = step.lesson_id; p.awaiting_item = item;
    p.last_rendered = { lesson_id: step.lesson_id, title: step.title, module_title: step.module_title, body: item, at: new Date().toISOString() };
    await this.lms.saveProgress(p);
    const lead = step.type === "roleplay" ? "🎭 *Role-play*" : step.type === "task" ? "🛠️ *Task*" : "❓ *Quiz*";
    const link = await this.linkLine(learnerId);
    return { reply: `${lead} — ${step.title}\n\n${item}\n\n_Reply with your answer._${link}`, course_id: courseId, served_lesson_id: step.lesson_id };
  }

  private async generateItem(learnerId: string, step: JourneyStep): Promise<string> {
    const ctx = await this.learnerContext(learnerId);
    const proj = await this.lms.getProject(learnerId);
    const { tx } = await this.dailyLoop.runAgent("assessor", learnerId,
      `Generate ONE ${step.type} assessment prompt for this learner (WhatsApp-answerable). Same competency and rigor, scenario tuned to them.\n\n` +
      `Objective: ${step.objective}\nKey points: ${step.key_points.join("; ")}\nDifficulty: ${step.difficulty}\n` +
      `Learner context: ${ctx}${proj ? `\nTheir project: ${proj.title} for ${proj.stakeholder} — ${proj.problem}` : ""}`,
      { baseSources: [`assess:${step.lesson_id}`] });
    return (tx.output as { text?: string })?.text?.trim() || step.objective;
  }

  private async advise(learnerId: string, completedCourseId: string | null): Promise<{ next_course_id: string | null; reason: string }> {
    const list = await this.lms.listCourses();
    const published = list.filter((c) => c.status === "published");
    if (!published.length) return { next_course_id: null, reason: "No courses are published." };

    if (!completedCourseId) {
      return { next_course_id: published[0].course_id, reason: `Enrolling in the starting course: ${published[0].title}` };
    }

    const idx = published.findIndex((c) => c.course_id === completedCourseId);
    if (idx !== -1 && idx + 1 < published.length) {
      return { next_course_id: published[idx + 1].course_id, reason: `Moving to the next course in sequence: ${published[idx + 1].title}` };
    }
    return { next_course_id: null, reason: "You have completed all courses in the catalog!" };
  }

  private async renderMicro(learnerId: string, step: JourneyStep): Promise<string> {
    const ctx = await this.learnerContext(learnerId);
    const { tx } = await this.dailyLoop.runAgent("trainer", learnerId,
      `Render today's lesson brief into a friendly, brief, WhatsApp-formatted micro-lesson.\n\n` +
      `Lesson: ${step.title}\nObjective: ${step.objective}\nKey points: ${step.key_points.join("; ")}\n\n` +
      `Learner context: ${ctx}`, { baseSources: [`lesson:${step.lesson_id}`] });
    return (tx.output as { text?: string })?.text ?? `Brief: ${step.objective}`;
  }

  private async completeCourse(learnerId: string, courseId: string): Promise<WalkResult> {
    await this.lms.completeEnrollment(learnerId, courseId);
    const pick = await this.advise(learnerId, courseId);
    if (!pick.next_course_id) {
      return { reply: `🎉 *Congratulations!* You have completed the course *${(await this.lms.getCourse(courseId))?.title}* and all training in our catalog! You are ready for deployment!`, course_completed: courseId, advisor: pick, done: true };
    }
    const next = await this.lms.enroll(learnerId, pick.next_course_id);
    const served = await this.serveNext(learnerId, next.course_id);
    const course = await this.lms.getCourse(next.course_id);
    return { reply: `🎓 Course complete! Your advisor picked your next course: *${course?.title}* — ${pick.reason}\n\n${served.reply}`, course_completed: courseId, advisor: pick, course_id: next.course_id, served_lesson_id: served.served_lesson_id };
  }

  private async learnerContext(learnerId: string): Promise<string> {
    const evs = (await this.evidence.forLearner(learnerId)).slice(0, 8);
    if (!evs.length) return "New learner, no history yet.";
    const avg = Math.round(evs.reduce((a, e) => a + (e.score / e.scale_max) * 100, 0) / evs.length);
    const weak = evs.filter((e) => e.score / e.scale_max < 0.6).map((e) => e.competency_id);
    return `Recent avg ${avg}/100 over ${evs.length} items.` + (weak.length ? ` Weak on: ${[...new Set(weak)].join(", ")}.` : " Doing well.");
  }

  private async grade(lesson: Lesson, answer: string, learnerId: string, servedItem?: string): Promise<{ score: number; passed: boolean; feedback: string; event_id: string }> {
    const deep = lesson.type === "roleplay" || lesson.type === "task";
    const res = await this.gateway.complete({
      tier: deep ? "deep" : "fast", role: "critic",
      system: "You grade a learner's answer for a vocational AI-skills program. Fair, encouraging, honest. Respond with ONLY JSON: {\"score\":0-100,\"feedback\":\"one or two warm concrete lines\"}.",
      user: `Type: ${lesson.type}\nCompetency: ${lesson.competency_id}\nItem shown to learner: ${servedItem || lesson.objective}\nWhat good looks like: ${lesson.key_points.join("; ")}\n\nLearner's answer:\n${answer}`,
      maxTokens: 300,
    });
    let score = 0, feedback = "Recorded.";
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
      score = Math.max(0, Math.min(100, Number(j.score) || 0));
      feedback = String(j.feedback || feedback);
    } catch {
      score = res.stub ? (answer.toLowerCase().includes("fail") ? 40 : 72) : 50;
      feedback = res.stub ? (answer.toLowerCase().includes("fail") ? "Simulated grading failure." : "Recorded (grading offline in test mode).") : "Recorded.";
    }
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

  private async gradeDiagnostic(questionText: string, competencyId: string, rubric: string, answer: string, learnerId: string): Promise<{ score: number; feedback: string; event_id: string }> {
    const res = await this.gateway.complete({
      tier: "fast", role: "critic",
      system: "You grade a diagnostic question for a vocational AI-skills program. Be brief and objective. Respond with ONLY JSON: {\"score\":0-100,\"feedback\":\"one brief sentence\"}.",
      user: `Question: ${questionText}\nCompetency: ${competencyId}\nRubric: ${rubric}\n\nCandidate's response:\n${answer}`,
      maxTokens: 200,
    });
    let score = 0, feedback = "Recorded.";
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
      score = Math.max(0, Math.min(100, Number(j.score) || 0));
      feedback = String(j.feedback || feedback);
    } catch {
      score = res.stub ? (answer.toLowerCase().includes("fail") ? 40 : 75) : 50;
      feedback = res.stub ? (answer.toLowerCase().includes("fail") ? "Simulated diagnostic failure." : "Recorded diagnostic response (stub mode).") : "Recorded.";
    }
    const ev: EvidenceEvent = {
      event_id: `ev-${randomUUID()}`, learner_id: learnerId, timestamp: new Date().toISOString(), source: "learning",
      competency_id: competencyId, activity_type: "diagnostic",
      modality: "async", stakes: "formative",
      score, scale_max: 100, grader: { type: "llm", model: res.call.model }, framework_version: this.frameworkVersion, evidence_refs: ["diagnostic"],
    };
    await this.evidence.append(ev);
    return { score, feedback, event_id: ev.event_id };
  }
}

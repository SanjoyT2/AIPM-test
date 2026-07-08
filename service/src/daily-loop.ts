/**
 * Daily loop (doc 03, ADR-005) — learner-initiated, window-safe.
 *
 * - Window state machine: every inbound learner message rolls the 24h WhatsApp
 *   window forward. `windowOpen` gates every proactive send (consent_window guardrail).
 * - Routing: "START" → Trainer lesson micro-plan; anything else → Mentor coaching.
 *   Both run through the Executor, so every reply is a full audited transaction.
 * - Silence ladder: hourly sweep flags learners whose window lapsed N days ago,
 *   per progression-rules.yaml engagement thresholds (v0: logged intent — the
 *   actual template send goes through the 11za outbound client when wired).
 */
import type { AgentSpec } from "./agents.js";
import type { Executor } from "./executor.js";
import type { Plan, PlanStep } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class DailyLoop {
  /** learnerId -> window expiry epoch-ms. (v0 in-memory; move to Postgres with the ledger.) */
  private windows = new Map<string, number>();
  private lastActive = new Map<string, number>();

  constructor(
    private executor: Executor,
    private agents: Record<string, AgentSpec>,
    private frameworks: any,
    private log: (msg: string, obj?: unknown) => void = console.log,
  ) {}

  windowOpen(learnerId: string): boolean {
    return (this.windows.get(learnerId) ?? 0) > Date.now();
  }

  /** Every inbound message: roll the window forward 24h and stamp activity. */
  touch(learnerId: string): void {
    this.windows.set(learnerId, Date.now() + DAY_MS);
    this.lastActive.set(learnerId, Date.now());
  }

  async handleInbound(learnerId: string, text: string) {
    this.touch(learnerId);
    const trimmed = text.trim();
    const isStart = /^start\b/i.test(trimmed);

    const agent = isStart ? this.agents.trainer : this.agents.mentor;
    const date = new Date().toISOString().slice(0, 10);
    const plan: Plan = {
      plan_id: `plan-daily-${learnerId}-${date}`,
      goal: isStart ? "Serve today's personalized lesson" : "Coach the learner past their question",
      altitude: "micro",
      subject_id: learnerId,
      created_by: "daily-loop@0.1.0",
      steps: [],
    };
    const step: PlanStep = {
      step_id: isStart ? "s1-lesson" : "s1-mentor",
      agent: agent.name,
      output_contract: "text/plain",
      budget: { max_usd: this.frameworks.costModel?.budgets?.per_transaction?.default_max_usd },
    };
    plan.steps.push(step);

    const input = isStart
      ? `Learner ${learnerId} sent START for day ${date}. Serve today's lesson (v0: no mastery profile yet — begin at Level 1, use a real MSME case, end with one quiz question and one hands-on task).`
      : `Learner ${learnerId} asks: ${trimmed}`;

    const tx = await this.executor.runStep({
      plan, step, agent, input,
      subjectId: learnerId,
      sources: [isStart ? `lesson-request:${date}` : "learner-question", `window:open`],
      windowOpen: true, // they just messaged us — definitionally open
      frameworkVersion: this.frameworks.versions.competency_framework,
    });

    // v0: the reply returns to the webhook caller; the 11za outbound client will send it in-thread.
    const reply = (tx.output as { text?: string })?.text ?? "(blocked)";
    return { transaction_id: tx.transaction_id, status: tx.status, reply };
  }

  /** Hourly sweep: silence ladder per progression-rules engagement thresholds. */
  startSilenceSweep(): NodeJS.Timeout {
    const eng = this.frameworks.progressionRules?.engagement ?? {};
    return setInterval(() => {
      const now = Date.now();
      for (const [learner, last] of this.lastActive) {
        const days = Math.floor((now - last) / DAY_MS);
        if (days >= (eng.escalate_at_days ?? 7)) this.log(`silence-ladder: ESCALATE ${learner} (${days}d inactive) -> operator queue`);
        else if (days >= (eng.warning_at_days ?? 5)) this.log(`silence-ladder: template warning_day5 -> ${learner}`);
        else if (days >= (eng.second_nudge_at_days ?? 3)) this.log(`silence-ladder: template nudge_day3_streak -> ${learner}`);
        else if (days >= (eng.nudge_at_days ?? 2)) this.log(`silence-ladder: template nudge_day2 -> ${learner}`);
      }
    }, 60 * 60 * 1000);
  }
}

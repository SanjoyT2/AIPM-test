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
import type { ResourceStore } from "./resource-store.js";
import type { AgentTransaction, Plan, PlanStep } from "./types.js";
import type { WaClient } from "./wa-client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Silence-ladder rung -> approved template name (must exist in whatsapp-templates.yaml
// AND be approved in 11za). Editable mapping; keep names in sync with 11za.
const LADDER_TEMPLATE: Record<string, string> = {
  nudge: "nudge_day2",
  second_nudge: "nudge_day3_streak",
  warning: "warning_day5",
};

export class DailyLoop {
  /** learnerId -> window expiry epoch-ms. (v0 in-memory; move to Postgres with the ledger.) */
  private windows = new Map<string, number>();
  private lastActive = new Map<string, number>();
  /** Guard so the silence ladder sends each rung once per learner, not every sweep. */
  private lastLadderRung = new Map<string, string>();

  constructor(
    private executor: Executor,
    private agents: Record<string, AgentSpec>,
    private frameworks: any,
    private wa: WaClient,
    private resources: ResourceStore,
    private log: (msg: string, obj?: unknown) => void = console.log,
  ) {}

  /**
   * Resolve an agent's attached resources and run it once through the executor:
   *  - RAG: retrieve top-K docs from attached knowledge bases, inject into the
   *    system prompt, and record them as evidence.sources (grounding).
   *  - Guardrails: effective rules = base policy ∪ every attached guardrail set.
   * Reused by the daily loop AND the Studio playground (test-as-user).
   */
  async runAgent(agentName: string, subjectId: string, input: string, opts: { windowOpen?: boolean; baseSources?: string[]; stepId?: string } = {}): Promise<{ tx: AgentTransaction; retrieved: { document_id: string; title: string; score: number }[] }> {
    const agent = this.agents[agentName];
    if (!agent) throw new Error(`unknown agent '${agentName}'`);

    const hits = await this.resources.retrieve(agentName, input, 3);
    const effAgent: AgentSpec = hits.length
      ? { ...agent, systemPrompt: `${agent.systemPrompt}\n\n# Knowledge base (retrieved, most relevant first)\n${hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.content}`).join("\n")}` }
      : agent;

    const baseRules: string[] = this.frameworks.guardrails.policies?.[agent.guardrailPolicy]
      ?? this.frameworks.guardrails.policies?.default ?? [];
    const attachedRules = await this.resources.agentAttachedGuardrailRuleIds(agentName);
    const guardrailRuleIds = [...new Set([...baseRules, ...attachedRules])];

    const date = new Date().toISOString().slice(0, 10);
    const plan: Plan = { plan_id: `plan-${agentName}-${subjectId}-${date}`, goal: `Run ${agentName}`, altitude: "micro", subject_id: subjectId, created_by: "daily-loop@0.1.0", steps: [] };
    const step: PlanStep = { step_id: opts.stepId ?? `s1-${agentName}`, agent: agentName, output_contract: "text/plain", budget: { max_usd: this.frameworks.costModel?.budgets?.per_transaction?.default_max_usd } };
    plan.steps.push(step);

    const tx = await this.executor.runStep({
      plan, step, agent: effAgent, input, subjectId,
      sources: [...(opts.baseSources ?? []), ...hits.map((h) => `kb:${h.kb_id}/${h.document_id}`)],
      windowOpen: opts.windowOpen ?? true,
      frameworkVersion: this.frameworks.versions.competency_framework,
      guardrailRuleIds,
    });
    return { tx, retrieved: hits.map((h) => ({ document_id: h.document_id, title: h.title, score: h.score })) };
  }

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
    const date = new Date().toISOString().slice(0, 10);

    const input = isStart
      ? `Learner ${learnerId} sent START for day ${date}. Serve today's lesson (v0: no mastery profile yet — begin at Level 1, use a real MSME case, end with one quiz question and one hands-on task).`
      : `Learner ${learnerId} asks: ${trimmed}`;

    const { tx } = await this.runAgent(isStart ? "trainer" : "mentor", learnerId, input, {
      windowOpen: true, // they just messaged us — definitionally open
      baseSources: [isStart ? `lesson-request:${date}` : "learner-question"],
      stepId: isStart ? "s1-lesson" : "s1-mentor",
    });

    // Learner just messaged us, so the window is open — send the reply as free-form
    // text in-thread. (Blocked outputs have no text; nothing is sent.)
    const reply = (tx.output as { text?: string })?.text ?? "";
    let sent: { ok: boolean; stub: boolean } | undefined;
    if (reply && tx.status !== "blocked") {
      const r = await this.wa.sendText(learnerId, reply);
      sent = { ok: r.ok, stub: r.stub };
      if (!r.ok && !r.stub) this.log(`wa send failed for ${learnerId}: ${r.detail}`);
    }
    return { transaction_id: tx.transaction_id, status: tx.status, reply, sent };
  }

  /** Hourly sweep: silence ladder per progression-rules engagement thresholds. */
  startSilenceSweep(): NodeJS.Timeout {
    return setInterval(() => this.runSilenceSweep().catch((e) => this.log(`silence sweep error: ${e}`)), 60 * 60 * 1000);
  }

  /** One pass of the silence ladder. Sends the approved template for the current rung
   *  (once per rung per learner) or escalates to the operator. Outside the window,
   *  templates are the only legal proactive message. */
  async runSilenceSweep(now = Date.now()): Promise<void> {
    const eng = this.frameworks.progressionRules?.engagement ?? {};
    for (const [learner, last] of this.lastActive) {
      const days = Math.floor((now - last) / DAY_MS);
      let rung: string | null = null;
      if (days >= (eng.escalate_at_days ?? 7)) rung = "escalate";
      else if (days >= (eng.warning_at_days ?? 5)) rung = "warning";
      else if (days >= (eng.second_nudge_at_days ?? 3)) rung = "second_nudge";
      else if (days >= (eng.nudge_at_days ?? 2)) rung = "nudge";
      if (!rung) continue;
      if (this.lastLadderRung.get(learner) === rung) continue; // already handled this rung
      this.lastLadderRung.set(learner, rung);

      if (rung === "escalate") {
        this.log(`silence-ladder: ESCALATE ${learner} (${days}d inactive) -> operator queue`);
        continue;
      }
      const template = LADDER_TEMPLATE[rung];
      const r = await this.wa.sendTemplate(learner, template, { name: learner });
      this.log(`silence-ladder: ${learner} ${days}d -> template ${template} (${r.stub ? "stub" : r.ok ? "sent" : "FAILED"})`);
    }
  }
}

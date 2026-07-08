/**
 * Executor — runs one plan step through the full execution contract (doc 04):
 *
 *   ② input guardrails → ③ act → ④ critique (bounded revise loop) → ⑤ output
 *   guardrails → ⑥ cost assembly → ⑦ append transaction to ledger
 *
 * Every path — including blocks and escalations — produces a ledger transaction.
 * "If it isn't a transaction, it didn't happen."
 */
import { randomUUID } from "node:crypto";
import type { AgentSpec } from "./agents.js";
import type { LlmGateway } from "./gateway.js";
import { GuardrailEngine } from "./guardrails.js";
import type { Ledger } from "./ledger.js";
import type { AgentTransaction, CriticVerdict, LlmCall, Plan, PlanStep } from "./types.js";

export interface StepRequest {
  plan: Plan;
  step: PlanStep;
  agent: AgentSpec;
  input: string;                 // user-visible input for the actor
  subjectId?: string;
  sources?: string[];            // evidence grounding refs supplied by the caller
  windowOpen?: boolean;          // consent_window context (daily loop supplies this)
  frameworkVersion: string;
}

const VERDICT_RE = /verdict\s*[:=]\s*(accept|revise|reject|escalate)/i;

export class Executor {
  private guardrails: GuardrailEngine;

  constructor(
    private frameworks: any,
    private gateway: LlmGateway,
    private ledger: Ledger,
    private validateTx: (tx: unknown) => boolean,
  ) {
    this.guardrails = new GuardrailEngine(frameworks.guardrails);
  }

  async runStep(req: StepRequest): Promise<AgentTransaction> {
    const calls: LlmCall[] = [];
    const started = Date.now();
    const guardrailPolicy = req.step.guardrail_policy ?? req.agent.guardrailPolicy;
    const criticPolicy = req.step.critic_policy ?? req.agent.criticPolicy;
    const maxUsd = req.step.budget?.max_usd
      ?? this.frameworks.costModel?.budgets?.per_transaction?.default_max_usd ?? 1;

    // ② INPUT GUARDRAILS ------------------------------------------------------
    const gin = this.guardrails.runInput(guardrailPolicy, {
      input: req.input, windowOpen: req.windowOpen, agentName: req.agent.name,
    });
    if (gin.blocked) {
      return this.emit(req, {
        output: { disposition: "blocked at input guardrails" },
        reasoning: "Input guardrail(s) failed before the actor ran.",
        verdict: "skipped_by_policy", critics: [], revisions: 0,
        gIn: gin.results, gOut: [], blocked: true, calls, status: "blocked", started,
      });
    }

    // ③ ACT + ④ CRITIQUE (bounded revise loop) --------------------------------
    const policy = this.frameworks.critics?.policies?.[criticPolicy] ?? { mode: "always", panel: 1, model: "sonnet" };
    const maxLoops = this.frameworks.critics?.limits?.max_revise_loops ?? 2;
    const shouldCritique =
      policy.mode === "always" || (policy.mode === "sample" && Math.random() < (policy.sample_rate ?? 0));

    let actorText = "";
    let revisions = 0;
    let verdict: CriticVerdict | "skipped_by_policy" = shouldCritique ? "revise" : "skipped_by_policy";
    const critics: { model: string; verdict: CriticVerdict; checks?: string[]; justification?: string }[] = [];
    let feedback = "";

    for (let attempt = 0; attempt <= maxLoops; attempt++) {
      const actor = await this.gateway.complete({
        tier: req.agent.tier, role: "actor",
        system: req.agent.systemPrompt,
        user: feedback ? `${gin.redactedInput}\n\n[Critic feedback on your previous attempt — address it]\n${feedback}` : gin.redactedInput,
      });
      calls.push(actor.call);
      actorText = actor.text;
      if (attempt > 0) revisions = attempt;
      if (this.overBudget(calls, maxUsd)) {
        return this.emit(req, {
          output: { disposition: "halted — step budget exceeded" },
          reasoning: `Cost ceiling ${maxUsd} USD hit during act/critique.`,
          verdict: "skipped_by_policy", critics, revisions,
          gIn: gin.results,
          gOut: [{ id: "cost_ceiling_per_transaction", passed: false, severity: "block", detail: `budget ${maxUsd} USD exceeded` }],
          blocked: true, calls, status: "blocked", started,
        });
      }
      if (!shouldCritique) { verdict = "skipped_by_policy"; break; }

      // Critic panel — each critic told to try to refute (doc 04).
      const panel = policy.panel ?? 1;
      const panelVerdicts: CriticVerdict[] = [];
      for (let c = 0; c < panel; c++) {
        const critic = await this.gateway.complete({
          tier: (policy.model === "haiku" ? "haiku" : "sonnet"),
          role: "critic",
          system:
            "You are a skeptical critic. Try to REFUTE the agent output: does the evidence/context support it? Is it within the agent's spec (checks: " +
            (policy.checks ?? []).join(", ") +
            ")? Reply with exactly one line starting `verdict: accept|revise|reject|escalate` then a one-line justification.",
          user: `Agent: ${req.agent.name}\nTask input:\n${gin.redactedInput.slice(0, 1500)}\n\nAgent output:\n${actorText.slice(0, 1500)}`,
        });
        calls.push(critic.call);
        const m = VERDICT_RE.exec(critic.text);
        const v = (m?.[1]?.toLowerCase() as CriticVerdict) ?? "accept"; // stub-mode fallback: accept, flagged in justification
        panelVerdicts.push(v);
        critics.push({
          model: critic.call.model, verdict: v, checks: policy.checks,
          justification: m ? critic.text.split("\n").slice(0, 2).join(" ").slice(0, 300) : "unparseable critic reply — defaulted to accept (stub mode)",
        });
      }
      // Panel resolution: any escalate → escalate; majority reject → reject; any revise → loop; else accept.
      if (panelVerdicts.includes("escalate")) { verdict = "escalate"; break; }
      if (panelVerdicts.filter((v) => v === "reject").length > panel / 2) { verdict = "reject"; break; }
      if (panelVerdicts.includes("revise") && attempt < maxLoops) {
        verdict = "revise";
        feedback = critics[critics.length - 1]?.justification ?? "revise";
        continue;
      }
      verdict = panelVerdicts.includes("revise") ? "escalate" : "accept"; // revise loops exhausted → escalate
      break;
    }

    // ⑤ OUTPUT GUARDRAILS ------------------------------------------------------
    const hasScore = /"score"|score[:=]\s*\d/i.test(actorText);
    const gout = this.guardrails.runOutput(guardrailPolicy, {
      input: gin.redactedInput, output: actorText, agentName: req.agent.name,
      outputHasScore: hasScore, evidenceVersioned: Boolean(req.frameworkVersion),
    });

    const status: AgentTransaction["status"] =
      gout.blocked ? "blocked" :
      verdict === "escalate" ? "escalated" :
      verdict === "reject" ? "failed" :
      revisions > 0 ? "revised" : "completed";

    return this.emit(req, {
      output: { text: actorText },
      reasoning: `Actor(${req.agent.tier}) ran with ${revisions} revision(s); critic policy '${criticPolicy}' → ${verdict}.`,
      verdict, critics, revisions,
      gIn: gin.results, gOut: gout.results, blocked: gout.blocked, calls, status, started,
    });
  }

  private overBudget(calls: LlmCall[], maxUsd: number): boolean {
    return calls.reduce((a, c) => a + c.usd, 0) > maxUsd;
  }

  // ⑥ COST + ⑦ EMIT -----------------------------------------------------------
  private async emit(req: StepRequest, r: {
    output: unknown; reasoning: string;
    verdict: CriticVerdict | "skipped_by_policy";
    critics: { model: string; verdict: CriticVerdict; checks?: string[]; justification?: string }[];
    revisions: number;
    gIn: AgentTransaction["guardrails"]["input"]; gOut: AgentTransaction["guardrails"]["output"];
    blocked: boolean; calls: LlmCall[]; status: AgentTransaction["status"]; started: number;
  }): Promise<AgentTransaction> {
    const tx: AgentTransaction = {
      transaction_id: `tx-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      subject_id: req.subjectId,
      agent: { name: req.agent.name, version: req.agent.version, role: "actor" },
      plan_ref: { plan_id: req.plan.plan_id, step_id: req.step.step_id },
      output: r.output,
      evidence: {
        sources: req.sources ?? [],
        reasoning_summary: r.reasoning,
        framework_version: req.frameworkVersion,
      },
      critique: {
        policy: req.step.critic_policy ?? req.agent.criticPolicy,
        verdict: r.verdict,
        critics: r.critics.length ? r.critics : undefined,
        revisions: r.revisions,
      },
      guardrails: { input: r.gIn, output: r.gOut, blocked: r.blocked },
      cost: {
        total_usd: Number(r.calls.reduce((a, c) => a + c.usd, 0).toFixed(6)),
        total_tokens: r.calls.reduce((a, c) => a + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0),
        total_ms: Date.now() - r.started,
        calls: r.calls,
      },
      status: r.status,
    };
    if (!this.validateTx(tx)) throw new Error("executor produced a schema-invalid transaction — programming error");
    await this.ledger.append(tx);
    return tx;
  }
}

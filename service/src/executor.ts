/**
 * Executor — runs one plan step through the execution contract (doc 04):
 *
 *   ③ act → ④ critique (bounded revise loop) → ⑤ guardrail pass (LLM) →
 *   ⑥ cost assembly → ⑦ append transaction to ledger
 *
 * Guardrails are LLM-enforced plain-English rules (no deterministic logic): after
 * the agent speaks, a guardrail critic pass reads the message against every
 * attached rule and passes/fails each. It runs on EVERY transaction.
 *
 * A per-transaction spend ceiling still halts runaway loops — that's infrastructure
 * (a budget fuse), not a guardrail.
 *
 * Every path — including blocks and escalations — produces a ledger transaction.
 * "If it isn't a transaction, it didn't happen."
 */
import { randomUUID } from "node:crypto";
import type { AgentSpec } from "./agents.js";
import type { LlmGateway } from "./gateway.js";
import { Guardrails, type GuardrailRule } from "./guardrails.js";
import type { Ledger } from "./ledger.js";
import type { AgentTransaction, CriticVerdict, GuardrailResult, LlmCall, Plan, PlanStep } from "./types.js";

export interface StepRequest {
  plan: Plan;
  step: PlanStep;
  agent: AgentSpec;
  input: string;                 // user-visible input for the actor
  subjectId?: string;
  sources?: string[];            // evidence grounding refs supplied by the caller (incl. injected RAG docs)
  windowOpen?: boolean;
  frameworkVersion: string;
  guardrailRules?: GuardrailRule[];  // resolved plain-English rules: agent policy ∪ attached sets
}

const VERDICT_RE = /verdict\s*[:=]\s*(accept|revise|reject|escalate)/i;

export class Executor {
  private guardrails: Guardrails;

  constructor(
    private frameworks: any,
    private gateway: LlmGateway,
    private ledger: Ledger,
    private validateTx: (tx: unknown) => boolean,
  ) {
    this.guardrails = new Guardrails(gateway);
  }

  async runStep(req: StepRequest): Promise<AgentTransaction> {
    const calls: LlmCall[] = [];
    const started = Date.now();
    const criticPolicy = req.step.critic_policy ?? req.agent.criticPolicy;
    const maxUsd = req.step.budget?.max_usd
      ?? this.frameworks.costModel?.budgets?.per_transaction?.default_max_usd ?? 1;

    // ③ ACT + ④ CRITIQUE (bounded revise loop) --------------------------------
    const policy = this.frameworks.critics?.policies?.[criticPolicy] ?? { mode: "always", panel: 1, model: "deep" };
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
        user: feedback ? `${req.input}\n\n[Critic feedback on your previous attempt — address it]\n${feedback}` : req.input,
      });
      calls.push(actor.call);
      actorText = actor.text;
      if (attempt > 0) revisions = attempt;
      if (this.overBudget(calls, maxUsd)) {
        // Budget fuse (infrastructure, not a guardrail): stop runaway spend.
        return this.emit(req, {
          output: { disposition: "halted — per-transaction budget exceeded" },
          reasoning: `Budget ceiling ${maxUsd} USD hit during act/critique.`,
          verdict: "skipped_by_policy", critics, revisions,
          gOut: [], blocked: true, calls, status: "blocked", started,
        });
      }
      if (!shouldCritique) { verdict = "skipped_by_policy"; break; }

      // Critic panel — each critic told to try to refute (doc 04).
      const panel = policy.panel ?? 1;
      const panelVerdicts: CriticVerdict[] = [];
      for (let c = 0; c < panel; c++) {
        const critic = await this.gateway.complete({
          tier: policy.model === "fast" ? "fast" : "deep",
          role: "critic",
          system:
            "You are a skeptical critic. Try to REFUTE the agent output: does the evidence/context support it? Is it within the agent's spec (checks: " +
            (policy.checks ?? []).join(", ") +
            ")? Reply with exactly one line starting `verdict: accept|revise|reject|escalate` then a one-line justification.",
          user: `Agent: ${req.agent.name}\nTask input:\n${req.input.slice(0, 1500)}\n\nAgent output:\n${actorText.slice(0, 1500)}`,
        });
        calls.push(critic.call);
        const m = VERDICT_RE.exec(critic.text);
        const v = (m?.[1]?.toLowerCase() as CriticVerdict) ?? "accept";
        panelVerdicts.push(v);
        critics.push({
          model: critic.call.model, verdict: v, checks: policy.checks,
          justification: m ? critic.text.split("\n").slice(0, 2).join(" ").slice(0, 300) : "unparseable critic reply — defaulted to accept (stub mode)",
        });
      }
      if (panelVerdicts.includes("escalate")) { verdict = "escalate"; break; }
      if (panelVerdicts.filter((v) => v === "reject").length > panel / 2) { verdict = "reject"; break; }
      if (panelVerdicts.includes("revise") && attempt < maxLoops) {
        verdict = "revise";
        feedback = critics[critics.length - 1]?.justification ?? "revise";
        continue;
      }
      verdict = panelVerdicts.includes("revise") ? "escalate" : "accept";
      break;
    }

    // ⑤ GUARDRAIL PASS (LLM, always-on) ---------------------------------------
    const g = await this.guardrails.evaluate(req.guardrailRules ?? [], {
      agentName: req.agent.name, input: req.input, output: actorText,
    });
    calls.push(...g.calls);

    const status: AgentTransaction["status"] =
      g.blocked ? "blocked" :
      verdict === "escalate" ? "escalated" :
      verdict === "reject" ? "failed" :
      revisions > 0 ? "revised" : "completed";

    return this.emit(req, {
      output: { text: actorText },
      reasoning: `Actor(${req.agent.tier}) ran with ${revisions} revision(s); critic '${criticPolicy}' → ${verdict}; ${g.results.length} guardrail rule(s) evaluated.`,
      verdict, critics, revisions,
      gOut: g.results, blocked: g.blocked, calls, status, started,
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
    gOut: GuardrailResult[]; blocked: boolean;
    calls: LlmCall[]; status: AgentTransaction["status"]; started: number;
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
      guardrails: { output: r.gOut, blocked: r.blocked },
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

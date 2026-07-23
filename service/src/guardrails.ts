/**
 * Guardrails — LLM-enforced, plain-English rules (no deterministic logic).
 *
 * A rule is just a name + a sentence ("Block any message that guarantees a job
 * or a salary figure"). After an agent speaks, a guardrail critic pass reads the
 * message against every attached rule and returns pass/fail each. Blocking rules
 * that fail block the transaction. This runs on EVERY transaction (unlike the
 * quality critic, which is policy-sampled) — it is the always-on enforcement pass.
 *
 * Rules are user-creatable in plain English (see the Guardrails page); there is no
 * code to write. Spend limits are NOT guardrails — they're a separate per-agent /
 * per-learner budget feature.
 */
import type { LlmGateway } from "./gateway.js";
import type { GuardrailResult, LlmCall } from "./types.js";

export interface GuardrailRule {
  id: string;
  name?: string;
  description: string;                 // the plain-English rule the critic enforces
  severity: "block" | "escalate" | "warn";
}

export interface GuardrailOutcome {
  results: GuardrailResult[];
  blocked: boolean;
  calls: LlmCall[];                    // LLM cost of the guardrail pass (role: "guardrail")
}

const SYS =
  "You are a strict guardrail evaluator. You are given an AI agent's message and a list of rules. " +
  "For EACH rule, decide whether the message VIOLATES it. Be conservative: if a rule is clearly violated, fail it. " +
  'Respond with ONLY a JSON array, one object per rule: [{"id":"<rule id>","passed":true|false,"reason":"<short>"}]. ' +
  "passed=true means the message complies (no violation).";

export class Guardrails {
  constructor(private gateway: LlmGateway) {}

  /** Evaluate the agent's output against the attached rules in one LLM pass. */
  async evaluate(rules: GuardrailRule[], ctx: { agentName: string; input: string; output: string }): Promise<GuardrailOutcome> {
    if (!rules.length) return { results: [], blocked: false, calls: [] };

    const user =
      `Agent: ${ctx.agentName}\n\nAgent message to evaluate:\n"""\n${ctx.output.slice(0, 4000)}\n"""\n\n` +
      `Rules:\n${rules.map((r) => `- ${r.id}: ${r.description}`).join("\n")}`;

    const res = await this.gateway.complete({ tier: "fast", role: "guardrail", system: SYS, user, maxTokens: 600 });

    // Parse the evaluator's verdicts; default to pass on anything unparseable so a
    // flaky judge never silently blocks (failures are surfaced, not fabricated).
    const verdicts = parseVerdicts(res.text);
    const results: GuardrailResult[] = rules.map((r) => {
      const v = verdicts.get(r.id);
      const passed = v ? v.passed : true;
      return {
        id: r.id, passed, severity: r.severity,
        detail: res.stub ? "stub: not evaluated (no LLM key) — passed" : (v?.reason ?? (passed ? undefined : "violation")),
      };
    });
    const blocked = results.some((r) => !r.passed && r.severity === "block");
    return { results, blocked, calls: [res.call] };
  }
}

function parseVerdicts(text: string): Map<string, { passed: boolean; reason?: string }> {
  const map = new Map<string, { passed: boolean; reason?: string }>();
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < 0) return map;
    const arr = JSON.parse(text.slice(start, end + 1));
    for (const o of arr) if (o && typeof o.id === "string") map.set(o.id, { passed: o.passed !== false, reason: o.reason });
  } catch {
    /* leave empty -> callers default to pass */
  }
  return map;
}

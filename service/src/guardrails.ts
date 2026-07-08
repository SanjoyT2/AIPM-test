/**
 * Guardrail engine — deterministic checks that run around every agent transaction
 * (doc 07). Rules are declared in d2d/config/guardrails.yaml; this module implements
 * the executable ones. Unimplemented ML rules record `passed:true` with a "static-pass"
 * note so their presence is honest and visible on the dashboard (no silent coverage claims).
 */
import type { GuardrailResult } from "./types.js";

const PII_PATTERNS: [string, RegExp][] = [
  ["aadhaar", /\b\d{4}\s?\d{4}\s?\d{4}\b/g],
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ["phone", /\b(?:\+91[ -]?)?[6-9]\d{9}\b/g],
  ["upi_or_email", /\b[\w.\-]{2,}@[a-z][\w\-]+\b/gi],
];

const INJECTION = /(ignore (?:all|previous|above|prior) (?:instructions|prompts)|disregard (?:your|the) (?:instructions|rules)|you are now|reveal (?:your )?system prompt)/i;

export interface GuardrailContext {
  input: string;
  output?: string;
  windowOpen?: boolean;          // for consent_window
  agentName?: string;
  outputHasScore?: boolean;      // for no_unversioned_score
  evidenceVersioned?: boolean;
}

export interface InputGuardrailOutcome {
  results: GuardrailResult[];
  blocked: boolean;
  redactedInput: string;
}

export class GuardrailEngine {
  constructor(private config: any) {}

  private rule(id: string) {
    return this.config.rules?.[id] ?? { severity: "warn", stage: "input" };
  }

  policyRules(policy: string): string[] {
    return this.config.policies?.[policy] ?? this.config.policies?.default ?? [];
  }

  runInput(policy: string, ctx: GuardrailContext): InputGuardrailOutcome {
    const results: GuardrailResult[] = [];
    let redacted = ctx.input;
    let blocked = false;

    for (const id of this.policyRules(policy)) {
      const r = this.rule(id);
      if (r.stage !== "input") continue;
      let res: GuardrailResult;

      if (id === "pii_redaction") {
        const hits: string[] = [];
        for (const [kind, re] of PII_PATTERNS) {
          if (re.test(redacted)) { hits.push(kind); redacted = redacted.replace(re, `[${kind}-redacted]`); }
          re.lastIndex = 0;
        }
        // Redaction succeeds rather than blocks: the model never sees the PII.
        res = { id, passed: true, severity: r.severity, detail: hits.length ? `redacted: ${hits.join(", ")}` : undefined };
      } else if (id === "prompt_injection") {
        const hit = INJECTION.test(ctx.input);
        res = { id, passed: !hit, severity: r.severity, detail: hit ? "injection pattern matched" : undefined };
      } else if (id === "consent_window") {
        const open = ctx.windowOpen !== false;
        res = { id, passed: open, severity: r.severity, detail: open ? undefined : "24h window closed — approved template required" };
      } else {
        res = { id, passed: true, severity: r.severity, detail: "static-pass (v0 — check not yet executable)" };
      }

      results.push(res);
      if (!res.passed && res.severity === "block") blocked = true;
    }
    return { results, blocked, redactedInput: redacted };
  }

  runOutput(policy: string, ctx: GuardrailContext): { results: GuardrailResult[]; blocked: boolean } {
    const results: GuardrailResult[] = [];
    let blocked = false;

    for (const id of this.policyRules(policy)) {
      const r = this.rule(id);
      if (r.stage !== "output") continue;
      let res: GuardrailResult;

      if (id === "no_unversioned_score") {
        const ok = !ctx.outputHasScore || ctx.evidenceVersioned === true;
        res = { id, passed: ok, severity: r.severity, detail: ok ? undefined : "score emitted without framework/rubric version" };
      } else if (id === "no_false_promises") {
        const hit = /(guarantee[ds]? (?:a )?(?:job|admission|placement)|100% (?:job|placement|revenue)|pakka (?:job|admission))/i.test(ctx.output ?? "");
        res = { id, passed: !hit, severity: r.severity, detail: hit ? "promise language detected" : undefined };
      } else {
        res = { id, passed: true, severity: r.severity, detail: "static-pass (v0 — check not yet executable)" };
      }

      results.push(res);
      if (!res.passed && res.severity === "block") blocked = true;
    }
    return { results, blocked };
  }
}

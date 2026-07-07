/** Mirror of service/src/types.ts (canonical source: d2d/schema/*.schema.json). Keep in sync. */

export type CriticVerdict = "accept" | "revise" | "reject" | "escalate";
export type TransactionStatus = "completed" | "revised" | "escalated" | "blocked" | "failed";
export type CallRole = "actor" | "critic" | "guardrail";
export type GuardrailSeverity = "block" | "escalate" | "warn";

export interface LlmCall {
  role: CallRole;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  usd: number;
  ms?: number;
}

export interface GuardrailResult {
  id: string;
  passed: boolean;
  severity: GuardrailSeverity;
  detail?: string;
}

export interface AgentTransaction {
  transaction_id: string;
  timestamp: string;
  subject_id?: string;
  agent: { name: string; version: string; role?: string };
  plan_ref: { plan_id: string; step_id: string; workflow_id?: string };
  output: unknown;
  evidence: {
    sources: string[];
    tool_calls?: { tool: string; args_ref?: string; result_ref?: string }[];
    reasoning_summary: string;
    confidence?: number;
    framework_version?: string;
    rubric_version?: string;
  };
  critique: {
    policy?: string;
    verdict: CriticVerdict | "skipped_by_policy";
    critics?: { model: string; verdict: CriticVerdict; checks?: string[]; justification?: string }[];
    revisions?: number;
  };
  guardrails: { input?: GuardrailResult[]; output?: GuardrailResult[]; blocked?: boolean };
  cost: { total_usd: number; total_tokens: number; total_ms?: number; calls: LlmCall[] };
  status: TransactionStatus;
  links?: { parent_transaction?: string; evidence_events_emitted?: string[] };
}

export interface CostRollupRow {
  dimension: string;
  transactions: number;
  total_usd: number;
}

export interface Health {
  status: string;
  env: string;
  storage: string;
  gateway: string;
  framework_versions: Record<string, string>;
}

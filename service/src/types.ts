/**
 * Core platform types — TypeScript mirrors of the canonical JSON Schemas in d2d/schema/.
 * The schemas remain the source of truth (Fastify/Ajv validate against them at runtime);
 * these types give compile-time safety and are shared with the dashboard.
 */

// ---------- Agent Transaction (d2d/schema/agent-transaction.schema.json) ----------

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

export interface Evidence {
  sources: string[];
  tool_calls?: { tool: string; args_ref?: string; result_ref?: string }[];
  reasoning_summary: string;
  confidence?: number;
  framework_version?: string;
  rubric_version?: string;
}

export interface Critique {
  policy?: string;
  verdict: CriticVerdict | "skipped_by_policy";
  critics?: { model: string; verdict: CriticVerdict; checks?: string[]; justification?: string }[];
  revisions?: number;
}

export interface AgentTransaction {
  transaction_id: string;
  timestamp: string;
  subject_id?: string;
  agent: { name: string; version: string; role?: "planner" | "actor" | "critic" };
  plan_ref: { plan_id: string; step_id: string; workflow_id?: string };
  input_ref?: string;
  output: unknown;
  evidence: Evidence;
  critique: Critique;
  guardrails: { input?: GuardrailResult[]; output?: GuardrailResult[]; blocked?: boolean };
  cost: { total_usd: number; total_tokens: number; total_ms?: number; calls: LlmCall[] };
  status: TransactionStatus;
  links?: { parent_transaction?: string; evidence_events_emitted?: string[] };
}

// ---------- Plan (d2d/schema/plan.schema.json) ----------

export interface PlanStep {
  step_id: string;
  agent: string;
  depends_on?: string[];
  inputs?: Record<string, unknown>;
  output_contract: string;
  guardrail_policy?: string;
  critic_policy?: string;
  budget?: { max_usd?: number; max_tokens?: number };
  on_fail?: "retry" | "skip" | "escalate" | "replan";
}

export interface Plan {
  plan_id: string;
  goal: string;
  altitude: "macro" | "micro";
  subject_id?: string;
  created_by: string;
  revision_of?: string;
  steps: PlanStep[];
  replan_triggers?: string[];
}

// ---------- Evidence Event (d2d/schema/evidence-event.schema.json) ----------

export interface EvidenceEvent {
  event_id: string;
  learner_id: string;
  timestamp: string;
  source: string;
  competency_id: string;
  activity_type: "quiz" | "task" | "peer_review" | "live_session" | "gate_viva" | "diagnostic";
  modality: "async" | "sync";
  stakes: "formative" | "summative";
  score: number;
  scale_max: number;
  grader: { type: "deterministic" | "llm" | "human"; model?: string; passes?: number; justification?: string };
  framework_version: string;
  rubric_version?: string;
  calibration_id?: string;
  integrity?: { mismatch_delta?: number; flags?: string[] };
  evidence_refs?: string[];
  tags?: string[];
}

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

export interface LearnerSummary {
  learner_id: string;
  composite: number;
  rank_band: string;
  rank_band_id: string;
  integrity_review: number;
  evidence_count: number;
  competencies_at_threshold: number;
  competencies_total: number;
}

export interface EvidenceEvent {
  event_id: string;
  learner_id: string;
  timestamp: string;
  source: string;
  competency_id: string;
  activity_type: string;
  modality: "async" | "sync";
  stakes: "formative" | "summative";
  score: number;
  scale_max: number;
}

export interface AgentSummary {
  name: string; version: string; tier: string;
  guardrail_policy: string; critic_policy: string;
  transactions: number; total_usd: number; avg_ms: number;
  completed: number; revised: number; escalated: number; blocked: number;
  success_rate: number | null;
  attached_kbs: string[]; attached_guardrail_sets: string[];
}

export interface AgentDetail {
  name: string; version: string; tier: string;
  guardrail_policy: string; critic_policy: string; system_prompt: string;
  prompt_default: string; prompt_overridden: boolean; prompt_version: number | null;
  attached_kbs: string[]; attached_guardrail_sets: string[];
  recent_transactions: { transaction_id: string; timestamp: string; subject_id?: string; status: string; verdict: string; total_usd: number }[];
}

export interface KnowledgeBase {
  kb_id: string; name: string; description?: string; ts: string;
  doc_count?: number; attached_agents?: string[];
}
export interface KbDocument { document_id: string; kb_id: string; title: string; content: string; ts: string; }
export interface GuardrailSet {
  gr_id: string; name: string; description?: string; rule_ids: string[]; ts: string; attached_agents?: string[];
}
export interface GuardrailRuleDef {
  rule_id: string; name: string; description: string; severity: string; source: "built-in" | "custom";
}

export interface CohortRow {
  learner_id: string; course: string; status: string;
  completed: number; total: number; modules_complete: number; modules_total: number;
  project: { title: string; stakeholder: string; status: string } | null;
  last_active_at: string | null;
  bypass_onboarding: boolean;
}
/* ------------------------------------------------------------ accounts + roles */

export const ROLES = ["admin", "coach", "assessor", "learner"] as const;
export type Role = (typeof ROLES)[number];

/** Mirrors PERMISSIONS in service/src/auth.ts — the server is the authority. */
export type Permission =
  | "authorCurriculum" | "manageLearners" | "viewSignups"
  | "assess" | "configureAgents" | "manageUsers" | "viewOperator";

export interface SessionUser {
  user_id: string;
  email: string;
  name?: string;
  role: Role;
  learner_id?: string;
  must_change_password?: boolean;
}

export interface AccountRow extends SessionUser {
  disabled?: boolean;
  created_at?: string;
  last_login_at?: string;
}

/** Plain-English summary of each role, shown when creating an account. */
export const ROLE_BLURB: Record<Role, string> = {
  admin: "Everything, plus creating and disabling accounts.",
  coach: "Curriculum authoring, cohort, journeys, enrollment and the signups roster.",
  assessor: "Grading, integrity reviews and escalations. Read-only on curriculum.",
  learner: "Their own journey only — needs a learner_id to scope it to.",
};

/** The four lesson shapes the Trainer knows how to render. */
export const LESSON_TYPES = ["micro", "quiz", "roleplay", "task"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

export interface Milestone { title: string; definition_of_done: string }

export interface CourseSummary {
  course_id: string; title: string; outcome: string; status: string; ts?: string;
}
export interface LessonRow {
  lesson_id: string; module_id?: string; order: number; type: LessonType;
  competency_id: string; title: string; objective: string;
  key_points?: string[]; difficulty?: string; personalize?: boolean; pass_mark?: number;
}
export interface ModuleRow {
  module_id: string; title: string; order: number;
  competencies?: string[]; milestone?: Milestone; human_spine?: string;
  lessons?: LessonRow[];
}
export interface CourseDetail extends CourseSummary { modules?: ModuleRow[] }

/** Authoring payloads — what the create forms send. */
export interface NewModule {
  title: string; order?: number; competencies?: string[];
  milestone?: Milestone; human_spine?: string;
}
export interface NewLesson {
  order?: number; type: LessonType; competency_id: string; title: string;
  objective: string; key_points?: string[]; difficulty?: string;
  personalize?: boolean; pass_mark?: number;
}

/** A real registrant from the public landing-page funnel. OTP fields never leave the server. */
export interface Signup {
  learner_id: string; phone: string; email?: string; name?: string;
  status: "pending" | "verified"; created_at: string; verified_at?: string;
}

export interface Journey {
  learner_id: string; enrolled: boolean; course_id?: string; course_title?: string;
  completed?: number; total?: number;
  next_lesson?: { lesson_id: string; title: string; type: string; module: string } | null;
  project?: { title: string; stakeholder: string; problem: string; success_metric: string; status: string } | null;
  modules?: { title: string; done: number; total: number; complete: boolean; milestone?: { title: string; definition_of_done: string } }[];
}

export interface LearnerMeasurement {
  learner_id: string;
  mastery: { competency_id: string; name: string; estimate: number; at_threshold: boolean; threshold: number; evidence_count: number }[];
  composite: {
    base: number;
    integrity_multiplier: number;
    final: number;
    rank_band: string;
    rank_band_id: string;
    formula_version: string;
    framework_version: string;
    sources: { source: string; weight: number; score: number; evidence_count: number }[];
  };
  integrity: { competency_id: string; delta: number; async_score: number; sync_score: number; review: boolean }[];
  integrity_decisions?: { competency_id: string; decision: string }[];
  evidence_count: number;
  evidence: EvidenceEvent[];
}

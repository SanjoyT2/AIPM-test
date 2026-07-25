import type { AgentDetail, AgentSummary, AgentTransaction, CohortRow, CostRollupRow, GuardrailRuleDef, GuardrailSet, Health, Journey, KbDocument, KnowledgeBase, LearnerMeasurement, LearnerSummary } from "./types";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => get<Health>("/api/health"),
  transactions: (q: { agent?: string; subject?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.agent) p.set("agent", q.agent);
    if (q.subject) p.set("subject", q.subject);
    if (q.status) p.set("status", q.status);
    p.set("limit", String(q.limit ?? 200));
    return get<AgentTransaction[]>(`/api/transactions?${p}`);
  },
  transaction: (id: string) => get<AgentTransaction>(`/api/transactions/${encodeURIComponent(id)}`),
  costRollup: (by: string) => get<CostRollupRow[]>(`/api/costs/rollup?by=${by}`),
  frameworkVersions: () => get<Record<string, string>>("/api/config/frameworks"),
  framework: (name: string) => get<unknown>(`/api/config/frameworks/${name}`),
  learners: () => get<LearnerSummary[]>("/api/learners"),
  learner: (id: string) => get<LearnerMeasurement>(`/api/learners/${encodeURIComponent(id)}`),
  resolveIntegrity: (learner: string, competency: string, decision: "cleared" | "upheld") =>
    post(`/api/learners/${encodeURIComponent(learner)}/integrity/${encodeURIComponent(competency)}`, { decision }),
  resolveEscalation: (txId: string, decision: "acknowledged" | "overridden") =>
    post(`/api/transactions/${encodeURIComponent(txId)}/resolve`, { decision }),

  // Agent Studio
  agents: () => get<AgentSummary[]>("/api/agents"),
  agent: (name: string) => get<AgentDetail>(`/api/agents/${encodeURIComponent(name)}`),
  testAgent: (name: string, subject: string, text: string) =>
    post<{ transaction: AgentTransaction; retrieved: { document_id: string; title: string; score: number }[] }>(`/api/agents/${encodeURIComponent(name)}/test`, { subject, text }),
  attachResource: (agent: string, type: "kb" | "guardrail", resource_id: string, action: "attach" | "detach") =>
    post(`/api/agents/${encodeURIComponent(agent)}/resources`, { type, resource_id, action }),
  savePrompt: (agent: string, prompt: string) => post(`/api/agents/${encodeURIComponent(agent)}/prompt`, { prompt }),
  resetPrompt: (agent: string) => del(`/api/agents/${encodeURIComponent(agent)}/prompt`),

  // RAG knowledge bases
  kbs: () => get<KnowledgeBase[]>("/api/rag/kbs"),
  kb: (id: string) => get<KnowledgeBase & { documents: KbDocument[] }>(`/api/rag/kbs/${encodeURIComponent(id)}`),
  createKB: (name: string, description?: string) => post<KnowledgeBase>("/api/rag/kbs", { name, description }),
  deleteKB: (id: string) => del(`/api/rag/kbs/${encodeURIComponent(id)}`),
  addDoc: (kbId: string, title: string, content: string) => post<KbDocument>(`/api/rag/kbs/${encodeURIComponent(kbId)}/docs`, { title, content }),
  deleteDoc: (docId: string) => del(`/api/rag/docs/${encodeURIComponent(docId)}`),

  // Guardrails: plain-English rules + sets
  guardrailCatalog: () => get<{ rules: GuardrailRuleDef[]; all_rule_ids: string[] }>("/api/guardrails/catalog"),
  createRule: (name: string, description: string, severity: string) => post<GuardrailRuleDef>("/api/guardrails/rules", { name, description, severity }),
  deleteRule: (id: string) => del(`/api/guardrails/rules/${encodeURIComponent(id)}`),
  guardrailSets: () => get<GuardrailSet[]>("/api/guardrails/sets"),
  createGuardrailSet: (name: string, rule_ids: string[], description?: string) => post<GuardrailSet>("/api/guardrails/sets", { name, rule_ids, description }),
  deleteGuardrailSet: (id: string) => del(`/api/guardrails/sets/${encodeURIComponent(id)}`),

  // LMS / cohort
  courses: () => get<{ course_id: string; title: string; outcome: string; status: string }[]>("/api/courses"),
  course: (id: string) => get<any>(`/api/courses/${encodeURIComponent(id)}`),
  cohort: () => get<CohortRow[]>("/api/cohort"),
  journey: (learner: string) => get<Journey>(`/api/learners/${encodeURIComponent(learner)}/journey`),
  checkin: (learner: string) => post<{ message: string; status: string; flag_reason?: string }>(`/api/learners/${encodeURIComponent(learner)}/checkin`, {}),
  advance: async (learner: string, text: string, opKey: string) => {
    const r = await fetch(`/api/learners/${encodeURIComponent(learner)}/advance`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-operator-key": opKey }, body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(r.status === 401 ? "Wrong operator key" : `${r.status} ${r.statusText}`);
    return r.json() as Promise<{ reply: string; served_lesson_id?: string; graded?: { score: number; passed: boolean } }>;
  },
};

async function del(path: string): Promise<unknown> {
  const r = await fetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}`);
  return r.json();
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}`);
  return r.json() as Promise<T>;
}

export const fmtUsd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

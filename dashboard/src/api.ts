import type { AgentDetail, AgentSummary, AgentTransaction, CohortRow, CostRollupRow, CourseDetail, CourseSummary, GuardrailRuleDef, GuardrailSet, Health, Journey, KbDocument, KnowledgeBase, LearnerMeasurement, LearnerSummary, NewLesson, NewModule, Signup } from "./types";

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
  courses: () => get<CourseSummary[]>("/api/courses"),
  course: (id: string) => get<CourseDetail>(`/api/courses/${encodeURIComponent(id)}`),
  cohort: () => get<CohortRow[]>("/api/cohort"),

  // Authoring (operator-gated): course -> modules -> lessons
  createCourse: (title: string, outcome: string) =>
    opPost<CourseSummary>("/api/courses", { title, outcome }),
  setCourseStatus: (id: string, status: "published" | "draft") =>
    opPost<{ ok: boolean; status: string }>(`/api/courses/${encodeURIComponent(id)}/publish`, { status }),
  addModule: (courseId: string, m: NewModule) =>
    opPost<{ module_id: string }>(`/api/courses/${encodeURIComponent(courseId)}/modules`, m),
  addLesson: (moduleId: string, l: NewLesson) =>
    opPost<{ lesson_id: string }>(`/api/modules/${encodeURIComponent(moduleId)}/lessons`, l),
  updateLesson: (lessonId: string, patch: Partial<NewLesson>) =>
    opPut<{ lesson_id: string }>(`/api/lessons/${encodeURIComponent(lessonId)}`, patch),
  deleteLesson: (lessonId: string) => opDel<{ ok: boolean }>(`/api/lessons/${encodeURIComponent(lessonId)}`),

  // Signups roster (operator-gated — this is learner PII) + enrollment
  signups: () => opFetch<Signup[]>("/api/signups", { method: "GET" }),
  signupStats: () => get<{ verified: number; pending: number }>("/api/signup/stats"),
  enroll: (learner: string, course: string) =>
    opPost<{ learner_id: string; course_id: string }>("/api/enroll", { learner, course }),
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

// ---- Operator-authenticated calls (curriculum + learner writes) ----

const OP_KEY_SLOT = "d2d_op_key";
/** Fires when the key is set or cleared so the sidebar control re-renders. */
export const OP_KEY_EVENT = "d2d:opkey";

/** The key the operator entered once; stored per-browser. */
export const opKey = () => localStorage.getItem(OP_KEY_SLOT) ?? "";

export function setOpKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(OP_KEY_SLOT, trimmed);
  else localStorage.removeItem(OP_KEY_SLOT);
  window.dispatchEvent(new Event(OP_KEY_EVENT));
}

/**
 * Turns the server's gate responses into messages an operator can act on.
 * Deliberately does NOT call window.prompt(): browsers block it in several contexts
 * (embedded panes, cross-origin frames), which would silently break every write.
 * The key is entered in the sidebar instead.
 */
async function opFetch<T>(path: string, init: RequestInit): Promise<T> {
  const key = opKey();
  if (!key) throw new Error("No operator key set — add it at the bottom of the sidebar");
  const r = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-operator-key": key, ...(init.headers ?? {}) },
  });
  if (r.status === 401) {
    setOpKey(""); // wrong key — clear it rather than keep re-sending it
    throw new Error("Wrong operator key — re-enter it in the sidebar");
  }
  if (r.status === 503) throw new Error("Server has no OPERATOR_KEY configured");
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error((detail as any)?.error ?? `${r.status} ${r.statusText}`);
  }
  return r.json() as Promise<T>;
}

const opPost = <T>(path: string, body: unknown) => opFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
const opPut = <T>(path: string, body: unknown) => opFetch<T>(path, { method: "PUT", body: JSON.stringify(body) });
const opDel = <T>(path: string) => opFetch<T>(path, { method: "DELETE" });

export const fmtUsd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

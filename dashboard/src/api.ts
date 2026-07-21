import type { AgentTransaction, CostRollupRow, Health, LearnerMeasurement, LearnerSummary } from "./types";

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
};

export const fmtUsd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

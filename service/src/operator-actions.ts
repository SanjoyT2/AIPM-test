/**
 * Operator actions store (task #5) — the human decisions that make the Cockpit
 * action-oriented, not just readable. Append-only and auditable, like everything
 * else: who decided what, when, and why.
 *
 * Two decision types in Phase 1:
 *  - integrity: clear | uphold an async-vs-sync mismatch flag for a competency.
 *    A `clear` feeds back into the measurement engine (removes the composite
 *    penalty for that competency); an `uphold` keeps it.
 *  - escalation: resolve an escalated agent transaction (acknowledge | override).
 *
 * These are NOT agent transactions — a human acted, so forcing them into the
 * agent-transaction schema (evidence/critique/cost) would be dishonest. They get
 * their own record, cross-linked by target id.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { EvidenceEvent } from "./types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS operator_actions (
  action_id  TEXT PRIMARY KEY,
  doc        JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  type       TEXT GENERATED ALWAYS AS (doc->>'type') STORED,
  target_id  TEXT GENERATED ALWAYS AS (doc->>'target_id') STORED
);
CREATE INDEX IF NOT EXISTS idx_oa_target ON operator_actions (target_id);
CREATE INDEX IF NOT EXISTS idx_oa_type   ON operator_actions (type, ts DESC);
`;

export interface OperatorAction {
  action_id: string;
  ts: string;
  type: "integrity" | "escalation";
  target_id: string;                 // `${learner}:${competency}` for integrity, transaction_id for escalation
  learner_id?: string;
  competency_id?: string;
  decision: string;                  // cleared | upheld | acknowledged | overridden
  operator: string;
  note?: string;
}

export class OperatorActionStore {
  private pool: pg.Pool | null = null;
  private memory: OperatorAction[] = [];

  async init(pool: pg.Pool | null): Promise<void> {
    this.pool = pool;
    if (pool) await pool.query(DDL);
  }

  async record(a: Omit<OperatorAction, "action_id" | "ts">): Promise<OperatorAction> {
    const full: OperatorAction = { ...a, action_id: `oa-${randomUUID()}`, ts: new Date().toISOString() };
    if (this.pool) {
      await this.pool.query("INSERT INTO operator_actions (action_id, doc, ts) VALUES ($1, $2, $3)",
        [full.action_id, JSON.stringify(full), full.ts]);
    } else {
      this.memory.push(full);
    }
    return full;
  }

  async all(): Promise<OperatorAction[]> {
    if (this.pool) {
      const r = await this.pool.query("SELECT doc FROM operator_actions ORDER BY ts DESC");
      return r.rows.map((x) => x.doc);
    }
    return [...this.memory].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** Latest decision per target — later actions supersede earlier ones. */
  async latestByTarget(): Promise<Map<string, OperatorAction>> {
    const all = await this.all(); // newest first
    const m = new Map<string, OperatorAction>();
    for (const a of all) if (!m.has(a.target_id)) m.set(a.target_id, a);
    return m;
  }

  /** Competencies a human has CLEARED for a learner — fed to the measurement engine. */
  async clearedIntegrityFor(learnerId: string): Promise<Set<string>> {
    const latest = await this.latestByTarget();
    const cleared = new Set<string>();
    for (const a of latest.values()) {
      if (a.type === "integrity" && a.learner_id === learnerId && a.decision === "cleared" && a.competency_id) {
        cleared.add(a.competency_id);
      }
    }
    return cleared;
  }

  /** transaction_ids that have been resolved, with the decision. */
  async resolvedEscalations(): Promise<Map<string, OperatorAction>> {
    const latest = await this.latestByTarget();
    const m = new Map<string, OperatorAction>();
    for (const a of latest.values()) if (a.type === "escalation") m.set(a.target_id, a);
    return m;
  }
}

/** Guard: a competency can only be cleared if the learner actually has a flag for it. */
export function learnerHasEvidence(evs: EvidenceEvent[], competency: string): boolean {
  return evs.some((e) => e.competency_id === competency);
}

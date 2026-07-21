/**
 * Learner Record Store (LRS) — append-only store of domain evidence events
 * (doc 02). Distinct from the agent-transaction ledger: a transaction is *how*
 * an agent acted; an evidence event is *what it measured about a learner*. An
 * Examiner transaction, for instance, emits several evidence events.
 *
 * Same Postgres-JSONB-or-memory shape as the ledger.
 */
import pg from "pg";
import { settings } from "./settings.js";
import type { EvidenceEvent } from "./types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS evidence_events (
  event_id      TEXT PRIMARY KEY,
  doc           JSONB NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  learner_id    TEXT GENERATED ALWAYS AS (doc->>'learner_id') STORED,
  competency_id TEXT GENERATED ALWAYS AS (doc->>'competency_id') STORED,
  stakes        TEXT GENERATED ALWAYS AS (doc->>'stakes') STORED
);
CREATE INDEX IF NOT EXISTS idx_ev_learner ON evidence_events (learner_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ev_comp    ON evidence_events (competency_id);
`;

export class EvidenceStore {
  private pool: pg.Pool | null = null;
  private memory: EvidenceEvent[] = [];

  /** Share the ledger's pool so we don't open a second connection set on free-tier. */
  usesPool(pool: pg.Pool | null) {
    this.pool = pool;
  }

  async init(pool: pg.Pool | null): Promise<void> {
    this.pool = pool;
    if (pool) await pool.query(DDL);
  }

  async append(ev: EvidenceEvent): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO evidence_events (event_id, doc, ts) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING",
        [ev.event_id, JSON.stringify(ev), ev.timestamp],
      );
    } else {
      if (!this.memory.some((e) => e.event_id === ev.event_id)) this.memory.push(ev);
    }
  }

  async all(): Promise<EvidenceEvent[]> {
    if (this.pool) {
      const r = await this.pool.query("SELECT doc FROM evidence_events ORDER BY ts DESC");
      return r.rows.map((x) => x.doc);
    }
    return [...this.memory].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async forLearner(learnerId: string): Promise<EvidenceEvent[]> {
    if (this.pool) {
      const r = await this.pool.query("SELECT doc FROM evidence_events WHERE learner_id = $1 ORDER BY ts DESC", [learnerId]);
      return r.rows.map((x) => x.doc);
    }
    return this.memory.filter((e) => e.learner_id === learnerId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async learnerIds(): Promise<string[]> {
    if (this.pool) {
      const r = await this.pool.query("SELECT DISTINCT learner_id FROM evidence_events ORDER BY learner_id");
      return r.rows.map((x) => x.learner_id);
    }
    return [...new Set(this.memory.map((e) => e.learner_id))].sort();
  }
}

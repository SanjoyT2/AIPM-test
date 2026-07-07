/**
 * Transaction Ledger — append-only store for Agent Transactions (doc 04/06).
 * "If it isn't a transaction, it didn't happen."
 *
 * Postgres JSONB: the full transaction document is stored verbatim (audit),
 * with generated columns for the dimensions the dashboard filters on. Rollups
 * for the cost train are plain SQL over these columns.
 *
 * No DATABASE_URL => in-memory fallback so local dev runs without Postgres
 * (data is NOT durable; the API reports storage: "memory").
 */
import pg from "pg";
import { settings } from "./settings.js";
import type { AgentTransaction } from "./types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS agent_transactions (
  transaction_id TEXT PRIMARY KEY,
  doc            JSONB NOT NULL,
  ts             TIMESTAMPTZ GENERATED ALWAYS AS ((doc->>'timestamp')::timestamptz) STORED,
  agent_name     TEXT GENERATED ALWAYS AS (doc->'agent'->>'name') STORED,
  subject_id     TEXT GENERATED ALWAYS AS (doc->>'subject_id') STORED,
  plan_id        TEXT GENERATED ALWAYS AS (doc->'plan_ref'->>'plan_id') STORED,
  status         TEXT GENERATED ALWAYS AS (doc->>'status') STORED,
  total_usd      NUMERIC GENERATED ALWAYS AS ((doc->'cost'->>'total_usd')::numeric) STORED
);
CREATE INDEX IF NOT EXISTS idx_tx_agent   ON agent_transactions (agent_name, ts);
CREATE INDEX IF NOT EXISTS idx_tx_subject ON agent_transactions (subject_id, ts);
CREATE INDEX IF NOT EXISTS idx_tx_plan    ON agent_transactions (plan_id);
`;

export interface CostRollupRow {
  dimension: string;
  transactions: number;
  total_usd: number;
}

export class Ledger {
  private pool: pg.Pool | null = null;
  private memory: AgentTransaction[] = [];

  get storage(): "postgres" | "memory" {
    return this.pool ? "postgres" : "memory";
  }

  async init(): Promise<void> {
    if (!settings.databaseUrl) return; // memory mode
    this.pool = new pg.Pool({ connectionString: settings.databaseUrl });
    await this.pool.query(DDL);
  }

  /** Append-only. Rejects duplicates; there is no update path by design. */
  async append(tx: AgentTransaction): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO agent_transactions (transaction_id, doc) VALUES ($1, $2)",
        [tx.transaction_id, JSON.stringify(tx)],
      );
    } else {
      if (this.memory.some((t) => t.transaction_id === tx.transaction_id)) {
        throw new Error(`duplicate transaction_id ${tx.transaction_id}`);
      }
      this.memory.push(tx);
    }
  }

  async get(id: string): Promise<AgentTransaction | null> {
    if (this.pool) {
      const r = await this.pool.query("SELECT doc FROM agent_transactions WHERE transaction_id = $1", [id]);
      return r.rows[0]?.doc ?? null;
    }
    return this.memory.find((t) => t.transaction_id === id) ?? null;
  }

  async list(filter: { agent?: string; subject?: string; status?: string; limit?: number }): Promise<AgentTransaction[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    if (this.pool) {
      const clauses: string[] = [];
      const args: unknown[] = [];
      if (filter.agent) { args.push(filter.agent); clauses.push(`agent_name = $${args.length}`); }
      if (filter.subject) { args.push(filter.subject); clauses.push(`subject_id = $${args.length}`); }
      if (filter.status) { args.push(filter.status); clauses.push(`status = $${args.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      args.push(limit);
      const r = await this.pool.query(
        `SELECT doc FROM agent_transactions ${where} ORDER BY ts DESC LIMIT $${args.length}`, args,
      );
      return r.rows.map((row) => row.doc);
    }
    return this.memory
      .filter((t) =>
        (!filter.agent || t.agent.name === filter.agent) &&
        (!filter.subject || t.subject_id === filter.subject) &&
        (!filter.status || t.status === filter.status))
      .slice(-limit)
      .reverse();
  }

  /** The cost train: spend rolled up by a dimension (Req 3). */
  async costRollup(by: "agent" | "subject" | "plan" | "status"): Promise<CostRollupRow[]> {
    const col = { agent: "agent_name", subject: "subject_id", plan: "plan_id", status: "status" }[by];
    if (this.pool) {
      const r = await this.pool.query(
        `SELECT COALESCE(${col}, '(none)') AS dimension,
                COUNT(*)::int AS transactions,
                COALESCE(SUM(total_usd), 0)::float AS total_usd
         FROM agent_transactions GROUP BY 1 ORDER BY total_usd DESC`,
      );
      return r.rows;
    }
    const key = (t: AgentTransaction) =>
      by === "agent" ? t.agent.name :
      by === "subject" ? (t.subject_id ?? "(none)") :
      by === "plan" ? t.plan_ref.plan_id : t.status;
    const acc = new Map<string, CostRollupRow>();
    for (const t of this.memory) {
      const k = key(t);
      const row = acc.get(k) ?? { dimension: k, transactions: 0, total_usd: 0 };
      row.transactions += 1;
      row.total_usd += t.cost.total_usd;
      acc.set(k, row);
    }
    return [...acc.values()].sort((a, b) => b.total_usd - a.total_usd);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

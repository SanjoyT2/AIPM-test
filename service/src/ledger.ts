/**
 * Transaction Ledger — append-only store for Agent Transactions (doc 04/06).
 * "If it isn't a transaction, it didn't happen."
 *
 * Postgres JSONB: the full transaction document is stored verbatim (audit), with
 * projected columns for the dimensions the dashboard filters on. Rollups for the
 * cost train are plain SQL over those columns.
 *
 * `ts` is written explicitly at insert rather than as a generated column: casting
 * text -> timestamptz is STABLE (timezone-dependent), and Postgres only allows
 * IMMUTABLE expressions in generated columns. The purely textual/numeric
 * projections below are immutable and stay generated.
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
  ts             TIMESTAMPTZ NOT NULL,
  agent_name     TEXT    GENERATED ALWAYS AS (doc->'agent'->>'name') STORED,
  subject_id     TEXT    GENERATED ALWAYS AS (doc->>'subject_id') STORED,
  plan_id        TEXT    GENERATED ALWAYS AS (doc->'plan_ref'->>'plan_id') STORED,
  status         TEXT    GENERATED ALWAYS AS (doc->>'status') STORED,
  total_usd      NUMERIC GENERATED ALWAYS AS ((doc->'cost'->>'total_usd')::numeric) STORED
);
CREATE INDEX IF NOT EXISTS idx_tx_agent   ON agent_transactions (agent_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tx_subject ON agent_transactions (subject_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tx_plan    ON agent_transactions (plan_id);
CREATE INDEX IF NOT EXISTS idx_tx_ts      ON agent_transactions (ts DESC);
`;

export interface CostRollupRow {
  dimension: string;
  transactions: number;
  total_usd: number;
}

/**
 * Render's *external* Postgres URLs require TLS; the *internal* one does not.
 * Auto-detect, with DATABASE_SSL=true|false as an explicit override.
 */
function needsSsl(url: string): boolean {
  const override = process.env.DATABASE_SSL;
  if (override === "true") return true;
  if (override === "false") return false;
  if (/[?&]sslmode=(disable|allow)/.test(url)) return false;
  if (/[?&]sslmode=require/.test(url)) return true;
  return !/@(localhost|127\.0\.0\.1|db|postgres)[:/]/.test(url) && !url.includes(".internal");
}

export class Ledger {
  private pool: pg.Pool | null = null;
  private memory: AgentTransaction[] = [];

  get storage(): "postgres" | "memory" {
    return this.pool ? "postgres" : "memory";
  }

  /** Shared with the evidence store so both use one connection pool (free-tier cap). */
  getPool(): pg.Pool | null {
    return this.pool;
  }

  async init(): Promise<void> {
    if (!settings.databaseUrl) return; // memory mode — intentional for local dev
    const ssl = needsSsl(settings.databaseUrl);
    const pool = new pg.Pool({
      connectionString: settings.databaseUrl,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5), // free-tier Postgres has a low connection cap
      connectionTimeoutMillis: 10_000,
    });
    try {
      await pool.query(DDL);
    } catch (err) {
      await pool.end().catch(() => {});
      // Fail loudly: DATABASE_URL was set, so silently degrading to memory would
      // lose data the operator believes is persisted.
      throw new Error(
        `Ledger: DATABASE_URL is set but Postgres init failed (ssl=${ssl}). ` +
        `Check the connection string and DATABASE_SSL. Cause: ${(err as Error).message}`,
      );
    }
    this.pool = pool;
  }

  /** Append-only. Rejects duplicates; there is no update path by design. */
  async append(tx: AgentTransaction): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO agent_transactions (transaction_id, doc, ts) VALUES ($1, $2, $3)",
        [tx.transaction_id, JSON.stringify(tx), tx.timestamp],
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
      .slice()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  /** The cost train: spend rolled up by a dimension (Req 3). */
  async costRollup(by: "agent" | "subject" | "plan" | "status"): Promise<CostRollupRow[]> {
    const col = { agent: "agent_name", subject: "subject_id", plan: "plan_id", status: "status" }[by];
    if (this.pool) {
      const r = await this.pool.query(
        `SELECT COALESCE(${col}, '(none)') AS dimension,
                COUNT(*)::int AS transactions,
                COALESCE(SUM(total_usd), 0)::float8 AS total_usd
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

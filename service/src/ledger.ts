/**
 * Transaction Ledger — append-only store for Agent Transactions.
 * MongoDB implementation. Falls back to in-memory when DATABASE_URL is absent.
 * "If it isn't a transaction, it didn't happen."
 */
import { MongoClient, Db, Collection } from "mongodb";
import { settings } from "./settings.js";
import type { AgentTransaction } from "./types.js";

export interface CostRollupRow {
  dimension: string;
  transactions: number;
  total_usd: number;
}

export class Ledger {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private col: Collection | null = null;
  private memory: AgentTransaction[] = [];

  get storage(): "mongodb" | "memory" {
    return this.db ? "mongodb" : "memory";
  }

  /** Shared Db instance — other stores reuse the same connection. */
  getPool(): Db | null { return this.db; }

  async init(): Promise<void> {
    const url = settings.databaseUrl;
    if (!url) return; // memory mode — intentional for local dev
    try {
      this.client = new MongoClient(url);
      await this.client.connect();
      this.db = this.client.db(); // db name comes from URI path (e.g. /d2d)
      this.col = this.db.collection("transactions");
      await this.col.createIndex({ "agent.name": 1, timestamp: -1 });
      await this.col.createIndex({ subject_id: 1, timestamp: -1 });
      await this.col.createIndex({ "plan_ref.plan_id": 1 });
      await this.col.createIndex({ timestamp: -1 });
    } catch (err) {
      await this.client?.close().catch(() => {});
      this.client = null; this.db = null; this.col = null;
      throw new Error(
        `Ledger: MongoDB init failed. Check DATABASE_URL. Cause: ${(err as Error).message}`,
      );
    }
  }

  /** Append-only. Rejects duplicates; there is no update path by design. */
  async append(tx: AgentTransaction): Promise<void> {
    if (this.col) {
      try {
        await this.col.insertOne({ _id: tx.transaction_id as any, ...tx });
      } catch (e: any) {
        if (e.code === 11000) throw new Error(`duplicate transaction_id ${tx.transaction_id}`);
        throw e;
      }
    } else {
      if (this.memory.some((t) => t.transaction_id === tx.transaction_id)) {
        throw new Error(`duplicate transaction_id ${tx.transaction_id}`);
      }
      this.memory.push(tx);
    }
  }

  async get(id: string): Promise<AgentTransaction | null> {
    if (this.col) {
      const doc = await this.col.findOne({ _id: id as any });
      if (!doc) return null;
      const { _id, ...tx } = doc as any;
      return tx as AgentTransaction;
    }
    return this.memory.find((t) => t.transaction_id === id) ?? null;
  }

  async list(filter: { agent?: string; subject?: string; status?: string; limit?: number }): Promise<AgentTransaction[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    if (this.col) {
      const q: Record<string, any> = {};
      if (filter.agent) q["agent.name"] = filter.agent;
      if (filter.subject) q.subject_id = filter.subject;
      if (filter.status) q.status = filter.status;
      const docs = await this.col.find(q).sort({ timestamp: -1 }).limit(limit).toArray();
      return docs.map(({ _id, ...tx }) => tx as AgentTransaction);
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
    const fieldMap = { agent: "agent.name", subject: "subject_id", plan: "plan_ref.plan_id", status: "status" };
    const field = fieldMap[by];
    if (this.col) {
      const pipeline = [
        { $group: { _id: `$${field}`, transactions: { $sum: 1 }, total_usd: { $sum: "$cost.total_usd" } } },
        { $project: { _id: 0, dimension: { $ifNull: ["$_id", "(none)"] }, transactions: 1, total_usd: 1 } },
        { $sort: { total_usd: -1 } },
      ];
      return this.col.aggregate(pipeline).toArray() as Promise<CostRollupRow[]>;
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

  async close(): Promise<void> { await this.client?.close(); }
}

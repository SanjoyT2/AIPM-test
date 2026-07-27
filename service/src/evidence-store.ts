/**
 * Evidence Event Store (Learner Record Store / LRS) — MongoDB implementation.
 * Append-only with idempotent inserts (same event_id is a no-op).
 */
import type { Db, Collection } from "mongodb";
import type { EvidenceEvent } from "./types.js";

export class EvidenceStore {
  private col: Collection | null = null;
  private memory: EvidenceEvent[] = [];

  async init(db: Db | null): Promise<void> {
    if (!db) return; // memory mode
    this.col = db.collection("evidence");
    await this.col.createIndex({ learner_id: 1, timestamp: -1 });
    await this.col.createIndex({ competency_id: 1 });
  }

  /** Idempotent — same event_id is silently ignored. */
  async append(ev: EvidenceEvent): Promise<void> {
    if (this.col) {
      await this.col.updateOne(
        { _id: ev.event_id as any },
        { $setOnInsert: { _id: ev.event_id as any, ...ev } },
        { upsert: true },
      );
    } else {
      if (!this.memory.some((e) => e.event_id === ev.event_id)) this.memory.push(ev);
    }
  }

  async all(): Promise<EvidenceEvent[]> {
    if (this.col) {
      const docs = await this.col.find({}).sort({ timestamp: -1 }).toArray();
      return docs.map(({ _id, ...ev }) => ev as EvidenceEvent);
    }
    return [...this.memory].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async forLearner(learnerId: string): Promise<EvidenceEvent[]> {
    if (this.col) {
      const docs = await this.col.find({ learner_id: learnerId }).sort({ timestamp: -1 }).toArray();
      return docs.map(({ _id, ...ev }) => ev as EvidenceEvent);
    }
    return this.memory
      .filter((e) => e.learner_id === learnerId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async learnerIds(): Promise<string[]> {
    if (this.col) {
      const ids = await this.col.distinct("learner_id");
      return (ids as string[]).sort();
    }
    return [...new Set(this.memory.map((e) => e.learner_id))].sort();
  }
}

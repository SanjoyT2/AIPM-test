/**
 * Operator Decision Log — MongoDB implementation.
 * Append-only store for integrity clears and escalation resolutions.
 */
import { randomUUID } from "node:crypto";
import type { Db, Collection } from "mongodb";

export interface OperatorAction {
  action_id: string;
  type: "integrity" | "escalation";
  target_id: string;
  learner_id?: string;
  competency_id?: string;
  decision: string;
  operator: string;
  note?: string;
  ts: string;
}

export class OperatorActionStore {
  private col: Collection | null = null;
  private memory: OperatorAction[] = [];

  async init(db: Db | null): Promise<void> {
    if (!db) return;
    this.col = db.collection("operator_actions");
    await this.col.createIndex({ target_id: 1 });
    await this.col.createIndex({ type: 1, ts: -1 });
  }

  async record(a: Omit<OperatorAction, "action_id" | "ts">): Promise<OperatorAction> {
    const action: OperatorAction = { ...a, action_id: `oa-${randomUUID()}`, ts: new Date().toISOString() };
    if (this.col) {
      await this.col.insertOne({ _id: action.action_id as any, ...action });
    } else {
      this.memory.push(action);
    }
    return action;
  }

  async all(): Promise<OperatorAction[]> {
    if (this.col) {
      const docs = await this.col.find({}).sort({ ts: -1 }).toArray();
      return docs.map(({ _id, ...a }) => a as OperatorAction);
    }
    return [...this.memory].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** Latest decision per target — later supersedes earlier. */
  private async latestByTarget(): Promise<Map<string, OperatorAction>> {
    const all = await this.all();
    const map = new Map<string, OperatorAction>();
    // all() returns newest-first, so first write wins per target
    for (const a of all) if (!map.has(a.target_id)) map.set(a.target_id, a);
    return map;
  }

  /** Set of competency IDs that a human has cleared for a learner. */
  async clearedIntegrityFor(learnerId: string): Promise<Set<string>> {
    const map = await this.latestByTarget();
    const cleared = new Set<string>();
    for (const a of map.values()) {
      if (a.type === "integrity" && a.learner_id === learnerId && a.decision === "cleared" && a.competency_id) {
        cleared.add(a.competency_id);
      }
    }
    return cleared;
  }

  /** Map of transaction_id → action for resolved escalations. */
  async resolvedEscalations(): Promise<Map<string, OperatorAction>> {
    const map = await this.latestByTarget();
    const resolved = new Map<string, OperatorAction>();
    for (const [target, a] of map.entries()) {
      if (a.type === "escalation") resolved.set(target, a);
    }
    return resolved;
  }
}

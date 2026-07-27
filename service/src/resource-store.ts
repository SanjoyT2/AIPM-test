/**
 * Attachable resources (Agent Studio) — MongoDB implementation.
 * Knowledge bases (RAG) + guardrail sets + custom rules + prompt overrides + agent links.
 */
import { randomUUID } from "node:crypto";
import type { Db, Collection } from "mongodb";

export interface KnowledgeBase { kb_id: string; name: string; description?: string; ts: string; }
export interface KbDocument { document_id: string; kb_id: string; title: string; content: string; ts: string; }
export interface GuardrailSet { gr_id: string; name: string; description?: string; rule_ids: string[]; ts: string; }
export interface GuardrailRuleDef { rule_id: string; name: string; description: string; severity: "block" | "escalate" | "warn"; source: "custom"; ts: string; }
export interface PromptOverride { id: string; agent: string; version: number; prompt: string; author: string; ts: string; }
export interface RetrievedDoc extends KbDocument { score: number; }

const STOP = new Set("the a an and or of to in for on with is are be as at by it this that your you we our".split(" "));
const tokenize = (s: string) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((t) => !STOP.has(t));

export class ResourceStore {
  private col: {
    kbs: Collection; docs: Collection; sets: Collection; rules: Collection;
    prompts: Collection; links: Collection;
  } | null = null;
  private mem = {
    kbs: [] as KnowledgeBase[], docs: [] as KbDocument[], sets: [] as GuardrailSet[],
    rules: [] as GuardrailRuleDef[], prompts: [] as PromptOverride[],
    links: [] as { agent_name: string; resource_type: string; resource_id: string; ts: string }[],
  };

  async init(db: Db | null): Promise<void> {
    if (!db) return;
    this.col = {
      kbs: db.collection("knowledge_bases"),
      docs: db.collection("kb_documents"),
      sets: db.collection("guardrail_sets"),
      rules: db.collection("guardrail_rules"),
      prompts: db.collection("prompt_overrides"),
      links: db.collection("agent_resources"),
    };
    await this.col.docs.createIndex({ kb_id: 1 });
    await this.col.prompts.createIndex({ agent: 1, version: -1 });
    await this.col.links.createIndex({ agent_name: 1 });
    await this.col.links.createIndex({ resource_type: 1, resource_id: 1 });
    await this.col.links.createIndex(
      { agent_name: 1, resource_type: 1, resource_id: 1 },
      { unique: true },
    );
  }

  private now() { return new Date().toISOString(); }
  private strip<T>(doc: any): T { const { _id, ...rest } = doc; return rest as T; }

  // ---- Knowledge bases ----
  async createKB(name: string, description?: string): Promise<KnowledgeBase> {
    const kb: KnowledgeBase = { kb_id: `kb-${randomUUID()}`, name, description, ts: this.now() };
    if (this.col) await this.col.kbs.insertOne({ _id: kb.kb_id as any, ...kb });
    else this.mem.kbs.push(kb);
    return kb;
  }
  async listKBs(): Promise<KnowledgeBase[]> {
    if (this.col) return (await this.col.kbs.find({}).sort({ ts: -1 }).toArray()).map((d) => this.strip<KnowledgeBase>(d));
    return [...this.mem.kbs];
  }
  async getKB(id: string): Promise<KnowledgeBase | null> {
    if (this.col) { const d = await this.col.kbs.findOne({ _id: id as any }); return d ? this.strip<KnowledgeBase>(d) : null; }
    return this.mem.kbs.find((k) => k.kb_id === id) ?? null;
  }
  async deleteKB(id: string): Promise<void> {
    if (this.col) {
      await Promise.all([
        this.col.docs.deleteMany({ kb_id: id }),
        this.col.kbs.deleteOne({ _id: id as any }),
        this.col.links.deleteMany({ resource_type: "kb", resource_id: id }),
      ]);
    } else {
      this.mem.docs = this.mem.docs.filter((d) => d.kb_id !== id);
      this.mem.kbs = this.mem.kbs.filter((k) => k.kb_id !== id);
      this.mem.links = this.mem.links.filter((l) => !(l.resource_type === "kb" && l.resource_id === id));
    }
  }
  async addDoc(kbId: string, title: string, content: string): Promise<KbDocument> {
    const d: KbDocument = { document_id: `doc-${randomUUID()}`, kb_id: kbId, title, content, ts: this.now() };
    if (this.col) await this.col.docs.insertOne({ _id: d.document_id as any, ...d });
    else this.mem.docs.push(d);
    return d;
  }
  async listDocs(kbId: string): Promise<KbDocument[]> {
    if (this.col) return (await this.col.docs.find({ kb_id: kbId }).sort({ ts: -1 }).toArray()).map((d) => this.strip<KbDocument>(d));
    return this.mem.docs.filter((d) => d.kb_id === kbId);
  }
  async deleteDoc(docId: string): Promise<void> {
    if (this.col) await this.col.docs.deleteOne({ _id: docId as any });
    else this.mem.docs = this.mem.docs.filter((d) => d.document_id !== docId);
  }

  // ---- Guardrail sets ----
  async createGuardrailSet(name: string, ruleIds: string[], description?: string): Promise<GuardrailSet> {
    const gs: GuardrailSet = { gr_id: `gr-${randomUUID()}`, name, description, rule_ids: ruleIds, ts: this.now() };
    if (this.col) await this.col.sets.insertOne({ _id: gs.gr_id as any, ...gs });
    else this.mem.sets.push(gs);
    return gs;
  }
  async listGuardrailSets(): Promise<GuardrailSet[]> {
    if (this.col) return (await this.col.sets.find({}).sort({ ts: -1 }).toArray()).map((d) => this.strip<GuardrailSet>(d));
    return [...this.mem.sets];
  }
  async deleteGuardrailSet(id: string): Promise<void> {
    if (this.col) {
      await Promise.all([
        this.col.sets.deleteOne({ _id: id as any }),
        this.col.links.deleteMany({ resource_type: "guardrail", resource_id: id }),
      ]);
    } else {
      this.mem.sets = this.mem.sets.filter((s) => s.gr_id !== id);
      this.mem.links = this.mem.links.filter((l) => !(l.resource_type === "guardrail" && l.resource_id === id));
    }
  }

  // ---- Custom guardrail rules ----
  async createRule(name: string, description: string, severity: "block" | "escalate" | "warn"): Promise<GuardrailRuleDef> {
    const r: GuardrailRuleDef = { rule_id: `rule-${randomUUID()}`, name, description, severity, source: "custom", ts: this.now() };
    if (this.col) await this.col.rules.insertOne({ _id: r.rule_id as any, ...r });
    else this.mem.rules.push(r);
    return r;
  }
  async listRules(): Promise<GuardrailRuleDef[]> {
    if (this.col) return (await this.col.rules.find({}).sort({ ts: -1 }).toArray()).map((d) => this.strip<GuardrailRuleDef>(d));
    return [...this.mem.rules];
  }
  async deleteRule(id: string): Promise<void> {
    if (this.col) await this.col.rules.deleteOne({ _id: id as any });
    else this.mem.rules = this.mem.rules.filter((r) => r.rule_id !== id);
  }

  // ---- Prompt overrides (versioned, immutable history) ----
  async savePrompt(agent: string, prompt: string, author: string): Promise<PromptOverride> {
    const latest = await this.latestPrompt(agent);
    const po: PromptOverride = { id: `po-${randomUUID()}`, agent, version: (latest?.version ?? 0) + 1, prompt, author, ts: this.now() };
    if (this.col) await this.col.prompts.insertOne({ _id: po.id as any, ...po });
    else this.mem.prompts.push(po);
    return po;
  }
  async latestPrompt(agent: string): Promise<PromptOverride | null> {
    if (this.col) {
      const d = await this.col.prompts.findOne({ agent }, { sort: { version: -1 } });
      return d ? this.strip<PromptOverride>(d) : null;
    }
    const mine = this.mem.prompts.filter((p) => p.agent === agent);
    return mine.length ? mine.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  }
  async promptVersions(agent: string): Promise<PromptOverride[]> {
    if (this.col) return (await this.col.prompts.find({ agent }).sort({ version: -1 }).toArray()).map((d) => this.strip<PromptOverride>(d));
    return this.mem.prompts.filter((p) => p.agent === agent).sort((a, b) => b.version - a.version);
  }
  async clearPrompts(agent: string): Promise<void> {
    if (this.col) await this.col.prompts.deleteMany({ agent });
    else this.mem.prompts = this.mem.prompts.filter((p) => p.agent !== agent);
  }

  // ---- Attachments (many-to-many) ----
  async attach(agent: string, type: "kb" | "guardrail", resourceId: string): Promise<void> {
    const ts = this.now();
    if (this.col) {
      await this.col.links.updateOne(
        { agent_name: agent, resource_type: type, resource_id: resourceId },
        { $setOnInsert: { agent_name: agent, resource_type: type, resource_id: resourceId, ts } },
        { upsert: true },
      );
    } else if (!this.mem.links.some((l) => l.agent_name === agent && l.resource_type === type && l.resource_id === resourceId)) {
      this.mem.links.push({ agent_name: agent, resource_type: type, resource_id: resourceId, ts });
    }
  }
  async detach(agent: string, type: "kb" | "guardrail", resourceId: string): Promise<void> {
    if (this.col) await this.col.links.deleteOne({ agent_name: agent, resource_type: type, resource_id: resourceId });
    else this.mem.links = this.mem.links.filter((l) => !(l.agent_name === agent && l.resource_type === type && l.resource_id === resourceId));
  }
  private async linksFor(filter: { agent?: string; type?: string; resourceId?: string }): Promise<{ agent_name: string; resource_type: string; resource_id: string }[]> {
    if (this.col) {
      const q: Record<string, any> = {};
      if (filter.agent) q.agent_name = filter.agent;
      if (filter.type) q.resource_type = filter.type;
      if (filter.resourceId) q.resource_id = filter.resourceId;
      return (await this.col.links.find(q).toArray()).map(({ _id, ts, ...l }) => l as any);
    }
    return this.mem.links.filter((l) =>
      (!filter.agent || l.agent_name === filter.agent) &&
      (!filter.type || l.resource_type === filter.type) &&
      (!filter.resourceId || l.resource_id === filter.resourceId));
  }
  async agentKbIds(agent: string): Promise<string[]> { return (await this.linksFor({ agent, type: "kb" })).map((l) => l.resource_id); }
  async agentGuardrailSetIds(agent: string): Promise<string[]> { return (await this.linksFor({ agent, type: "guardrail" })).map((l) => l.resource_id); }
  async agentsForResource(type: "kb" | "guardrail", id: string): Promise<string[]> { return (await this.linksFor({ type, resourceId: id })).map((l) => l.agent_name); }

  /** Effective extra guardrail rule ids for an agent from its attached sets (union). */
  async agentAttachedGuardrailRuleIds(agent: string): Promise<string[]> {
    const ids = new Set(await this.agentGuardrailSetIds(agent));
    if (!ids.size) return [];
    const sets = await this.listGuardrailSets();
    const rules = new Set<string>();
    for (const s of sets) if (ids.has(s.gr_id)) for (const r of s.rule_ids) rules.add(r);
    return [...rules];
  }

  /** RAG retrieval: top-K docs across every knowledge base attached to the agent. */
  async retrieve(agent: string, query: string, k = 3): Promise<RetrievedDoc[]> {
    const kbIds = await this.agentKbIds(agent);
    if (!kbIds.length) return [];
    const qTokens = new Set(tokenize(query));
    if (!qTokens.size) return [];
    const docs: KbDocument[] = [];
    for (const kb of kbIds) docs.push(...await this.listDocs(kb));
    const scored = docs.map((d) => {
      const hay = tokenize(`${d.title} ${d.title} ${d.content}`);
      let score = 0;
      for (const t of hay) if (qTokens.has(t)) score++;
      return { ...d, score };
    }).filter((d) => d.score > 0);
    scored.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
    return scored.slice(0, k);
  }
}

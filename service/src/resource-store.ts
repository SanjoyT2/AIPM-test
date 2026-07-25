/**
 * Attachable resources (Agent Studio) — standalone resources composed once and
 * attached many-to-many to agents. Two types:
 *
 *   - knowledge base (RAG): a named set of documents. Retrieval gathers docs from
 *     ALL knowledge bases attached to an agent, ranks by relevance, injects the
 *     top-K into the actor context, and records them as evidence.sources.
 *   - guardrail set: a named bundle of rule ids (from guardrails.yaml's catalog).
 *     An agent's effective guardrails = its base policy ∪ every attached set.
 *
 * A resource is independent of any agent; attach/detach is a separate link, so the
 * SAME knowledge base or guardrail set can serve multiple agents.
 *
 * Retrieval is keyword-overlap for v1 (deterministic, explainable, no embedding
 * cost). The store is shaped so swapping in pgvector later touches only retrieve().
 * Postgres JSONB / in-memory, same pattern as the ledger.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS knowledge_bases (
  kb_id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  name TEXT GENERATED ALWAYS AS (doc->>'name') STORED
);
CREATE TABLE IF NOT EXISTS kb_documents (
  document_id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  kb_id TEXT GENERATED ALWAYS AS (doc->>'kb_id') STORED
);
CREATE INDEX IF NOT EXISTS idx_kbdoc_kb ON kb_documents (kb_id);
CREATE TABLE IF NOT EXISTS guardrail_sets (
  gr_id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  name TEXT GENERATED ALWAYS AS (doc->>'name') STORED
);
CREATE TABLE IF NOT EXISTS guardrail_rules (
  rule_id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_overrides (
  id TEXT PRIMARY KEY, doc JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL,
  agent TEXT GENERATED ALWAYS AS (doc->>'agent') STORED,
  version INT GENERATED ALWAYS AS ((doc->>'version')::int) STORED
);
CREATE INDEX IF NOT EXISTS idx_prompt_agent ON prompt_overrides (agent, version DESC);
CREATE TABLE IF NOT EXISTS agent_resources (
  agent_name TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_name, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_agent ON agent_resources (agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_res   ON agent_resources (resource_type, resource_id);
`;

export interface KnowledgeBase { kb_id: string; name: string; description?: string; ts: string; }
export interface KbDocument { document_id: string; kb_id: string; title: string; content: string; ts: string; }
export interface GuardrailSet { gr_id: string; name: string; description?: string; rule_ids: string[]; ts: string; }
export interface GuardrailRuleDef { rule_id: string; name: string; description: string; severity: "block" | "escalate" | "warn"; source: "custom"; ts: string; }
export interface PromptOverride { id: string; agent: string; version: number; prompt: string; author: string; ts: string; }
export interface RetrievedDoc extends KbDocument { score: number; }

const STOP = new Set("the a an and or of to in for on with is are be as at by it this that your you we our".split(" "));
const tokenize = (s: string) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((t) => !STOP.has(t));

export class ResourceStore {
  private pool: pg.Pool | null = null;
  private mem = { kbs: [] as KnowledgeBase[], docs: [] as KbDocument[], sets: [] as GuardrailSet[], rules: [] as GuardrailRuleDef[], prompts: [] as PromptOverride[],
    links: [] as { agent_name: string; resource_type: string; resource_id: string; ts: string }[] };

  async init(pool: pg.Pool | null): Promise<void> {
    this.pool = pool;
    if (pool) await pool.query(DDL);
  }

  private now() { return new Date().toISOString(); }

  // ---- Knowledge bases ----
  async createKB(name: string, description?: string): Promise<KnowledgeBase> {
    const kb: KnowledgeBase = { kb_id: `kb-${randomUUID()}`, name, description, ts: this.now() };
    if (this.pool) await this.pool.query("INSERT INTO knowledge_bases (kb_id, doc, ts) VALUES ($1,$2,$3)", [kb.kb_id, JSON.stringify(kb), kb.ts]);
    else this.mem.kbs.push(kb);
    return kb;
  }
  async listKBs(): Promise<KnowledgeBase[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM knowledge_bases ORDER BY ts DESC")).rows.map((r) => r.doc);
    return [...this.mem.kbs];
  }
  async getKB(id: string): Promise<KnowledgeBase | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM knowledge_bases WHERE kb_id=$1", [id])).rows[0]?.doc ?? null;
    return this.mem.kbs.find((k) => k.kb_id === id) ?? null;
  }
  async deleteKB(id: string): Promise<void> {
    if (this.pool) {
      await this.pool.query("DELETE FROM kb_documents WHERE kb_id=$1", [id]);
      await this.pool.query("DELETE FROM knowledge_bases WHERE kb_id=$1", [id]);
      await this.pool.query("DELETE FROM agent_resources WHERE resource_type='kb' AND resource_id=$1", [id]);
    } else {
      this.mem.docs = this.mem.docs.filter((d) => d.kb_id !== id);
      this.mem.kbs = this.mem.kbs.filter((k) => k.kb_id !== id);
      this.mem.links = this.mem.links.filter((l) => !(l.resource_type === "kb" && l.resource_id === id));
    }
  }
  async addDoc(kbId: string, title: string, content: string): Promise<KbDocument> {
    const d: KbDocument = { document_id: `doc-${randomUUID()}`, kb_id: kbId, title, content, ts: this.now() };
    if (this.pool) await this.pool.query("INSERT INTO kb_documents (document_id, doc, ts) VALUES ($1,$2,$3)", [d.document_id, JSON.stringify(d), d.ts]);
    else this.mem.docs.push(d);
    return d;
  }
  async listDocs(kbId: string): Promise<KbDocument[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM kb_documents WHERE kb_id=$1 ORDER BY ts DESC", [kbId])).rows.map((r) => r.doc);
    return this.mem.docs.filter((d) => d.kb_id === kbId);
  }
  async deleteDoc(docId: string): Promise<void> {
    if (this.pool) await this.pool.query("DELETE FROM kb_documents WHERE document_id=$1", [docId]);
    else this.mem.docs = this.mem.docs.filter((d) => d.document_id !== docId);
  }

  // ---- Guardrail sets ----
  async createGuardrailSet(name: string, ruleIds: string[], description?: string): Promise<GuardrailSet> {
    const gs: GuardrailSet = { gr_id: `gr-${randomUUID()}`, name, description, rule_ids: ruleIds, ts: this.now() };
    if (this.pool) await this.pool.query("INSERT INTO guardrail_sets (gr_id, doc, ts) VALUES ($1,$2,$3)", [gs.gr_id, JSON.stringify(gs), gs.ts]);
    else this.mem.sets.push(gs);
    return gs;
  }
  async listGuardrailSets(): Promise<GuardrailSet[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM guardrail_sets ORDER BY ts DESC")).rows.map((r) => r.doc);
    return [...this.mem.sets];
  }
  async deleteGuardrailSet(id: string): Promise<void> {
    if (this.pool) {
      await this.pool.query("DELETE FROM guardrail_sets WHERE gr_id=$1", [id]);
      await this.pool.query("DELETE FROM agent_resources WHERE resource_type='guardrail' AND resource_id=$1", [id]);
    } else {
      this.mem.sets = this.mem.sets.filter((s) => s.gr_id !== id);
      this.mem.links = this.mem.links.filter((l) => !(l.resource_type === "guardrail" && l.resource_id === id));
    }
  }

  // ---- Custom guardrail rules (plain-English, user-created, LLM-enforced) ----
  async createRule(name: string, description: string, severity: "block" | "escalate" | "warn"): Promise<GuardrailRuleDef> {
    const r: GuardrailRuleDef = { rule_id: `rule-${randomUUID()}`, name, description, severity, source: "custom", ts: this.now() };
    if (this.pool) await this.pool.query("INSERT INTO guardrail_rules (rule_id, doc, ts) VALUES ($1,$2,$3)", [r.rule_id, JSON.stringify(r), r.ts]);
    else this.mem.rules.push(r);
    return r;
  }
  async listRules(): Promise<GuardrailRuleDef[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM guardrail_rules ORDER BY ts DESC")).rows.map((x) => x.doc);
    return [...this.mem.rules];
  }
  async deleteRule(id: string): Promise<void> {
    if (this.pool) await this.pool.query("DELETE FROM guardrail_rules WHERE rule_id=$1", [id]);
    else this.mem.rules = this.mem.rules.filter((r) => r.rule_id !== id);
  }

  // ---- Prompt overrides (editable, versioned agent prompts) ----
  async savePrompt(agent: string, prompt: string, author: string): Promise<PromptOverride> {
    const latest = await this.latestPrompt(agent);
    const po: PromptOverride = { id: `po-${randomUUID()}`, agent, version: (latest?.version ?? 0) + 1, prompt, author, ts: this.now() };
    if (this.pool) await this.pool.query("INSERT INTO prompt_overrides (id, doc, ts) VALUES ($1,$2,$3)", [po.id, JSON.stringify(po), po.ts]);
    else this.mem.prompts.push(po);
    return po;
  }
  async latestPrompt(agent: string): Promise<PromptOverride | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM prompt_overrides WHERE agent=$1 ORDER BY version DESC LIMIT 1", [agent])).rows[0]?.doc ?? null;
    const mine = this.mem.prompts.filter((p) => p.agent === agent);
    return mine.length ? mine.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  }
  async promptVersions(agent: string): Promise<PromptOverride[]> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM prompt_overrides WHERE agent=$1 ORDER BY version DESC", [agent])).rows.map((r) => r.doc);
    return this.mem.prompts.filter((p) => p.agent === agent).sort((a, b) => b.version - a.version);
  }
  async clearPrompts(agent: string): Promise<void> {
    if (this.pool) await this.pool.query("DELETE FROM prompt_overrides WHERE agent=$1", [agent]);
    else this.mem.prompts = this.mem.prompts.filter((p) => p.agent !== agent);
  }

  // ---- Attachments (many-to-many) ----
  async attach(agent: string, type: "kb" | "guardrail", resourceId: string): Promise<void> {
    const ts = this.now();
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO agent_resources (agent_name, resource_type, resource_id, ts) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [agent, type, resourceId, ts]);
    } else if (!this.mem.links.some((l) => l.agent_name === agent && l.resource_type === type && l.resource_id === resourceId)) {
      this.mem.links.push({ agent_name: agent, resource_type: type, resource_id: resourceId, ts });
    }
  }
  async detach(agent: string, type: "kb" | "guardrail", resourceId: string): Promise<void> {
    if (this.pool) await this.pool.query("DELETE FROM agent_resources WHERE agent_name=$1 AND resource_type=$2 AND resource_id=$3", [agent, type, resourceId]);
    else this.mem.links = this.mem.links.filter((l) => !(l.agent_name === agent && l.resource_type === type && l.resource_id === resourceId));
  }
  private async linksFor(filter: { agent?: string; type?: string; resourceId?: string }): Promise<{ agent_name: string; resource_type: string; resource_id: string }[]> {
    if (this.pool) {
      const c: string[] = []; const a: unknown[] = [];
      if (filter.agent) { a.push(filter.agent); c.push(`agent_name=$${a.length}`); }
      if (filter.type) { a.push(filter.type); c.push(`resource_type=$${a.length}`); }
      if (filter.resourceId) { a.push(filter.resourceId); c.push(`resource_id=$${a.length}`); }
      const where = c.length ? `WHERE ${c.join(" AND ")}` : "";
      return (await this.pool.query(`SELECT agent_name, resource_type, resource_id FROM agent_resources ${where}`, a)).rows;
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
      const hay = tokenize(`${d.title} ${d.title} ${d.content}`); // title double-weighted
      let score = 0;
      for (const t of hay) if (qTokens.has(t)) score++;
      return { ...d, score };
    }).filter((d) => d.score > 0);
    scored.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
    return scored.slice(0, k);
  }
}

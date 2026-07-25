/**
 * D2D Phase-1 service — Fastify API.
 *
 * Boot order is deliberate: frameworks load + validate FIRST (fail-loud, ADR-006),
 * then the ledger, then routes. Every transaction posted to the ledger is validated
 * against the canonical JSON Schema — the same file that documents it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { loadAgents } from "./agents.js";
import { loadFrameworks } from "./config-loader.js";
import { LmsStore } from "./content-store.js";
import { DailyLoop } from "./daily-loop.js";
import { EvidenceStore } from "./evidence-store.js";
import { LearningEngine } from "./learning.js";
import { Executor } from "./executor.js";
import { LlmGateway } from "./gateway.js";
import { Ledger } from "./ledger.js";
import { MeasurementEngine } from "./measurement.js";
import { OperatorActionStore } from "./operator-actions.js";
import { ResourceStore } from "./resource-store.js";
import { settings } from "./settings.js";
import { Signups } from "./signups.js";
import type { AgentTransaction, EvidenceEvent } from "./types.js";
import { compileSchema } from "./validation.js";
import { WaClient } from "./wa-client.js";

/**
 * Constant-time secret comparison. Both sides are hashed first so the digests are
 * always equal length — timingSafeEqual throws on length mismatch, and comparing
 * raw values would leak the secret's length.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function main() {
  // 1. Frameworks (throws on invalid config — refuse to boot)
  const frameworks = loadFrameworks();

  // 2. Ledger + gateway + evidence store (LRS) + measurement engine
  const ledger = new Ledger();
  await ledger.init();
  const evidence = new EvidenceStore();
  await evidence.init(ledger.getPool());
  const operatorActions = new OperatorActionStore();
  await operatorActions.init(ledger.getPool());
  const resources = new ResourceStore();
  await resources.init(ledger.getPool());
  const measurement = new MeasurementEngine(frameworks);
  const gateway = new LlmGateway(frameworks.costModel);

  // Make the two "am I actually configured?" answers loud in the boot log — a
  // silently-ephemeral ledger is the failure people notice a week too late.
  if (ledger.storage === "memory") {
    console.warn(
      "[ledger] DATABASE_URL is not set — running IN-MEMORY. Transactions are lost on restart/redeploy. " +
      "Set DATABASE_URL to a Postgres connection string to persist.",
    );
  } else {
    console.info("[ledger] Postgres connected — transactions are durable.");
  }
  if (gateway.stubMode) {
    console.warn(
      "[gateway] OPENAI_API_KEY is not set — running in STUB mode. Agents return canned text and cost is simulated. " +
      "Set OPENAI_API_KEY for live model calls.",
    );
  } else {
    console.info(`[gateway] OpenAI live — fast=${settings.models.fast} deep=${settings.models.deep}`);
  }

  // 3. Canonical schema validators for inbound records
  const validateTx = compileSchema(
    JSON.parse(fs.readFileSync(path.join(settings.schemaDir, "agent-transaction.schema.json"), "utf8")),
  );
  const validateEv = compileSchema(
    JSON.parse(fs.readFileSync(path.join(settings.schemaDir, "evidence-event.schema.json"), "utf8")),
  );

  // 4. Executor + daily loop (plan-and-act runtime) + WhatsApp outbound
  const agents = loadAgents();
  const executor = new Executor(frameworks, gateway, ledger, validateTx as (tx: unknown) => boolean);
  const wa = new WaClient();
  if (wa.stubMode) {
    console.warn("[wa] WA_API_TOKEN not set — outbound WhatsApp in STUB mode (messages are logged, not sent).");
  } else {
    console.info(`[wa] 11za outbound live — base=${settings.wa.apiBase}`);
  }
  const dailyLoop = new DailyLoop(executor, agents, frameworks, wa, resources);
  const signups = new Signups(wa);
  await signups.init(ledger.getPool());
  const lms = new LmsStore();
  await lms.init(ledger.getPool());
  const learning = new LearningEngine(lms, evidence, gateway, dailyLoop, frameworks.versions.competency_framework);

  // Merged guardrail-rule catalog: built-in config rules (now plain-English,
  // LLM-enforced) + user-created custom rules. Used to validate sets + for the UI.
  const configRuleDefs = () => Object.entries<any>(frameworks.guardrails.rules ?? {}).map(([id, r]) => ({
    rule_id: id, name: id, description: r.detail ?? id, severity: r.severity ?? "warn", source: "built-in" as const,
  }));
  const ruleCatalog = async () => {
    const custom = (await resources.listRules()).map((r) => ({ rule_id: r.rule_id, name: r.name, description: r.description, severity: r.severity, source: "custom" as const }));
    return [...configRuleDefs(), ...custom];
  };
  dailyLoop.startSilenceSweep();

  const app = Fastify({ logger: true });

  // ---- Health & meta ----
  app.get("/api/health", async () => ({
    status: "ok",
    env: settings.env,
    storage: ledger.storage,
    gateway: gateway.stubMode ? "stub" : "live",
    whatsapp: wa.stubMode ? "stub" : "live",
    framework_versions: frameworks.versions,
  }));

  // ---- Public signup (landing page) — WhatsApp OTP onboarding ----
  app.post("/api/signup", async (req, reply) => {
    const { name, phone, email } = (req.body ?? {}) as { name?: string; phone?: string; email?: string };
    if (!phone || !email) return reply.code(400).send({ ok: false, error: "Phone and email are required." });
    const r = await signups.startSignup({ name, phone, email });
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  app.post("/api/signup/verify", async (req, reply) => {
    const { phone, otp } = (req.body ?? {}) as { phone?: string; otp?: string };
    if (!phone || !otp) return reply.code(400).send({ ok: false, error: "Phone and code are required." });
    const r = await signups.verify(phone, otp);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  app.get("/api/signup/stats", async () => signups.count());

  // ---- LMS: courses -> modules -> lessons, enrollment, journey (the CMS) ----
  app.get("/api/courses", async () => lms.listCourses());
  app.post("/api/courses", async (req, reply) => {
    const { title, outcome } = (req.body ?? {}) as { title?: string; outcome?: string };
    if (!title) return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send(await lms.createCourse(title, outcome ?? ""));
  });
  app.get("/api/courses/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const course = await lms.getCourse(id);
    if (!course) return reply.code(404).send({ error: "not found" });
    const modules = await lms.listModules(id);
    const withLessons = await Promise.all(modules.map(async (m) => ({ ...m, lessons: await lms.listLessons(m.module_id) })));
    return { ...course, modules: withLessons };
  });
  app.post("/api/courses/:id/publish", async (req) => { await lms.setCourseStatus((req.params as { id: string }).id, "published"); return { ok: true }; });
  app.post("/api/courses/:id/modules", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, order, competencies, milestone, human_spine } = (req.body ?? {}) as { title?: string; order?: number; competencies?: string[]; milestone?: { title: string; definition_of_done: string }; human_spine?: string };
    if (!title) return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send(await lms.addModule(id, title, order ?? 999, competencies ?? [], { milestone, human_spine }));
  });
  app.post("/api/modules/:id/lessons", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as any;
    if (!b.type || !b.competency_id || !b.title || !b.objective) return reply.code(400).send({ error: "type, competency_id, title, objective are required" });
    return reply.code(201).send(await lms.addLesson(id, {
      order: b.order ?? 999, type: b.type, competency_id: b.competency_id, title: b.title,
      objective: b.objective, key_points: b.key_points ?? [], difficulty: b.difficulty ?? "core",
      personalize: b.personalize ?? true, pass_mark: b.pass_mark ?? 60,
    }));
  });
  app.put("/api/lessons/:id", async (req, reply) => {
    const u = await lms.updateLesson((req.params as { id: string }).id, (req.body ?? {}) as any);
    return u ? u : reply.code(404).send({ error: "not found" });
  });
  app.delete("/api/lessons/:id", async (req) => { await lms.deleteLesson((req.params as { id: string }).id); return { ok: true }; });

  // Enrollment + a learner's journey progress.
  app.post("/api/enroll", async (req, reply) => {
    const { learner, course } = (req.body ?? {}) as { learner?: string; course?: string };
    if (!learner || !course) return reply.code(400).send({ error: "learner and course are required" });
    return reply.code(201).send(await lms.enroll(learner, course));
  });
  app.get("/api/learners/:id/journey", async (req) => {
    const { id } = req.params as { id: string };
    const enr = await lms.activeEnrollment(id);
    if (!enr) return { learner_id: id, enrolled: false };
    const p = await lms.getProgress(id, enr.course_id);
    const journey = await lms.courseJourney(enr.course_id);
    const next = await lms.nextStep(id, enr.course_id);
    const modules = await lms.moduleProgress(id, enr.course_id);
    const project = await lms.getProject(id);
    return {
      learner_id: id, enrolled: true, course_id: enr.course_id,
      completed: p.completed.length, total: journey.length, awaiting_lesson_id: p.awaiting_lesson_id,
      next_lesson: next ? { lesson_id: next.lesson_id, title: next.title, type: next.type, module: next.module_title } : null,
      project,
      modules: modules.map((m) => ({ title: m.module.title, done: m.done, total: m.total, complete: m.complete, milestone: m.module.milestone })),
    };
  });

  // The learner's one solution (project).
  app.get("/api/learners/:id/project", async (req) => (await lms.getProject((req.params as { id: string }).id)) ?? { learner_id: (req.params as { id: string }).id, project: null });
  app.post("/api/learners/:id/project", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { title?: string; stakeholder?: string; problem?: string; success_metric?: string; status?: string };
    if (!b.title || !b.stakeholder) return reply.code(400).send({ error: "title and stakeholder are required" });
    return reply.code(201).send(await lms.setProject({ learner_id: id, title: b.title, stakeholder: b.stakeholder, problem: b.problem ?? "", success_metric: b.success_metric ?? "", status: (b.status as any) ?? "scoping" }));
  });

  // Coach (AI Program Manager) weekly check-in.
  app.post("/api/learners/:id/checkin", async (req) => {
    const { id } = req.params as { id: string };
    const { trigger } = (req.body ?? {}) as { trigger?: string };
    return learning.checkIn(id, trigger);
  });

  // Operator-driven journey step (authenticated). Lets a coach walk a learner's real
  // journey from the console before 11za is connected. Drives real LLM spend, so it
  // requires the operator key and fails closed in production if that key is unset.
  app.post("/api/learners/:id/advance", async (req, reply) => {
    if (!settings.operatorKey) {
      if (settings.env === "production") return reply.code(503).send({ error: "operator actions not configured (set OPERATOR_KEY)" });
    } else if (!timingSafeEqualStr((req.headers["x-operator-key"] ?? "") as string, settings.operatorKey)) {
      return reply.code(401).send({ error: "bad operator key" });
    }
    const { id } = req.params as { id: string };
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text) return reply.code(400).send({ error: "text is required" });
    return learning.onMessage(id, text);
  });

  // Coach cohort view: every enrolled learner with progress + status.
  app.get("/api/cohort", async () => {
    const enrs = await lms.listEnrollments();
    const seen = new Set<string>();
    const rows = [];
    for (const e of enrs) {
      if (seen.has(e.learner_id)) continue; seen.add(e.learner_id);
      const mods = await lms.moduleProgress(e.learner_id, e.course_id);
      const total = mods.reduce((a, m) => a + m.total, 0);
      const done = mods.reduce((a, m) => a + m.done, 0);
      const course = await lms.getCourse(e.course_id);
      const project = await lms.getProject(e.learner_id);
      rows.push({ learner_id: e.learner_id, course: course?.title ?? e.course_id, status: e.status, completed: done, total, modules_complete: mods.filter((m) => m.complete).length, modules_total: mods.length, project: project ? { title: project.title, stakeholder: project.stakeholder, status: project.status } : null });
    }
    return rows;
  });

  app.get("/api/config/frameworks", async () => frameworks.versions);
  app.get("/api/config/frameworks/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const map: Record<string, unknown> = {
      "competency-framework": frameworks.competencyFramework,
      "composite-formula": frameworks.compositeFormula,
      "progression-rules": frameworks.progressionRules,
      diagnostic: frameworks.diagnostic,
      guardrails: frameworks.guardrails,
      critics: frameworks.critics,
      "cost-model": frameworks.costModel,
    };
    if (!(name in map)) return reply.code(404).send({ error: `unknown framework '${name}'` });
    return map[name];
  });

  // ---- Transaction ledger (Req 1-4 all live on this record) ----
  app.post("/api/transactions", async (req, reply) => {
    const body = req.body as AgentTransaction;
    if (!validateTx(body)) {
      return reply.code(422).send({ error: "schema validation failed", details: validateTx.errors });
    }
    try {
      await ledger.append(body);
    } catch (e) {
      return reply.code(409).send({ error: String(e) });
    }
    return reply.code(201).send({ transaction_id: body.transaction_id });
  });

  app.get("/api/transactions", async (req) => {
    const q = req.query as { agent?: string; subject?: string; status?: string; limit?: string };
    return ledger.list({ agent: q.agent, subject: q.subject, status: q.status, limit: q.limit ? Number(q.limit) : undefined });
  });

  app.get("/api/transactions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tx = await ledger.get(id);
    if (!tx) return reply.code(404).send({ error: "not found" });
    return tx;
  });

  // ---- Cost train rollups (Req 3 / dashboard) ----
  app.get("/api/costs/rollup", async (req, reply) => {
    const { by = "agent" } = req.query as { by?: string };
    if (!["agent", "subject", "plan", "status"].includes(by)) {
      return reply.code(400).send({ error: "by must be one of agent|subject|plan|status" });
    }
    return ledger.costRollup(by as "agent" | "subject" | "plan" | "status");
  });

  // ---- Evidence events (Learner Record Store) ----
  app.post("/api/evidence", async (req, reply) => {
    const body = req.body as EvidenceEvent;
    if (!validateEv(body)) {
      return reply.code(422).send({ error: "schema validation failed", details: validateEv.errors });
    }
    await evidence.append(body);
    return reply.code(201).send({ event_id: body.event_id });
  });

  app.get("/api/evidence", async (req) => {
    const { learner } = req.query as { learner?: string };
    return learner ? evidence.forLearner(learner) : evidence.all();
  });

  // ---- Measurement: learners + per-learner mastery/composite (the credential) ----
  // asOf is fixed per request so a score is reproducible; defaults to now, but a
  // caller can pass ?asOf=ISO to recompute a historical snapshot deterministically.
  const asOfFrom = (q: Record<string, string | undefined>) =>
    q.asOf ? new Date(q.asOf).getTime() : Date.now();

  app.get("/api/learners", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const asOf = asOfFrom(q);
    const ids = await evidence.learnerIds();
    const all = await evidence.all();
    const rows = await Promise.all(ids.map(async (id) => {
      const cleared = await operatorActions.clearedIntegrityFor(id);
      const m = measurement.compute(id, all, { asOf, clearedIntegrity: cleared });
      return {
        learner_id: id,
        composite: m.composite.final,
        rank_band: m.composite.rank_band,
        rank_band_id: m.composite.rank_band_id,
        integrity_review: m.integrity.filter((f) => f.review).length,
        evidence_count: m.evidence_count,
        competencies_at_threshold: m.mastery.filter((c) => c.at_threshold).length,
        competencies_total: m.mastery.length,
      };
    }));
    return rows.sort((a, b) => b.composite - a.composite); // leaderboard order
  });

  app.get("/api/learners/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const evs = await evidence.forLearner(id);
    if (!evs.length) return reply.code(404).send({ error: "no evidence for learner" });
    const cleared = await operatorActions.clearedIntegrityFor(id);
    const m = measurement.compute(id, evs, { asOf: asOfFrom(q), clearedIntegrity: cleared });
    const decisions = [...cleared].map((c) => ({ competency_id: c, decision: "cleared" }));
    return { ...m, evidence: evs, integrity_decisions: decisions };
  });

  // ---- Operator actions (task #5) — make the Cockpit act, not just read ----
  app.post("/api/learners/:id/integrity/:competency", async (req, reply) => {
    const { id, competency } = req.params as { id: string; competency: string };
    const { decision, operator = "operator", note } = (req.body ?? {}) as { decision?: string; operator?: string; note?: string };
    if (decision !== "cleared" && decision !== "upheld") {
      return reply.code(400).send({ error: "decision must be 'cleared' or 'upheld'" });
    }
    const evs = await evidence.forLearner(id);
    if (!evs.some((e) => e.competency_id === competency)) {
      return reply.code(404).send({ error: "no evidence for that learner/competency" });
    }
    const action = await operatorActions.record({
      type: "integrity", target_id: `${id}:${competency}`, learner_id: id, competency_id: competency, decision, operator, note,
    });
    return reply.code(201).send(action);
  });

  app.post("/api/transactions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision, operator = "operator", note } = (req.body ?? {}) as { decision?: string; operator?: string; note?: string };
    if (decision !== "acknowledged" && decision !== "overridden") {
      return reply.code(400).send({ error: "decision must be 'acknowledged' or 'overridden'" });
    }
    const tx = await ledger.get(id);
    if (!tx) return reply.code(404).send({ error: "transaction not found" });
    const action = await operatorActions.record({ type: "escalation", target_id: id, learner_id: tx.subject_id, decision, operator, note });
    return reply.code(201).send(action);
  });

  app.get("/api/actions", async () => operatorActions.all());

  // ================= Agent Studio =================

  // Agents list with per-agent config + attached resources + ledger stats.
  app.get("/api/agents", async () => {
    const txs = await ledger.list({ limit: 500 });
    return Promise.all(Object.values(agents).map(async (a) => {
      const mine = txs.filter((t) => t.agent.name === a.name);
      const n = mine.length || 1;
      return {
        name: a.name, version: a.version, tier: a.tier,
        guardrail_policy: a.guardrailPolicy, critic_policy: a.criticPolicy,
        transactions: mine.length,
        total_usd: round6(mine.reduce((s, t) => s + t.cost.total_usd, 0)),
        avg_ms: Math.round(mine.reduce((s, t) => s + (t.cost.total_ms ?? 0), 0) / n),
        completed: mine.filter((t) => t.status === "completed").length,
        revised: mine.filter((t) => t.status === "revised").length,
        escalated: mine.filter((t) => t.status === "escalated").length,
        blocked: mine.filter((t) => t.status === "blocked").length,
        success_rate: mine.length ? +(mine.filter((t) => t.status === "completed" || t.status === "revised").length / mine.length).toFixed(3) : null,
        attached_kbs: await resources.agentKbIds(a.name),
        attached_guardrail_sets: await resources.agentGuardrailSetIds(a.name),
      };
    }));
  });

  app.get("/api/agents/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const a = agents[name];
    if (!a) return reply.code(404).send({ error: "unknown agent" });
    const recent = await ledger.list({ agent: name, limit: 25 });
    const override = await resources.latestPrompt(name);
    return {
      name: a.name, version: a.version, tier: a.tier,
      guardrail_policy: a.guardrailPolicy, critic_policy: a.criticPolicy,
      system_prompt: override?.prompt ?? a.systemPrompt,   // effective prompt
      prompt_default: a.systemPrompt,                       // the file seed
      prompt_overridden: !!override,
      prompt_version: override?.version ?? null,
      attached_kbs: await resources.agentKbIds(name),
      attached_guardrail_sets: await resources.agentGuardrailSetIds(name),
      recent_transactions: recent.map((t) => ({ transaction_id: t.transaction_id, timestamp: t.timestamp, subject_id: t.subject_id, status: t.status, verdict: t.critique.verdict, total_usd: t.cost.total_usd })),
    };
  });

  // Edit the prompt (versioned override wins over the file default at run time).
  app.put("/api/agents/:name/prompt", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { prompt, author = "operator" } = (req.body ?? {}) as { prompt?: string; author?: string };
    if (!prompt || !prompt.trim()) return reply.code(400).send({ error: "prompt is required" });
    return reply.code(201).send(await resources.savePrompt(name, prompt, author));
  });
  app.get("/api/agents/:name/prompt/versions", async (req) => resources.promptVersions((req.params as { name: string }).name));
  // Reset to the built-in file prompt (clears all overrides).
  app.delete("/api/agents/:name/prompt", async (req) => { await resources.clearPrompts((req.params as { name: string }).name); return { ok: true }; });

  // Playground: run an agent as if messaging on a chosen learner's behalf. Never sends WhatsApp.
  app.post("/api/agents/:name/test", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { subject = "test-user", text } = (req.body ?? {}) as { subject?: string; text?: string };
    if (!text) return reply.code(400).send({ error: "text is required" });
    const { tx, retrieved } = await dailyLoop.runAgent(name, subject, text, { baseSources: ["studio-playground"] });
    return { transaction: tx, retrieved };
  });

  // ---- RAG: knowledge bases (standalone, attachable) ----
  app.get("/api/rag/kbs", async () => {
    const kbs = await resources.listKBs();
    return Promise.all(kbs.map(async (kb) => ({
      ...kb, doc_count: (await resources.listDocs(kb.kb_id)).length,
      attached_agents: await resources.agentsForResource("kb", kb.kb_id),
    })));
  });
  app.post("/api/rag/kbs", async (req, reply) => {
    const { name, description } = (req.body ?? {}) as { name?: string; description?: string };
    if (!name) return reply.code(400).send({ error: "name is required" });
    return reply.code(201).send(await resources.createKB(name, description));
  });
  app.get("/api/rag/kbs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const kb = await resources.getKB(id);
    if (!kb) return reply.code(404).send({ error: "not found" });
    return { ...kb, documents: await resources.listDocs(id), attached_agents: await resources.agentsForResource("kb", id) };
  });
  app.delete("/api/rag/kbs/:id", async (req) => { await resources.deleteKB((req.params as { id: string }).id); return { ok: true }; });
  app.post("/api/rag/kbs/:id/docs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, content } = (req.body ?? {}) as { title?: string; content?: string };
    if (!title || !content) return reply.code(400).send({ error: "title and content are required" });
    return reply.code(201).send(await resources.addDoc(id, title, content));
  });
  app.delete("/api/rag/docs/:docId", async (req) => { await resources.deleteDoc((req.params as { docId: string }).docId); return { ok: true }; });
  app.post("/api/rag/retrieve", async (req) => {
    const { agent, query } = (req.body ?? {}) as { agent?: string; query?: string };
    return resources.retrieve(agent ?? "", query ?? "", 5);
  });

  // ---- Guardrails: plain-English rules (LLM-enforced) + sets, both attachable ----
  app.get("/api/guardrails/catalog", async () => {
    const rules = await ruleCatalog();
    return { rules, all_rule_ids: rules.map((r) => r.rule_id) };
  });
  // Create a NEW rule by typing a sentence — no code (answers "how do I create new").
  app.post("/api/guardrails/rules", async (req, reply) => {
    const { name, description, severity = "block" } = (req.body ?? {}) as { name?: string; description?: string; severity?: string };
    if (!name || !description) return reply.code(400).send({ error: "name and description (the plain-English rule) are required" });
    if (!["block", "escalate", "warn"].includes(severity)) return reply.code(400).send({ error: "severity must be block|escalate|warn" });
    return reply.code(201).send(await resources.createRule(name, description, severity as "block" | "escalate" | "warn"));
  });
  app.delete("/api/guardrails/rules/:id", async (req) => { await resources.deleteRule((req.params as { id: string }).id); return { ok: true }; });

  app.get("/api/guardrails/sets", async () => {
    const sets = await resources.listGuardrailSets();
    return Promise.all(sets.map(async (s) => ({ ...s, attached_agents: await resources.agentsForResource("guardrail", s.gr_id) })));
  });
  app.post("/api/guardrails/sets", async (req, reply) => {
    const { name, rule_ids, description } = (req.body ?? {}) as { name?: string; rule_ids?: string[]; description?: string };
    if (!name || !Array.isArray(rule_ids) || !rule_ids.length) return reply.code(400).send({ error: "name and non-empty rule_ids are required" });
    const known = new Set((await ruleCatalog()).map((r) => r.rule_id));
    const unknown = rule_ids.filter((r) => !known.has(r));
    if (unknown.length) return reply.code(400).send({ error: `unknown rule ids: ${unknown.join(", ")}` });
    return reply.code(201).send(await resources.createGuardrailSet(name, rule_ids, description));
  });
  app.delete("/api/guardrails/sets/:id", async (req) => { await resources.deleteGuardrailSet((req.params as { id: string }).id); return { ok: true }; });

  // ---- Attach / detach a resource to an agent (many-to-many) ----
  app.post("/api/agents/:name/resources", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { type, resource_id, action = "attach" } = (req.body ?? {}) as { type?: "kb" | "guardrail"; resource_id?: string; action?: "attach" | "detach" };
    if (type !== "kb" && type !== "guardrail") return reply.code(400).send({ error: "type must be 'kb' or 'guardrail'" });
    if (!resource_id) return reply.code(400).send({ error: "resource_id is required" });
    if (action === "detach") await resources.detach(name, type, resource_id);
    else await resources.attach(name, type, resource_id);
    return { ok: true, action, agent: name, type, resource_id };
  });

  // ---- Public landing page (learner signup) + Cockpit SPA ----
  if (fs.existsSync(path.join(settings.dashboardDir, "index.html"))) {
    await app.register(fastifyStatic, { root: settings.dashboardDir, wildcard: false });
    // Landing page is the public front door: /join (and /start alias).
    const landing = (_req: unknown, reply: any) => reply.type("text/html").sendFile("join.html");
    app.get("/join", landing);
    app.get("/start", landing);
    // SPA fallback: unmatched GET routes render the operator console.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/webhooks")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info(`dashboard: serving ${settings.dashboardDir}`);
  }

  // ---- 11za inbound webhook (ADR-005) → daily loop → executor ----
  app.post("/webhooks/11za", async (req, reply) => {
    // FAIL CLOSED. This endpoint drives real LLM spend, so an unauthenticated
    // caller is an unbounded cost (and data) exposure. Refuse to serve it in
    // production unless a secret is actually configured.
    if (!settings.wa.webhookSecret) {
      if (settings.env === "production") {
        req.log.error("11za webhook called but WA_WEBHOOK_SECRET is unset — refusing (fail closed)");
        return reply.code(503).send({ error: "webhook not configured" });
      }
      req.log.warn("WA_WEBHOOK_SECRET unset — webhook is UNAUTHENTICATED (allowed in non-production only)");
    } else if (!timingSafeEqualStr((req.headers["x-webhook-secret"] ?? "") as string, settings.wa.webhookSecret)) {
      return reply.code(401).send({ error: "bad webhook secret" });
    }
    // Accept the common shapes: {from,text} | {phone,message} | {sender,body}. Confirm exact 11za payload later.
    const b = (req.body ?? {}) as Record<string, string>;
    const from = b.from ?? b.phone ?? b.sender ?? "";
    const text = b.text ?? b.message ?? b.body ?? "";
    if (!from || !text) {
      req.log.warn({ payload: req.body }, "11za inbound: unrecognized payload shape");
      return { received: true, routed: false };
    }
    // Route through the LMS journey walker (serve lesson / grade / advance / advise).
    dailyLoop.touch(from);
    const result = await learning.onMessage(from, text);
    if (result.reply) {
      const sent = await wa.sendText(from, result.reply); // learner just messaged -> window open
      if (!sent.ok && !sent.stub) req.log.warn(`wa send failed for ${from}: ${sent.detail}`);
    }
    req.log.info({ from, served: result.served_lesson_id, graded: result.graded, done: result.done }, "11za inbound walked");
    return { received: true, routed: true, served_lesson_id: result.served_lesson_id, graded: result.graded, done: result.done };
  });

  // ---- Dev: simulate an inbound learner message (no 11za needed) ----
  // Gated by its own explicit flag. It must never become reachable as a side
  // effect of some unrelated setting — it drives real LLM spend with no auth.
  if (settings.enableDevRoutes) {
    app.post("/api/dev/simulate-inbound", async (req) => {
      const { learner = "priya-sharma", text = "START" } = (req.body ?? {}) as { learner?: string; text?: string };
      return learning.onMessage(learner, text);
    });
    app.log.warn("dev routes ENABLED (/api/dev/*) — unauthenticated; do not enable in production");
  }

  await app.listen({ port: settings.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

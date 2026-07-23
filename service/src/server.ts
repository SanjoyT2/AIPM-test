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
import { DailyLoop } from "./daily-loop.js";
import { EvidenceStore } from "./evidence-store.js";
import { Executor } from "./executor.js";
import { LlmGateway } from "./gateway.js";
import { Ledger } from "./ledger.js";
import { MeasurementEngine } from "./measurement.js";
import { OperatorActionStore } from "./operator-actions.js";
import { settings } from "./settings.js";
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
  const dailyLoop = new DailyLoop(executor, agents, frameworks, wa);
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

  // ---- Cockpit dashboard (built SPA, when present) ----
  if (fs.existsSync(path.join(settings.dashboardDir, "index.html"))) {
    await app.register(fastifyStatic, { root: settings.dashboardDir, wildcard: false });
    // SPA fallback: unmatched GET routes render the app (client-side router takes over).
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
    const result = await dailyLoop.handleInbound(from, text);
    req.log.info({ from, ...result }, "11za inbound routed through executor");
    // v0 echoes the reply in the response; the 11za outbound client will send it in-thread.
    return { received: true, routed: true, ...result };
  });

  // ---- Dev: simulate an inbound learner message (no 11za needed) ----
  // Gated by its own explicit flag. It must never become reachable as a side
  // effect of some unrelated setting — it drives real LLM spend with no auth.
  if (settings.enableDevRoutes) {
    app.post("/api/dev/simulate-inbound", async (req) => {
      const { learner = "priya-sharma", text = "START" } = (req.body ?? {}) as { learner?: string; text?: string };
      return dailyLoop.handleInbound(learner, text);
    });
    app.log.warn("dev routes ENABLED (/api/dev/*) — unauthenticated; do not enable in production");
  }

  await app.listen({ port: settings.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * D2D Phase-1 service — Fastify API.
 *
 * Boot order is deliberate: frameworks load + validate FIRST (fail-loud, ADR-006),
 * then the ledger, then routes. Every transaction posted to the ledger is validated
 * against the canonical JSON Schema — the same file that documents it.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { loadFrameworks } from "./config-loader.js";
import { LlmGateway } from "./gateway.js";
import { Ledger } from "./ledger.js";
import { settings } from "./settings.js";
import type { AgentTransaction } from "./types.js";
import { compileSchema } from "./validation.js";

async function main() {
  // 1. Frameworks (throws on invalid config — refuse to boot)
  const frameworks = loadFrameworks();

  // 2. Ledger + gateway
  const ledger = new Ledger();
  await ledger.init();
  const gateway = new LlmGateway(frameworks.costModel);

  // 3. Canonical schema validator for inbound transactions
  const validateTx = compileSchema(
    JSON.parse(fs.readFileSync(path.join(settings.schemaDir, "agent-transaction.schema.json"), "utf8")),
  );

  const app = Fastify({ logger: true });

  // ---- Health & meta ----
  app.get("/health", async () => ({
    status: "ok",
    env: settings.env,
    storage: ledger.storage,
    gateway: gateway.stubMode ? "stub" : "live",
    framework_versions: frameworks.versions,
  }));

  app.get("/config/frameworks", async () => frameworks.versions);
  app.get("/config/frameworks/:name", async (req, reply) => {
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
  app.post("/transactions", async (req, reply) => {
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

  app.get("/transactions", async (req) => {
    const q = req.query as { agent?: string; subject?: string; status?: string; limit?: string };
    return ledger.list({ agent: q.agent, subject: q.subject, status: q.status, limit: q.limit ? Number(q.limit) : undefined });
  });

  app.get("/transactions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tx = await ledger.get(id);
    if (!tx) return reply.code(404).send({ error: "not found" });
    return tx;
  });

  // ---- Cost train rollups (Req 3 / dashboard) ----
  app.get("/costs/rollup", async (req, reply) => {
    const { by = "agent" } = req.query as { by?: string };
    if (!["agent", "subject", "plan", "status"].includes(by)) {
      return reply.code(400).send({ error: "by must be one of agent|subject|plan|status" });
    }
    return ledger.costRollup(by as "agent" | "subject" | "plan" | "status");
  });

  // ---- 11za inbound webhook (ADR-005) ----
  app.post("/webhooks/11za", async (req, reply) => {
    const secret = (req.headers["x-webhook-secret"] ?? "") as string;
    if (settings.wa.webhookSecret && secret !== settings.wa.webhookSecret) {
      return reply.code(401).send({ error: "bad webhook secret" });
    }
    // Inbound learner message: rolls the 24h window forward and (later) routes
    // to the daily-loop workflow. For now: acknowledge + log.
    req.log.info({ payload: req.body }, "11za inbound");
    return { received: true };
  });

  await app.listen({ port: settings.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

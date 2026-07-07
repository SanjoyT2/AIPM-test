/** Environment configuration — 12-factor, everything overridable via env vars (Docker/Render friendly). */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx) this file lives at service/src; in the Docker image at /app/service/dist.
// Both are two levels below the repo root, where d2d/ lives alongside service/.
const repoRoot = path.resolve(here, "..", "..");

export const settings = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8000), // Render injects PORT

  /** Postgres. docker-compose provides it locally; Render provides DATABASE_URL. */
  databaseUrl: process.env.DATABASE_URL ?? "",

  /** LLM gateway. Empty key => stub mode (no live calls; deterministic canned output). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  models: {
    haiku: process.env.MODEL_HAIKU ?? "claude-haiku-4-5-20251001",
    sonnet: process.env.MODEL_SONNET ?? "claude-sonnet-5",
  },

  /** WhatsApp via 11za. */
  wa: {
    apiBase: process.env.WA_API_BASE ?? "",
    apiToken: process.env.WA_API_TOKEN ?? "",
    webhookSecret: process.env.WA_WEBHOOK_SECRET ?? "",
  },

  /** The editable frameworks (YAML) + their JSON Schemas. */
  configDir: process.env.D2D_CONFIG_DIR ?? path.join(repoRoot, "d2d", "config"),
  schemaDir: process.env.D2D_SCHEMA_DIR ?? path.join(repoRoot, "d2d", "schema"),
} as const;

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

  /** LLM gateway (OpenAI). Empty key => stub mode (no live calls; deterministic canned output). */
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  /**
   * Provider-neutral tiers. Defaults are conservative, widely-available models;
   * override via MODEL_FAST / MODEL_DEEP to move to a newer generation without a
   * code change (update cost-model.yaml prices to match).
   */
  models: {
    fast: process.env.MODEL_FAST ?? "gpt-4o-mini",
    deep: process.env.MODEL_DEEP ?? "gpt-4o",
  },

  /** WhatsApp via 11za. */
  wa: {
    apiBase: process.env.WA_API_BASE ?? "https://api.11za.in",
    apiToken: process.env.WA_API_TOKEN ?? "",          // 11za authToken (secret) — empty => outbound stub mode
    originWebsite: process.env.WA_ORIGIN_WEBSITE ?? "", // 11za "originWebsite" param
    webhookSecret: process.env.WA_WEBHOOK_SECRET ?? "",
  },

  /** The editable frameworks (YAML) + their JSON Schemas. */
  configDir: process.env.D2D_CONFIG_DIR ?? path.join(repoRoot, "d2d", "config"),
  schemaDir: process.env.D2D_SCHEMA_DIR ?? path.join(repoRoot, "d2d", "schema"),

  /**
   * Unauthenticated /api/dev/* simulation routes. Opt-in only: defaults to on
   * outside production, and requires ENABLE_DEV_ROUTES=true to ever run in it.
   */
  enableDevRoutes:
    process.env.ENABLE_DEV_ROUTES === "true" ||
    ((process.env.NODE_ENV ?? "development") !== "production" && process.env.ENABLE_DEV_ROUTES !== "false"),

  /** Built dashboard (served statically when present — one container, one service). */
  dashboardDir: process.env.DASHBOARD_DIR ?? path.join(repoRoot, "dashboard", "dist"),
} as const;

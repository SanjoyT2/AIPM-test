/**
 * Agent registry — each agent = an editable prompt (d2d/config/prompts/*.md) plus
 * platform policy bindings (model tier, guardrail policy, critic policy).
 * The executor treats every agent identically; only this spec differs.
 */
import fs from "node:fs";
import path from "node:path";
import { settings } from "./settings.js";
import type { ModelTier } from "./gateway.js";

export interface AgentSpec {
  name: string;
  version: string;
  tier: ModelTier;
  guardrailPolicy: string;
  criticPolicy: string;
  systemPrompt: string;
}

const BINDINGS: Record<string, { tier: ModelTier; guardrailPolicy: string; criticPolicy: string }> = {
  trainer:   { tier: "fast", guardrailPolicy: "task_grading",      criticPolicy: "formative" },
  mentor:    { tier: "fast", guardrailPolicy: "mentor",            criticPolicy: "conversational" },
  motivator: { tier: "fast", guardrailPolicy: "conversational",    criticPolicy: "conversational" },
  examiner:  { tier: "deep", guardrailPolicy: "summative_scoring", criticPolicy: "summative" },
  coach:     { tier: "deep", guardrailPolicy: "conversational",    criticPolicy: "conversational" }, // AI Program Manager
  assessor:  { tier: "deep", guardrailPolicy: "summative_scoring", criticPolicy: "summative" },      // generates personalized assessments
};

export function loadAgents(): Record<string, AgentSpec> {
  const agents: Record<string, AgentSpec> = {};
  for (const [name, b] of Object.entries(BINDINGS)) {
    const file = path.join(settings.configDir, "prompts", `${name}.md`);
    const systemPrompt = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `You are the ${name} agent.`;
    const version = /version:\s*([\d.]+)/.exec(systemPrompt)?.[1] ?? "0.0.0";
    agents[name] = { name, version, systemPrompt, ...b };
  }
  return agents;
}

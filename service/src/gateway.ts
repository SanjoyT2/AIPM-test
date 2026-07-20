/**
 * LLM Gateway — the ONE place all model calls go through (doc 01).
 * Responsibilities: model routing (fast/deep tiers), per-call cost metering
 * from cost-model.yaml, and call records for the transaction ledger (Req 3).
 * Guardrail hooks wrap this at the executor level (doc 07).
 *
 * Provider: OpenAI. Tiers are deliberately provider-NEUTRAL ("fast" / "deep") so
 * swapping vendors or model generations is a settings + cost-model edit, never a
 * code change in agents/critics/rubrics.
 *
 * Stub mode: with no OPENAI_API_KEY the gateway returns deterministic canned
 * output so the whole platform runs locally / in CI without spend.
 */
import OpenAI from "openai";
import { settings } from "./settings.js";
import type { CallRole, LlmCall } from "./types.js";

export type ModelTier = "fast" | "deep";

export interface GatewayRequest {
  tier: ModelTier;
  role: CallRole;               // actor | critic | guardrail — so critique overhead is separable
  system: string;
  user: string;
  maxTokens?: number;
}

export interface GatewayResponse {
  text: string;
  call: LlmCall;                // fully metered — goes straight into transaction.cost.calls[]
  stub: boolean;
}

interface Pricing { input_per_mtok: number; output_per_mtok: number }

export class LlmGateway {
  private client: OpenAI | null;
  private prices: Record<string, Pricing>;

  constructor(costModel: any) {
    this.client = settings.openaiApiKey ? new OpenAI({ apiKey: settings.openaiApiKey }) : null;
    this.prices = costModel.models ?? {};
  }

  get stubMode(): boolean {
    return this.client === null;
  }

  private usd(tier: ModelTier, inTok: number, outTok: number): number {
    const p = this.prices[tier] ?? { input_per_mtok: 0, output_per_mtok: 0 };
    return (inTok * p.input_per_mtok + outTok * p.output_per_mtok) / 1_000_000;
  }

  async complete(req: GatewayRequest): Promise<GatewayResponse> {
    const model = settings.models[req.tier];
    const started = Date.now();

    if (!this.client) {
      // Deterministic stub: echoes intent, meters plausible token counts.
      const text = `[stub:${req.tier}] ${req.user.slice(0, 120)}`;
      const inTok = Math.ceil((req.system.length + req.user.length) / 4);
      const outTok = Math.ceil(text.length / 4);
      return {
        text,
        stub: true,
        call: {
          role: req.role, model: `${model} (stub)`,
          input_tokens: inTok, output_tokens: outTok,
          usd: this.usd(req.tier, inTok, outTok), ms: Date.now() - started,
        },
      };
    }

    const res = await this.client.chat.completions.create({
      model,
      max_completion_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const inTok = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    return {
      text,
      stub: false,
      call: {
        role: req.role, model,
        input_tokens: inTok, output_tokens: outTok,
        usd: this.usd(req.tier, inTok, outTok), ms: Date.now() - started,
      },
    };
  }
}

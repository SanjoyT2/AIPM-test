/**
 * Onboarding agent — owns the signup funnel's WhatsApp delivery end to end.
 *
 * Meta only approves message templates through the 11za dashboard (there is no
 * create-template API), so the agent cannot author the template itself. What it does
 * instead is everything around that one manual step:
 *
 *   - discovers the approved OTP template from the live 11za account at runtime
 *     (no env var or redeploy needed once the template is approved),
 *   - learns the template's {{n}} variable count and fills the slots correctly,
 *   - delivers OTPs via the template, falling back to session text only when the
 *     learner's 24h window is genuinely open,
 *   - reports exactly what an operator must create in the 11za dashboard when no
 *     usable template exists, instead of letting signups fail silently.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { settings } from "./settings.js";
import type { LlmGateway } from "./gateway.js";
import type { LearnerKyc, Signups } from "./signups.js";
import type { WaClient, WaSendResult } from "./wa-client.js";

/** What the operator should create when discovery comes up empty. */
export const RECOMMENDED_TEMPLATE = {
  name: "signup_otp",
  category: "AUTHENTICATION",
  language: "en",
  body: "{{1}} is your Degree2Destiny verification code. It expires in 10 minutes.",
  note: "Create and submit this in the 11za dashboard (Templates → Add). Meta approval is usually quick for AUTHENTICATION templates. The agent will pick it up automatically once approved.",
};

const KEYWORDS = /otp|verif|code|auth|login|signup|registration/i;
const APPROVED = /approved|active|enabled/i;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface ResolvedTemplate {
  name: string;
  language: string;
  varCount: number;
  status?: string;
  matchedBy: "configured" | "discovered";
}

export interface OnboardingStatus {
  mode: "stub" | "live";
  otp_delivery: "stub" | "ready" | "awaiting_approval" | "no_template" | "unchecked";
  configured_template: string | null;
  resolved: ResolvedTemplate | null;
  last_checked: string | null;
  last_error: string | null;
  /** All template names seen on the account — helps the operator pick/pin one. */
  account_templates: { name: string; status?: string; language?: string }[];
  action_needed: typeof RECOMMENDED_TEMPLATE | null;
  /**
   * Inbound-webhook wiring on the 11za account. "ok" = points at us; "registered" =
   * was missing and the agent just fixed it; "foreign" = someone else's URL (the
   * agent will NOT overwrite it — that's an operator decision); "unknown" = check failed.
   */
  inbound_webhook: "stub" | "ok" | "registered" | "foreign" | "missing" | "unknown";
  inbound_webhook_foreign_url?: string;
}

export class Onboarding {
  private resolved: ResolvedTemplate | null = null;
  private catalog: { name: string; status?: string; language?: string }[] = [];
  private lastChecked = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private store: Signups | null = null;

  constructor(private wa: WaClient, private gateway?: LlmGateway) {}

  /** Late-bound: Signups needs Onboarding for OTPs, Onboarding needs Signups for KYC. */
  bindStore(store: Signups): void {
    this.store = store;
  }

  /**
   * Query 11za for the template catalog and pick the OTP template. A configured
   * WA_OTP_TEMPLATE name is honored first (pinning survives odd auto-picks); with no
   * pin, prefer an approved template whose name suggests OTP/verification.
   */
  async refresh(): Promise<void> {
    // Single-flight: concurrent signups shouldn't stampede the 11za API.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private webhookState: OnboardingStatus["inbound_webhook"] = "unknown";
  private webhookForeignUrl?: string;
  /** signup_otp has been submitted to Meta (by us or the operator) and is in review. */
  private otpSubmitted = false;

  /**
   * The funnel is dead without the account's inbound webhook pointing at us — verify
   * it every refresh and re-register when it has gone missing (deploys don't touch
   * it, but account-side changes can wipe it). A URL belonging to someone else is
   * reported, never overwritten: this may be a shared 11za account.
   */
  private async ensureInboundWebhook(): Promise<void> {
    if (!settings.wa.webhookSecret) { this.webhookState = "unknown"; return; }
    const expected = `${settings.publicBaseUrl}/webhooks/11za?secret=${settings.wa.webhookSecret}`;
    const current = await this.wa.getInboundWebhook();
    this.webhookForeignUrl = undefined;
    if (current === expected) { this.webhookState = "ok"; return; }
    if (current) {
      this.webhookState = "foreign";
      this.webhookForeignUrl = current;
      console.warn(`[onboarding] 11za inbound webhook points elsewhere — NOT overwriting. Operator decision needed.`);
      return;
    }
    const r = await this.wa.addInboundWebhook(expected);
    this.webhookState = r.ok ? "registered" : "missing";
    console[r.ok ? "info" : "warn"](`[onboarding] inbound webhook was unset — registration ${r.ok ? "succeeded" : `failed: ${r.detail}`}`);
  }

  private async doRefresh(): Promise<void> {
    this.lastChecked = Date.now();
    if (this.wa.stubMode) return;

    await this.ensureInboundWebhook().catch(() => { this.webhookState = "unknown"; });

    const [all, counts] = await Promise.all([
      this.wa.listTemplates(),
      this.wa.listTemplateVarCounts(),
    ]);
    if (!all && !counts) {
      this.lastError = "11za template listing failed — check WA_API_TOKEN / network.";
      return;
    }
    this.lastError = null;

    // Observed live record shape (2026-07): {name, localizations: [{status, language,
    // components: [{type:"BODY", text}]}], dynamicValues: [{language, bodyDynamic}]}.
    // Older/flat field names are kept as fallbacks.
    const norm = (rec: any) => {
      const loc = rec.localizations?.[0] ?? {};
      const dyn = rec.dynamicValues?.[0] ?? {};
      const bodyComp = (loc.components ?? []).find((c: any) => c?.type === "BODY");
      return {
        name: String(rec.templateName ?? rec.name ?? rec.template_name ?? "").trim(),
        status: rec.status ?? loc.status ?? rec.templateStatus ?? rec.approvalStatus ?? undefined,
        language: rec.language ?? loc.language ?? rec.lang ?? undefined,
        varCount: Number(dyn.bodyDynamic ?? loc.bodyDynamic ?? rec.dynamicValueCount ?? rec.variableCount ?? rec.varCount ?? NaN),
        body: String(bodyComp?.text ?? rec.body ?? rec.templateBody ?? rec.content ?? ""),
      };
    };
    const records = [...(all ?? []), ...(counts ?? [])].map(norm).filter((r) => r.name);

    // Merge by name: getTemplatesAll carries status/body, getTemp carries the var count.
    const byName = new Map<string, ReturnType<typeof norm>>();
    for (const r of records) {
      const prev = byName.get(r.name);
      byName.set(r.name, {
        ...prev, ...r,
        status: r.status ?? prev?.status,
        language: r.language ?? prev?.language,
        varCount: Number.isFinite(r.varCount) ? r.varCount : (prev?.varCount ?? NaN),
        body: r.body || prev?.body || "",
      });
    }
    this.catalog = [...byName.values()].map(({ name, status, language }) => ({ name, status, language }));

    const configured = settings.wa.otpTemplate;
    const pick =
      (configured && byName.get(configured)) ||
      [...byName.values()].find((t) => KEYWORDS.test(t.name) && (!t.status || APPROVED.test(String(t.status)))) ||
      [...byName.values()].find((t) => KEYWORDS.test(`${t.name} ${t.body}`) && (!t.status || APPROVED.test(String(t.status))));

    this.resolved = pick
      ? {
          name: pick.name,
          language: pick.language ?? settings.wa.otpTemplateLang,
          varCount: Number.isFinite(pick.varCount) && pick.varCount > 0 ? pick.varCount : 1,
          status: pick.status,
          matchedBy: configured && pick.name === configured ? "configured" : "discovered",
        }
      : null;

    if (this.resolved) {
      console.info(`[onboarding] OTP template ${this.resolved.matchedBy}: "${this.resolved.name}" (${this.resolved.language}, ${this.resolved.varCount} var slot${this.resolved.varCount === 1 ? "" : "s"})`);
      return;
    }

    /*
     * No approved OTP template — author it ourselves via 11za's (undocumented)
     * create API and submit for Meta approval. Pending templates are invisible to
     * the list endpoints, so "name is already exist" is the normal signal that it's
     * submitted and in review; once approved, discovery above picks it up.
     */
    if (!this.otpSubmitted) {
      const r = await this.wa.createTemplate({
        name: RECOMMENDED_TEMPLATE.name,
        category: RECOMMENDED_TEMPLATE.category,
        language: RECOMMENDED_TEMPLATE.language,
        bodyText: RECOMMENDED_TEMPLATE.body,
        exampleTexts: ["482913"],
      });
      this.otpSubmitted = r.ok || /already exist/i.test(r.detail ?? "");
      if (r.ok) {
        console.info(`[onboarding] submitted "${RECOMMENDED_TEMPLATE.name}" to Meta for approval — will auto-activate once approved.`);
      } else if (this.otpSubmitted) {
        console.info(`[onboarding] "${RECOMMENDED_TEMPLATE.name}" already submitted — awaiting Meta approval.`);
      } else {
        console.warn(`[onboarding] template self-creation failed: ${r.detail}`);
      }
    }
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastChecked > CACHE_TTL_MS || (!this.resolved && Date.now() - this.lastChecked > 30_000)) {
      await this.refresh();
    }
  }

  /**
   * Deliver a signup OTP. Template first (the only reliable first-contact channel);
   * session text only as a fallback when 11za says the 24h window is actually open.
   */
  async sendOtp(phone: string, otp: string, learnerName?: string): Promise<WaSendResult & { via?: string }> {
    if (this.wa.stubMode) {
      return { ...(await this.wa.sendText(phone, `Your verification code is ${otp}`)), via: "stub" };
    }
    await this.ensureFresh();

    if (this.resolved) {
      const t = this.resolved;
      // Slot filling: a 1-var template gets the code; a 2-var template is assumed
      // "name, code". Anything wider gets the code in every remaining slot — Meta
      // rejects empty parameters, and over-filling only looks odd, never fails.
      const data = t.varCount === 2
        ? [learnerName?.trim() || "there", otp]
        : Array(t.varCount).fill(otp);
      const res = await this.wa.sendTemplate(phone, t.name, { language: t.language, name: learnerName ?? "", data });
      if (res.ok) return { ...res, via: `template:${t.name}` };
      // A rejected send may mean the template was deleted/paused since we cached it.
      this.resolved = null;
      this.lastChecked = 0;
      console.warn(`[onboarding] template send failed (${res.status}): ${res.detail}`);
    }

    // No template — a session text can still land if the learner has messaged us recently.
    if ((await this.wa.windowOpen(phone)) === true) {
      const res = await this.wa.sendText(phone, `Your Degree2Destiny verification code is ${otp}. It expires in 10 minutes.`);
      if (res.ok) return { ...res, via: "session_text" };
    }

    return {
      ok: false, stub: false, via: "none",
      detail: `No approved OTP template on the 11za account. Create "${RECOMMENDED_TEMPLATE.name}" in the 11za dashboard — the agent picks it up automatically once approved.`,
    };
  }

  /** One safe word for /api/health; the full picture stays operator-gated. */
  healthState(): OnboardingStatus["otp_delivery"] {
    if (this.wa.stubMode) return "stub";
    if (!this.lastChecked) return "unchecked";
    if (this.resolved) return "ready";
    return this.otpSubmitted ? "awaiting_approval" : "no_template";
  }

  /** Ditto for the inbound-webhook wiring. */
  webhookHealthState(): OnboardingStatus["inbound_webhook"] {
    return this.wa.stubMode ? "stub" : this.webhookState;
  }

  async status(): Promise<OnboardingStatus> {
    await this.ensureFresh();
    return {
      mode: this.wa.stubMode ? "stub" : "live",
      otp_delivery: this.healthState(),
      configured_template: settings.wa.otpTemplate || null,
      resolved: this.resolved,
      last_checked: this.lastChecked ? new Date(this.lastChecked).toISOString() : null,
      last_error: this.lastError,
      account_templates: this.catalog,
      // Submitted-and-pending needs patience, not operator action.
      action_needed: this.resolved || this.otpSubmitted ? null : RECOMMENDED_TEMPLATE,
      inbound_webhook: this.wa.stubMode ? "stub" : this.webhookState,
      inbound_webhook_foreign_url: this.webhookForeignUrl,
    };
  }

  /* ------------------------------------------------ template fleet management */

  /**
   * The fleet mechanism: every template in whatsapp-templates.yaml is expected to
   * exist on the 11za account. This reconciles expectation with reality —
   *   approved  = visible in the account catalog (Meta has approved it; usable NOW)
   *   pending   = exists but not listed (Meta still reviewing — 11za hides these)
   *   submitted = was missing; the agent just created and submitted it
   *   failed    = creation rejected (detail says why)
   * Calling it repeatedly is safe: existing names come back "already exist".
   * This is also the "move on" signal: a rung/agent whose template shows approved
   * is deliverable; anything else still waits on Meta.
   */
  async fleetStatus(): Promise<{ name: string; category: string; state: "approved" | "pending" | "submitted" | "failed" | "stub"; detail?: string }[]> {
    const expected = loadExpectedTemplates();
    if (this.wa.stubMode) return expected.map((t) => ({ name: t.name, category: t.category, state: "stub" as const }));

    await this.refresh(); // fresh catalog: approved templates are the visible ones
    const approved = new Set(
      this.catalog.filter((t) => !t.status || /approved|active|enabled/i.test(String(t.status))).map((t) => t.name),
    );

    const out: { name: string; category: string; state: "approved" | "pending" | "submitted" | "failed"; detail?: string }[] = [];
    for (const t of expected) {
      if (approved.has(t.name)) { out.push({ name: t.name, category: t.category, state: "approved" }); continue; }
      const r = await this.wa.createTemplate({
        name: t.name, category: t.category, language: t.language, bodyText: t.body, exampleTexts: t.examples,
      });
      if (r.ok) out.push({ name: t.name, category: t.category, state: "submitted" });
      else if (/already exist/i.test(r.detail ?? "")) out.push({ name: t.name, category: t.category, state: "pending" });
      else out.push({ name: t.name, category: t.category, state: "failed", detail: r.detail });
    }
    return out;
  }

  /* ------------------------------------------------- document intake (KYC + CV) */

  /**
   * A learner sent a document on WhatsApp (CV or Aadhaar card). Download it, extract
   * the fields with the vision model, verify, store — and answer in-thread (they just
   * messaged us, so the 24h window is definitionally open).
   *
   * PRIVACY RULES (non-negotiable):
   *  - the document is processed entirely in memory and never written to disk,
   *  - the model is instructed to return the Aadhaar number's LAST 4 DIGITS ONLY,
   *    and the stored record carries nothing more,
   *  - nothing from the document is ever logged.
   */
  async processInboundMedia(input: {
    learnerId: string; mediaUrl: string; filename?: string; caption?: string;
  }): Promise<{ reply: string; kind?: string }> {
    const learner = await this.store?.getByLearnerId(input.learnerId);
    if (!learner) {
      return { reply: "Welcome! Please sign up first at d2d.college2career.app — then send your documents here." };
    }
    if (!this.gateway || this.gateway.stubMode) {
      return { reply: "Got your document — our verification desk is offline right now. We'll process it soon.", kind: "deferred" };
    }

    const doc = await fetchMedia(input.mediaUrl, input.filename);
    if (!doc) {
      return { reply: "We couldn't read that file. Please send your CV or Aadhaar as a clear photo (JPG/PNG) or PDF, under 10 MB." };
    }

    const res = await this.gateway.complete({
      tier: "deep", role: "actor",
      system: EXTRACTION_PROMPT,
      user: `Signup name on record: "${learner.name ?? "(not given)"}". Caption sent with the file: "${input.caption ?? ""}". Classify and extract per the rules.`,
      attachments: [doc],
      maxTokens: 700,
    });

    const parsed = parseExtraction(res.text);
    if (!parsed || parsed.kind === "other" || parsed.readable === false) {
      return {
        reply: "Hmm, that doesn't look like a CV or Aadhaar card (or the photo is too blurry). Please send a clear, well-lit photo or the original PDF.",
        kind: "other",
      };
    }

    if (parsed.kind === "aadhaar") {
      const idName = (parsed.aadhaar?.name ?? "").trim();
      const match = namesMatch(learner.name, idName);
      const patch: LearnerKyc = {
        id_status: !idName ? "unreadable" : match === false ? "name_mismatch" : "verified",
        id_name: idName || undefined,
        id_dob: parsed.aadhaar?.dob || undefined,
        aadhaar_last4: (parsed.aadhaar?.last4 ?? "").replace(/\D/g, "").slice(-4) || undefined,
      };
      await this.store!.applyKyc(input.learnerId, patch);
      if (patch.id_status === "verified") {
        return { reply: `Thanks ${idName.split(/\s+/)[0]}! ✅ Your ID is verified.${learner.kyc?.cv_status ? " You're all set — reply START to begin." : " Now send your CV (photo or PDF) and you're all set."}`, kind: "aadhaar" };
      }
      if (patch.id_status === "name_mismatch") {
        return { reply: `Thanks! We read the name "${idName}" on the card, which doesn't match your signup name "${learner.name}". No problem — our team will review it. You can continue meanwhile.`, kind: "aadhaar" };
      }
      return { reply: "We received your ID but couldn't read it clearly. Please send a sharper, well-lit photo of the front of the card.", kind: "aadhaar" };
    }

    // CV
    const patch: LearnerKyc = {
      cv_status: "received",
      cv_summary: {
        education: parsed.cv?.education || undefined,
        skills: parsed.cv?.skills?.slice(0, 15),
        experience: parsed.cv?.experience || undefined,
        highlights: parsed.cv?.highlights?.slice(0, 5),
      },
    };
    await this.store!.applyKyc(input.learnerId, patch);
    return {
      reply: `Great, CV received! 📄${learner.kyc?.id_status === "verified" ? " You're all set — reply START to begin your journey." : " Now send a photo of your Aadhaar card to verify your identity."}`,
      kind: "cv",
    };
  }
}

/**
 * Expected templates = whatsapp-templates.yaml (the editable source of truth).
 * English bodies are used — that's what the fleet was submitted with. {{n}}
 * placeholders get simple example values (Meta requires samples per variable).
 */
function loadExpectedTemplates(): { name: string; category: string; language: string; body: string; examples: string[] }[] {
  try {
    const file = path.join(settings.configDir, "templates", "whatsapp-templates.yaml");
    const doc = parseYaml(fs.readFileSync(file, "utf8"));
    return (doc?.templates ?? [])
      .filter((t: any) => t?.name && (t.body_en || t.body))
      .map((t: any) => {
        const body = String(t.body_en ?? t.body);
        const varCount = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
        const examples = Array.from({ length: Math.max(varCount, 1) }, (_, i) =>
          t.category === "AUTHENTICATION" ? "482913" : i === 0 ? "Priya" : "Level 1",
        );
        return {
          name: String(t.name),
          category: String(t.category ?? doc?.defaults?.category ?? "UTILITY"),
          language: "en",
          body, examples,
        };
      });
  } catch (e) {
    console.warn(`[onboarding] could not load whatsapp-templates.yaml: ${e}`);
    return [];
  }
}

/* ------------------------------------------------------------ intake helpers */

const EXTRACTION_PROMPT = `You are the document-intake step of an education program's onboarding. The attached file is either a CV/resume or an Indian Aadhaar identity card.

Return STRICT JSON only, no prose, no markdown fences:
{"kind":"aadhaar"|"cv"|"other","readable":true|false,
 "aadhaar":{"name":"...","dob":"YYYY-MM-DD or as printed","gender":"...","last4":"1234"},
 "cv":{"education":"one line","skills":["..."],"experience":"one line","highlights":["..."]}}

Include only the object matching "kind". Rules:
- PRIVACY, ABSOLUTE: never output the full Aadhaar number. Output ONLY its last 4 digits in "last4". Do not echo the number anywhere else.
- "readable": false if the image is too blurry/cropped to extract reliably.
- A PAN card, marksheet, driving licence or anything else that is neither CV nor Aadhaar => "kind":"other".`;

/** Download the media in memory with a hard size cap; returns a gateway attachment. */
async function fetchMedia(url: string, filename?: string): Promise<{ kind: "image" | "pdf"; dataUrl: string; filename?: string } | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) return null;

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const name = (filename ?? url.split("?")[0]).toLowerCase();
    const isPdf = ct.includes("pdf") || name.endsWith(".pdf");
    const isImage = ct.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name);
    if (!isPdf && !isImage) return null;

    const mime = isPdf ? "application/pdf" : ct.startsWith("image/") ? ct.split(";")[0] : "image/jpeg";
    return {
      kind: isPdf ? "pdf" : "image",
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      filename: isPdf ? (filename ?? "document.pdf") : undefined,
    };
  } catch {
    return null;
  }
}

function parseExtraction(text: string): any | null {
  // Models occasionally wrap JSON in fences despite instructions — strip and retry.
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* unreadable */ } }
  return null;
}

/** Loose token-overlap name check: "Priya Sharma" vs "PRIYA SHARMA" / "Sharma, Priya". */
function namesMatch(signupName: string | undefined, idName: string): boolean | null {
  if (!signupName?.trim() || !idName.trim()) return null; // nothing to compare — not a mismatch
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
  const a = tok(signupName), b = tok(idName);
  let overlap = 0;
  for (const w of a) if (b.has(w)) overlap++;
  return overlap >= Math.min(2, a.size, b.size); // both tokens of a 2-word name; 1 suffices for single names
}

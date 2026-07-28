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
import { settings } from "./settings.js";
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
  otp_delivery: "stub" | "ready" | "no_template" | "unchecked";
  configured_template: string | null;
  resolved: ResolvedTemplate | null;
  last_checked: string | null;
  last_error: string | null;
  /** All template names seen on the account — helps the operator pick/pin one. */
  account_templates: { name: string; status?: string; language?: string }[];
  action_needed: typeof RECOMMENDED_TEMPLATE | null;
}

export class Onboarding {
  private resolved: ResolvedTemplate | null = null;
  private catalog: { name: string; status?: string; language?: string }[] = [];
  private lastChecked = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private wa: WaClient) {}

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

  private async doRefresh(): Promise<void> {
    this.lastChecked = Date.now();
    if (this.wa.stubMode) return;

    const [all, counts] = await Promise.all([
      this.wa.listTemplates(),
      this.wa.listTemplateVarCounts(),
    ]);
    if (!all && !counts) {
      this.lastError = "11za template listing failed — check WA_API_TOKEN / network.";
      return;
    }
    this.lastError = null;

    const norm = (rec: any) => ({
      name: String(rec.templateName ?? rec.name ?? rec.template_name ?? "").trim(),
      status: rec.status ?? rec.templateStatus ?? rec.approvalStatus ?? undefined,
      language: rec.language ?? rec.lang ?? undefined,
      varCount: Number(rec.dynamicValueCount ?? rec.variableCount ?? rec.varCount ?? rec.count ?? NaN),
      body: String(rec.body ?? rec.templateBody ?? rec.content ?? ""),
    });
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
    } else {
      console.warn(`[onboarding] No OTP-suitable template on the 11za account (${this.catalog.length} templates seen). Create "${RECOMMENDED_TEMPLATE.name}" in the 11za dashboard.`);
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
    return this.resolved ? "ready" : "no_template";
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
      action_needed: this.resolved ? null : RECOMMENDED_TEMPLATE,
    };
  }
}

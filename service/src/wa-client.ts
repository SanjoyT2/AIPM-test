/**
 * 11za WhatsApp outbound client (task #7). Endpoints + payloads per the 11za API
 * collection (documenter.getpostman.com/view/18616888/2s93m1ZPvX):
 *
 *   text     POST {base}/apis/sendMessage/sendMessages
 *            { sendto, authToken, originWebsite, contentType:"text", text }
 *   template POST {base}/apis/template/sendTemplate
 *            { sendto, authToken, originWebsite, language, templateName, name }
 *   window   POST {base}/apis/customer/customerWindowStatus
 *            { authToken, mobileNo }  -> real 24h session-window state
 *
 * Auth is the `authToken` in the body (a secret from env — never logged).
 *
 * STUB MODE: with no WA_API_TOKEN the client logs what it *would* send and returns
 * ok, so the daily loop runs end-to-end locally/CI without messaging anyone or
 * needing credentials. Going live is purely setting the env var in Render.
 */
import { settings } from "./settings.js";

export interface WaSendResult {
  ok: boolean;
  stub: boolean;
  status?: number;
  detail?: string;
}

export class WaClient {
  private base: string;
  private token: string;
  private origin: string;

  constructor() {
    this.base = settings.wa.apiBase.replace(/\/$/, "");
    this.token = settings.wa.apiToken;
    this.origin = settings.wa.originWebsite;
  }

  get stubMode(): boolean {
    return !this.token;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<WaSendResult> {
    if (this.stubMode) {
      // Never print the token; body here has none in stub mode anyway.
      console.info(`[wa:stub] POST ${path} ${JSON.stringify(body)}`);
      return { ok: true, stub: true };
    }
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, authToken: this.token, originWebsite: this.origin }),
      });
      const text = await res.text();
      return { ok: res.ok, stub: false, status: res.status, detail: text.slice(0, 300) };
    } catch (e) {
      return { ok: false, stub: false, detail: (e as Error).message };
    }
  }

  /** Free-form text — only valid inside the 24h window. */
  sendText(sendto: string, text: string): Promise<WaSendResult> {
    return this.post("/apis/sendMessage/sendMessages", { sendto, contentType: "text", text });
  }

  /** Approved template — the only thing allowed outside the window. */
  sendTemplate(sendto: string, templateName: string, opts: { language?: string; name?: string } = {}): Promise<WaSendResult> {
    return this.post("/apis/template/sendTemplate", {
      sendto, templateName, language: opts.language ?? "en", name: opts.name ?? "",
    });
  }

  /**
   * Real 24h window status from 11za. Returns null in stub mode or on error so
   * callers fall back to their own window bookkeeping rather than crash.
   */
  async windowOpen(mobileNo: string): Promise<boolean | null> {
    if (this.stubMode) return null;
    const r = await this.post("/apis/customer/customerWindowStatus", { mobileNo });
    if (!r.ok || !r.detail) return null;
    try {
      const j = JSON.parse(r.detail);
      // 11za returns a status flag; accept the common shapes without over-fitting.
      const v = j.windowStatus ?? j.status ?? j.data?.windowStatus;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return /open|true|active|1/i.test(v);
      return null;
    } catch {
      return null;
    }
  }
}

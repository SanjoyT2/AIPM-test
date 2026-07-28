/**
 * Learner signups + WhatsApp OTP verification (public landing-page funnel).
 * MongoDB implementation.
 *
 * Flow:
 *   POST /api/signup        {name?, phone, email} -> create pending learner, send 6-digit OTP to WhatsApp
 *   POST /api/signup/verify {phone, otp}          -> verify -> learner becomes 'verified'
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Db, Collection } from "mongodb";
import type { Onboarding } from "./onboarding.js";

export interface Learner {
  learner_id: string;
  phone: string;
  email?: string;
  name?: string;
  status: "pending" | "verified";
  created_at: string;
  verified_at?: string;
  otp_hash?: string;
  otp_expires?: number;
  otp_sent_at?: number;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;

/** India-friendly normalization: strip non-digits, keep last 10, prefix 91. */
export function normalizePhone(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || "");
const hashOtp = (phone: string, otp: string) => createHash("sha256").update(`${phone}:${otp}`).digest("hex");

export class Signups {
  private col: Collection | null = null;
  private mem = new Map<string, Learner>(); // keyed by phone

  constructor(private onboarding: Onboarding) {}

  async init(db: Db | null): Promise<void> {
    if (!db) return;
    this.col = db.collection("learners");
    await this.col.createIndex({ phone: 1 }, { unique: true });
    await this.col.createIndex({ status: 1 });
  }

  private async get(phone: string): Promise<Learner | null> {
    if (this.col) {
      const d = await this.col.findOne({ phone });
      if (!d) return null;
      const { _id, ...l } = d as any;
      return l as Learner;
    }
    return this.mem.get(phone) ?? null;
  }

  private async put(l: Learner): Promise<void> {
    if (this.col) {
      await this.col.replaceOne(
        { _id: l.learner_id as any },
        { _id: l.learner_id as any, ...l },
        { upsert: true },
      );
    } else {
      this.mem.set(l.phone, l);
    }
  }

  /** Public view — never leaks OTP fields. */
  private publicView(l: Learner) {
    return { learner_id: l.learner_id, phone: l.phone, email: l.email, name: l.name, status: l.status };
  }

  async startSignup(input: { name?: string; phone: string; email: string }): Promise<{ ok: boolean; error?: string; detail?: string; sent?: string; dev_otp?: string }> {
    const phone = normalizePhone(input.phone);
    if (!phone) return { ok: false, error: "Enter a valid phone number." };
    if (!validEmail(input.email)) return { ok: false, error: "Enter a valid email." };

    const existing = await this.get(phone);
    if (existing?.status === "verified") return { ok: false, error: "This number is already registered." };
    if (existing?.otp_sent_at && Date.now() - existing.otp_sent_at < RESEND_COOLDOWN_MS) {
      return { ok: false, error: "Please wait a moment before requesting another code." };
    }

    const otp = String(randomInt(100000, 1000000));
    const learner: Learner = {
      learner_id: existing?.learner_id ?? `lrn-${phone}`,
      phone, email: input.email, name: input.name?.trim() || undefined,
      status: "pending",
      created_at: existing?.created_at ?? new Date().toISOString(),
      otp_hash: hashOtp(phone, otp), otp_expires: Date.now() + OTP_TTL_MS, otp_sent_at: Date.now(),
    };
    await this.put(learner);

    /*
     * Delivery is the Onboarding agent's job: it resolves the approved 11za template
     * at runtime, fills its variable slots, and only falls back to session text when
     * the learner's 24h window is genuinely open.
     */
    const res = await this.onboarding.sendOtp(phone, otp, learner.name);

    if (res.stub) return { ok: true, sent: "stub", dev_otp: otp };

    /*
     * Previously this returned ok:true regardless, so a rejected send looked like a
     * successful signup and the learner sat waiting for a code that never came.
     * Report the failure instead — but keep the record, so a resend can succeed.
     */
    if (!res.ok) {
      return {
        ok: false,
        error: "We couldn't send your WhatsApp code just now. Please try again in a moment.",
        detail: res.detail,
      };
    }
    return { ok: true, sent: res.via ?? "whatsapp" };
  }

  async verify(rawPhone: string, otp: string): Promise<{ ok: boolean; error?: string; learner?: ReturnType<Signups["publicView"]> }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) return { ok: false, error: "Invalid phone." };
    const l = await this.get(phone);
    if (!l || !l.otp_hash || !l.otp_expires) return { ok: false, error: "Request a code first." };
    if (Date.now() > l.otp_expires) return { ok: false, error: "Code expired — request a new one." };

    const a = Buffer.from(hashOtp(phone, (otp || "").trim()), "hex");
    const b = Buffer.from(l.otp_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "Incorrect code." };

    const verified: Learner = { ...l, status: "verified", verified_at: new Date().toISOString(), otp_hash: undefined, otp_expires: undefined };
    await this.put(verified);
    return { ok: true, learner: this.publicView(verified) };
  }

  /**
   * The operator's roster of real registrants, newest first. OTP material is stripped
   * — a live hash plus its expiry is enough to finish someone else's verification.
   */
  async list(limit = 500): Promise<Omit<Learner, "otp_hash" | "otp_expires" | "otp_sent_at">[]> {
    const strip = (l: Learner) => {
      const { otp_hash: _h, otp_expires: _e, otp_sent_at: _s, ...safe } = l;
      return safe;
    };
    if (this.col) {
      const docs = await this.col.find({}).sort({ created_at: -1 }).limit(limit).toArray();
      return docs.map((d) => {
        const { _id: _drop, ...l } = d as any;
        return strip(l as Learner);
      });
    }
    return [...this.mem.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit)
      .map(strip);
  }

  async count(): Promise<{ verified: number; pending: number }> {
    if (this.col) {
      const [v, p] = await Promise.all([
        this.col.countDocuments({ status: "verified" }),
        this.col.countDocuments({ status: "pending" }),
      ]);
      return { verified: v, pending: p };
    }
    let v = 0, p = 0;
    for (const l of this.mem.values()) l.status === "verified" ? v++ : p++;
    return { verified: v, pending: p };
  }
}

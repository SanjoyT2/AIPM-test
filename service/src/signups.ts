/**
 * Learner signups + WhatsApp OTP verification (public landing-page funnel).
 *
 * Flow:
 *   POST /api/signup        {name?, phone, email} -> create pending learner, send 6-digit OTP to WhatsApp
 *   POST /api/signup/verify {phone, otp}          -> verify -> learner becomes 'verified'
 *
 * The OTP is stored only as a salted SHA-256 hash with a short expiry; the plain
 * code is never persisted. In stub mode (no WhatsApp token) the code is returned
 * in the response so the flow is testable without sending a real message.
 *
 * This is also how a learner is onboarded: a verified signup IS the learner record.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { WaClient } from "./wa-client.js";

const DDL = `
CREATE TABLE IF NOT EXISTS learners (
  learner_id  TEXT PRIMARY KEY,
  doc         JSONB NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  phone       TEXT GENERATED ALWAYS AS (doc->>'phone') STORED,
  status      TEXT GENERATED ALWAYS AS (doc->>'status') STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_phone ON learners (phone);
`;

export interface Learner {
  learner_id: string;
  phone: string;
  email?: string;
  name?: string;
  status: "pending" | "verified";
  created_at: string;
  verified_at?: string;
  // OTP state (never returned to clients)
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
  if (digits.length >= 11 && digits.length <= 15) return digits; // other country codes
  return null;
}
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || "");
const hashOtp = (phone: string, otp: string) => createHash("sha256").update(`${phone}:${otp}`).digest("hex");

export class Signups {
  private pool: pg.Pool | null = null;
  private mem = new Map<string, Learner>();

  constructor(private wa: WaClient) {}

  async init(pool: pg.Pool | null): Promise<void> {
    this.pool = pool;
    if (pool) await pool.query(DDL);
  }

  private async get(phone: string): Promise<Learner | null> {
    if (this.pool) return (await this.pool.query("SELECT doc FROM learners WHERE phone=$1", [phone])).rows[0]?.doc ?? null;
    return this.mem.get(phone) ?? null;
  }
  private async put(l: Learner): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO learners (learner_id, doc, ts) VALUES ($1,$2,$3)
         ON CONFLICT (learner_id) DO UPDATE SET doc=EXCLUDED.doc, ts=EXCLUDED.ts`,
        [l.learner_id, JSON.stringify(l), l.created_at]);
    } else this.mem.set(l.phone, l);
  }

  /** Public view — never leaks OTP fields. */
  private publicView(l: Learner) {
    return { learner_id: l.learner_id, phone: l.phone, email: l.email, name: l.name, status: l.status };
  }

  async startSignup(input: { name?: string; phone: string; email: string }): Promise<{ ok: boolean; error?: string; sent?: string; dev_otp?: string }> {
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

    const body = `Your Degree2Destiny verification code is ${otp}. It expires in 10 minutes.`;
    const res = await this.wa.sendText(phone, body);
    // In stub mode (no WhatsApp key) surface the code so the flow is testable.
    return { ok: true, sent: res.stub ? "stub" : "whatsapp", ...(res.stub ? { dev_otp: otp } : {}) };
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

  async count(): Promise<{ verified: number; pending: number }> {
    if (this.pool) {
      const r = await this.pool.query("SELECT status, COUNT(*)::int n FROM learners GROUP BY status");
      const m: Record<string, number> = {}; for (const row of r.rows) m[row.status] = row.n;
      return { verified: m.verified ?? 0, pending: m.pending ?? 0 };
    }
    let v = 0, p = 0; for (const l of this.mem.values()) l.status === "verified" ? v++ : p++;
    return { verified: v, pending: p };
  }
}

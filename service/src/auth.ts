/**
 * Accounts, passwords and sessions for the operator console.
 *
 * Four roles, coarse-grained on purpose — this is a small team, not an org chart:
 *   admin    — everything, plus user management
 *   coach    — curriculum authoring, cohort, journeys, enrollment, signups roster
 *   assessor — grading, integrity and escalation decisions; read-only on curriculum
 *   learner  — their own journey only, nothing else
 *
 * Passwords are scrypt-hashed (node:crypto — no dependency). Sessions are
 * server-side: the cookie carries an opaque random token, and only its SHA-256 is
 * stored, so a database leak does not hand over live sessions.
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Collection, Db } from "mongodb";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: string | Buffer, len: number) => Promise<Buffer>;

export const ROLES = ["admin", "coach", "assessor", "learner"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export interface User {
  user_id: string;
  email: string;            // unique, lowercased
  name?: string;
  role: Role;
  password_hash: string;    // "scrypt:<saltHex>:<hashHex>"
  /** For role=learner: which learner record this account is allowed to see. */
  learner_id?: string;
  created_at: string;
  last_login_at?: string;
  disabled?: boolean;
  /** Set when an admin creates or resets the account; console nags until changed. */
  must_change_password?: boolean;
}

/** What the client is allowed to know about the signed-in user. */
export interface SessionUser {
  user_id: string;
  email: string;
  name?: string;
  role: Role;
  learner_id?: string;
  must_change_password?: boolean;
}

interface Session {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: number;
}

export const SESSION_COOKIE = "d2d_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_LEN = 64;
const MIN_PASSWORD = 10;

const normalizeEmail = (e: string) => (e || "").trim().toLowerCase();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, SCRYPT_LEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(plain, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Rejects the passwords that actually show up in practice, without being precious. */
export function passwordProblem(pw: string): string | null {
  if (!pw || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (/^\d+$/.test(pw)) return "Password cannot be only digits.";
  if (/^(password|welcome|degree2destiny|d2d)/i.test(pw)) return "Choose a less guessable password.";
  return null;
}

export class Auth {
  private users: Collection<User> | null = null;
  private sessions: Collection<Session> | null = null;
  // In-memory fallback so the service still boots (and dev works) without Mongo.
  private memUsers = new Map<string, User>();     // keyed by email
  private memSessions = new Map<string, Session>(); // keyed by token_hash

  async init(db: Db | null): Promise<void> {
    if (!db) return;
    this.users = db.collection<User>("users");
    this.sessions = db.collection<Session>("sessions");
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.sessions.createIndex({ token_hash: 1 }, { unique: true });
    // Let Mongo evict dead sessions rather than growing the collection forever.
    await this.sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  }

  /* ------------------------------------------------------------------ users */

  async count(): Promise<number> {
    if (this.users) return this.users.countDocuments({});
    return this.memUsers.size;
  }

  async findByEmail(email: string): Promise<User | null> {
    const e = normalizeEmail(email);
    if (this.users) {
      const d = await this.users.findOne({ email: e });
      if (!d) return null;
      const { _id: _drop, ...u } = d as any;
      return u as User;
    }
    return this.memUsers.get(e) ?? null;
  }

  async findById(userId: string): Promise<User | null> {
    if (this.users) {
      const d = await this.users.findOne({ user_id: userId });
      if (!d) return null;
      const { _id: _drop, ...u } = d as any;
      return u as User;
    }
    for (const u of this.memUsers.values()) if (u.user_id === userId) return u;
    return null;
  }

  async list(): Promise<SessionUser[]> {
    const all = this.users
      ? (await this.users.find({}).sort({ created_at: 1 }).toArray()).map((d) => {
          const { _id: _drop, ...u } = d as any;
          return u as User;
        })
      : [...this.memUsers.values()];
    return all.map((u) => this.publicView(u, u.disabled));
  }

  private publicView(u: User, disabled?: boolean): SessionUser & { disabled?: boolean; created_at?: string; last_login_at?: string } {
    return {
      user_id: u.user_id, email: u.email, name: u.name, role: u.role,
      learner_id: u.learner_id, must_change_password: u.must_change_password,
      disabled, created_at: u.created_at, last_login_at: u.last_login_at,
    };
  }

  private async put(u: User): Promise<void> {
    if (this.users) {
      await this.users.replaceOne({ email: u.email }, u, { upsert: true });
      return;
    }
    this.memUsers.set(u.email, u);
  }

  async createUser(input: {
    email: string; password: string; role: Role; name?: string; learner_id?: string; must_change_password?: boolean;
  }): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) return { ok: false, error: "Enter a valid email address." };
    if (!isRole(input.role)) return { ok: false, error: "Unknown role." };
    const problem = passwordProblem(input.password);
    if (problem) return { ok: false, error: problem };
    if (await this.findByEmail(email)) return { ok: false, error: "An account with that email already exists." };
    // A learner account without a learner_id could see nothing — catch it here
    // rather than letting them log into an empty console.
    if (input.role === "learner" && !input.learner_id?.trim()) {
      return { ok: false, error: "A learner account needs a learner_id to scope it to." };
    }

    const user: User = {
      user_id: `usr-${randomUUID()}`,
      email,
      name: input.name?.trim() || undefined,
      role: input.role,
      password_hash: await hashPassword(input.password),
      learner_id: input.role === "learner" ? input.learner_id!.trim() : undefined,
      created_at: new Date().toISOString(),
      must_change_password: input.must_change_password ?? true,
    };
    await this.put(user);
    return { ok: true, user: this.publicView(user) };
  }

  async setDisabled(userId: string, disabled: boolean): Promise<boolean> {
    const u = await this.findById(userId);
    if (!u) return false;
    await this.put({ ...u, disabled });
    if (disabled) await this.revokeAllForUser(userId); // don't let an open tab outlive the account
    return true;
  }

  async setPassword(userId: string, plain: string, opts: { mustChange?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const problem = passwordProblem(plain);
    if (problem) return { ok: false, error: problem };
    const u = await this.findById(userId);
    if (!u) return { ok: false, error: "No such account." };
    await this.put({ ...u, password_hash: await hashPassword(plain), must_change_password: opts.mustChange ?? false });
    return { ok: true };
  }

  async deleteUser(userId: string): Promise<boolean> {
    const u = await this.findById(userId);
    if (!u) return false;
    if (this.users) await this.users.deleteOne({ user_id: userId });
    else this.memUsers.delete(u.email);
    await this.revokeAllForUser(userId);
    return true;
  }

  /* --------------------------------------------------------------- sessions */

  /** Returns the raw token to put in the cookie; only its hash is persisted. */
  async login(email: string, password: string): Promise<{ ok: true; token: string; user: SessionUser } | { ok: false; error: string }> {
    const u = await this.findByEmail(email);
    // Same message either way — don't confirm which emails exist.
    const generic = { ok: false as const, error: "Wrong email or password." };
    if (!u) {
      // Spend comparable time on a miss so response timing doesn't enumerate accounts.
      await hashPassword(password).catch(() => {});
      return generic;
    }
    if (!(await verifyPassword(password, u.password_hash))) return generic;
    if (u.disabled) return { ok: false, error: "This account has been disabled." };

    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      token_hash: sha256(token),
      user_id: u.user_id,
      created_at: new Date().toISOString(),
      expires_at: Date.now() + SESSION_TTL_MS,
    };
    if (this.sessions) await this.sessions.insertOne(session as any);
    else this.memSessions.set(session.token_hash, session);

    await this.put({ ...u, last_login_at: new Date().toISOString() });
    return { ok: true, token, user: this.publicView(u) };
  }

  async resolve(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const hash = sha256(token);
    const s = this.sessions
      ? ((await this.sessions.findOne({ token_hash: hash })) as Session | null)
      : this.memSessions.get(hash) ?? null;
    if (!s) return null;
    if (s.expires_at <= Date.now()) { await this.revoke(token); return null; }
    const u = await this.findById(s.user_id);
    if (!u || u.disabled) return null;
    return this.publicView(u);
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    const hash = sha256(token);
    if (this.sessions) await this.sessions.deleteOne({ token_hash: hash });
    else this.memSessions.delete(hash);
  }

  private async revokeAllForUser(userId: string): Promise<void> {
    if (this.sessions) { await this.sessions.deleteMany({ user_id: userId }); return; }
    for (const [k, s] of this.memSessions) if (s.user_id === userId) this.memSessions.delete(k);
  }

  /* -------------------------------------------------------------- bootstrap */

  /**
   * Creates the first admin from env vars, but only while there are no accounts at
   * all. Without this there is no way to log in to a fresh deployment; with the
   * emptiness check it cannot be used to add an admin to a live system.
   */
  async bootstrapAdmin(email: string | undefined, password: string | undefined, log: {
    info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void;
  }, opts: { force?: boolean } = {}): Promise<void> {
    if (!email || !password) return;

    /*
     * force: recovery hatch for a lost admin password. Whoever controls the deploy
     * secrets already owns the box, so letting them reset THE bootstrap account's
     * password (never create extra admins) adds no new attacker capability. Off by
     * default; turn the BOOTSTRAP_ADMIN_FORCE variable back off after recovering.
     */
    if (opts.force) {
      const existing = await this.findByEmail(email);
      if (existing) {
        await this.setPassword(existing.user_id, password, { mustChange: false });
        log.warn(`BOOTSTRAP_ADMIN_FORCE: password reset for ${email} — turn the flag off now that you're in`);
        return;
      }
      const r = await this.createUser({ email, password, role: "admin", name: "Administrator", must_change_password: false });
      if (r.ok) log.warn(`BOOTSTRAP_ADMIN_FORCE: created admin ${email} — turn the flag off now that you're in`);
      else log.error(`admin bootstrap (force) failed: ${r.error}`);
      return;
    }

    if ((await this.count()) > 0) return;
    const r = await this.createUser({ email, password, role: "admin", name: "Administrator", must_change_password: true });
    if (r.ok) log.warn(`bootstrapped admin account ${r.user.email} — change this password after first login`);
    else log.error(`admin bootstrap failed: ${r.error}`);
  }
}

/* ------------------------------------------------------- role permissions */

/**
 * What each role may do. Kept as one table so the permission model is readable in
 * a single glance rather than scattered across route handlers.
 */
export const PERMISSIONS = {
  /** Create/edit/publish courses, modules, lessons. */
  authorCurriculum: ["admin", "coach"],
  /** Enroll learners, set projects, drive journeys, run check-ins. */
  manageLearners: ["admin", "coach"],
  /** See the signups roster — learner PII. */
  viewSignups: ["admin", "coach"],
  /** Resolve integrity reviews and escalations. */
  assess: ["admin", "assessor"],
  /** Edit agent prompts, knowledge bases, guardrails. */
  configureAgents: ["admin", "coach"],
  /** Create and disable accounts. */
  manageUsers: ["admin"],
  /** Operator-wide read access to cohort, learners, transactions, costs. */
  viewOperator: ["admin", "coach", "assessor"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const roleHas = (role: Role, perm: Permission): boolean =>
  (PERMISSIONS[perm] as readonly Role[]).includes(role);

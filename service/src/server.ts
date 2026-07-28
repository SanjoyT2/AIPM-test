/**
 * D2D Phase-1 service — Fastify API.
 *
 * Boot order is deliberate: frameworks load + validate FIRST (fail-loud, ADR-006),
 * then the ledger, then routes. Every transaction posted to the ledger is validated
 * against the canonical JSON Schema — the same file that documents it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { loadAgents } from "./agents.js";
import { Auth, isRole, PERMISSIONS, roleHas, ROLES, SESSION_COOKIE, type Permission, type Role, type SessionUser } from "./auth.js";
import { loadFrameworks } from "./config-loader.js";
import { LmsStore } from "./content-store.js";
import { DailyLoop } from "./daily-loop.js";
import { EvidenceStore } from "./evidence-store.js";
import { LearningEngine } from "./learning.js";
import { Executor } from "./executor.js";
import { LlmGateway } from "./gateway.js";
import { Ledger } from "./ledger.js";
import { MeasurementEngine } from "./measurement.js";
import { Onboarding } from "./onboarding.js";
import { OperatorActionStore } from "./operator-actions.js";
import { ResourceStore } from "./resource-store.js";
import { settings } from "./settings.js";
import { normalizePhone, Signups } from "./signups.js";
import type { AgentTransaction, EvidenceEvent } from "./types.js";
import { compileSchema } from "./validation.js";
import { WaClient } from "./wa-client.js";

/**
 * Constant-time secret comparison. Both sides are hashed first so the digests are
 * always equal length — timingSafeEqual throws on length mismatch, and comparing
 * raw values would leak the secret's length.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/* ---------------------------------------------- learner magic-link web view */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tiny self-contained page in the landing-page's visual family — no SPA, no login. */
function journeyPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Degree2Destiny</title><style>
:root{--ink:#0e1728;--ink2:#414a63;--muted:#7b8299;--cream:#fbf8f3;--line:rgba(14,23,40,.10);--accent:#6a5fd0;
--grad:linear-gradient(120deg,#f4beb9,#e5c0d9 26%,#bfc0df 52%,#c0e1f2 78%,#d6eade)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--cream);color:var(--ink);line-height:1.6}
.wrap{max-width:640px;margin:0 auto;padding:24px 20px 60px}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:26px}
.mark{width:32px;height:32px;border-radius:8px;background:var(--grad);display:grid;place-items:center;font-weight:700;font-size:11px}
h1{font-size:26px;margin:0 0 18px}h2{font-size:20px;margin:0 0 2px}
.mods{list-style:none;padding:0;margin:0 0 22px}
.mods li{display:flex;justify-content:space-between;padding:10px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:#fff}
.mods li.done{opacity:.55}.mods li.done span:first-child::before{content:"✓ ";color:var(--accent)}
.count{color:var(--muted);font-size:13px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 14px 40px -20px rgba(14,23,40,.25)}
.cap{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:6px}
.mod{font-size:13px;color:var(--muted);margin-bottom:12px}.body{font-size:15px;color:var(--ink2)}
.muted{color:var(--muted)}.foot{font-size:13px;margin-top:22px;text-align:center}
</style></head><body><div class="wrap">
<div class="brand"><div class="mark">D2D</div><b>Degree2Destiny</b></div>
<h1>${title}</h1>${body}</div></body></html>`;
}

const presentedOperatorKey = (req: any) => ((req.headers["x-operator-key"] ?? "") as string);
/** The non-interactive path: scripts, CI and curl authenticate with the shared key. */
const operatorKeyValid = (req: any) =>
  !!settings.operatorKey && timingSafeEqualStr(presentedOperatorKey(req), settings.operatorKey);

async function main() {
  // 1. Frameworks (throws on invalid config — refuse to boot)
  const frameworks = loadFrameworks();

  // 2. Ledger + gateway + evidence store (LRS) + measurement engine
  const ledger = new Ledger();
  await ledger.init();
  const evidence = new EvidenceStore();
  await evidence.init(ledger.getPool());
  const operatorActions = new OperatorActionStore();
  await operatorActions.init(ledger.getPool());
  const resources = new ResourceStore();
  await resources.init(ledger.getPool());
  const measurement = new MeasurementEngine(frameworks);
  const gateway = new LlmGateway(frameworks.costModel);

  // Make the two "am I actually configured?" answers loud in the boot log — a
  // silently-ephemeral ledger is the failure people notice a week too late.
  if (ledger.storage === "memory") {
    console.warn(
      "[ledger] DATABASE_URL is not set — running IN-MEMORY. Transactions are lost on restart/redeploy. " +
      "Set DATABASE_URL to a MongoDB connection string (mongodb+srv://...) to persist.",
    );
  } else {
    console.info("[ledger] MongoDB connected — transactions are durable.");
  }
  if (gateway.stubMode) {
    console.warn(
      "[gateway] OPENAI_API_KEY is not set — running in STUB mode. Agents return canned text and cost is simulated. " +
      "Set OPENAI_API_KEY for live model calls.",
    );
  } else {
    console.info(`[gateway] OpenAI live — fast=${settings.models.fast} deep=${settings.models.deep}`);
  }

  // 3. Canonical schema validators for inbound records
  const validateTx = compileSchema(
    JSON.parse(fs.readFileSync(path.join(settings.schemaDir, "agent-transaction.schema.json"), "utf8")),
  );
  const validateEv = compileSchema(
    JSON.parse(fs.readFileSync(path.join(settings.schemaDir, "evidence-event.schema.json"), "utf8")),
  );

  // 4. Executor + daily loop (plan-and-act runtime) + WhatsApp outbound
  const agents = loadAgents();
  const executor = new Executor(frameworks, gateway, ledger, validateTx as (tx: unknown) => boolean);
  const wa = new WaClient();
  if (wa.stubMode) {
    console.warn("[wa] WA_API_TOKEN not set — outbound WhatsApp in STUB mode (messages are logged, not sent).");
  } else {
    console.info(`[wa] 11za outbound live — base=${settings.wa.apiBase}`);
  }
  const dailyLoop = new DailyLoop(executor, agents, frameworks, wa, resources);
  const onboarding = new Onboarding(wa, gateway);
  // Discover the OTP template up front so /api/health is honest from the first probe.
  // Never blocks boot: an 11za outage must not take the whole service down.
  onboarding.refresh().catch((e) => console.warn(`[onboarding] initial template discovery failed: ${e}`));
  // Re-check on a timer too: /api/health reads the agent's cached view, and with an
  // idle funnel nothing else would ever refresh it — a Meta approval would go
  // unnoticed until the next signup. unref() keeps the timer from blocking shutdown.
  setInterval(() => { onboarding.refresh().catch(() => {}); }, 10 * 60 * 1000).unref();
  const signups = new Signups(onboarding);
  await signups.init(ledger.getPool());
  onboarding.bindStore(signups);
  const lms = new LmsStore();
  await lms.init(ledger.getPool());
  const learning = new LearningEngine(
    lms, evidence, gateway, dailyLoop, frameworks.versions.competency_framework,
    async (learnerId) => {
      const token = await signups.mintJourneyToken(learnerId);
      return token ? `${settings.publicBaseUrl}/l/${token}` : null;
    },
  );
  const auth = new Auth();
  await auth.init(ledger.getPool());

  // Merged guardrail-rule catalog: built-in config rules (now plain-English,
  // LLM-enforced) + user-created custom rules. Used to validate sets + for the UI.
  const configRuleDefs = () => Object.entries<any>(frameworks.guardrails.rules ?? {}).map(([id, r]) => ({
    rule_id: id, name: id, description: r.detail ?? id, severity: r.severity ?? "warn", source: "built-in" as const,
  }));
  const ruleCatalog = async () => {
    const custom = (await resources.listRules()).map((r) => ({ rule_id: r.rule_id, name: r.name, description: r.description, severity: r.severity, source: "custom" as const }));
    return [...configRuleDefs(), ...custom];
  };
  dailyLoop.startSilenceSweep();

  const app = Fastify({ logger: true });
  await app.register(fastifyCookie);

  await auth.bootstrapAdmin(settings.bootstrapAdmin.email, settings.bootstrapAdmin.password, {
    info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m),
  });

  /* ------------------------------------------------------------------ access */

  const sessionUser = (req: any): Promise<SessionUser | null> => auth.resolve(req.cookies?.[SESSION_COOKIE]);

  /**
   * The single gate. Returns true when the request was refused, so handlers read as
   * `if (await deny(req, reply, "authorCurriculum")) return;`.
   *
   * Two ways in: the shared operator key (scripts, CI) or a signed-in account whose
   * role carries the permission. The only bypass is a genuinely unconfigured local
   * dev box — no operator key and not production — which keeps `npm run dev` usable.
   */
  async function deny(req: any, reply: any, perm: Permission): Promise<boolean> {
    if (operatorKeyValid(req)) return false;
    if (presentedOperatorKey(req)) { reply.code(401).send({ error: "bad operator key" }); return true; }

    const user = await sessionUser(req);
    if (user) {
      if (roleHas(user.role, perm)) return false;
      reply.code(403).send({ error: `role "${user.role}" cannot ${perm}`, need: PERMISSIONS[perm] });
      return true;
    }
    if (settings.env !== "production" && !settings.operatorKey) {
      req.log.warn(`no auth configured — ${req.method} ${req.url} allowed UNAUTHENTICATED (non-production only)`);
      return false;
    }
    reply.code(401).send({ error: "sign in required" });
    return true;
  }

  /* -------------------------------------------------------------------- auth */

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: "Email and password are required." });
    const r = await auth.login(email, password);
    if (!r.ok) {
      req.log.warn({ email }, "failed login");
      return reply.code(401).send({ error: r.error });
    }
    reply.setCookie(SESSION_COOKIE, r.token, {
      httpOnly: true,          // not readable by scripts, so XSS can't lift the session
      sameSite: "lax",         // survives the top-level navigation from the landing page
      secure: settings.cookieSecure,
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    return { user: r.user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await auth.revoke(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /** Who am I — the console calls this on load to decide login vs console. */
  app.get("/api/auth/me", async (req, reply) => {
    const user = await sessionUser(req);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    return { user, permissions: Object.fromEntries(Object.keys(PERMISSIONS).map((p) => [p, roleHas(user.role, p as Permission)])) };
  });

  /** Change your own password. Also clears the must-change nag. */
  app.post("/api/auth/password", async (req, reply) => {
    const user = await sessionUser(req);
    if (!user) return reply.code(401).send({ error: "sign in required" });
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (!current || !next) return reply.code(400).send({ error: "Current and new password are required." });
    // Re-authenticate: a stolen session shouldn't be able to lock the owner out.
    const check = await auth.login(user.email, current);
    if (!check.ok) return reply.code(401).send({ error: "Current password is wrong." });
    const r = await auth.setPassword(user.user_id, next, { mustChange: false });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });

  /** Shared by the operator route and the learner's own /api/me/journey. */
  async function learnerJourney(id: string) {
    const enr = await lms.activeEnrollment(id);
    if (!enr) return { learner_id: id, enrolled: false };
    const p = await lms.getProgress(id, enr.course_id);
    const journey = await lms.courseJourney(enr.course_id);
    const next = await lms.nextStep(id, enr.course_id);
    const modules = await lms.moduleProgress(id, enr.course_id);
    const project = await lms.getProject(id);
    const course = await lms.getCourse(enr.course_id);
    return {
      learner_id: id, enrolled: true, course_id: enr.course_id, course_title: course?.title,
      completed: p.completed.length, total: journey.length, awaiting_lesson_id: p.awaiting_lesson_id,
      next_lesson: next ? { lesson_id: next.lesson_id, title: next.title, type: next.type, module: next.module_title } : null,
      project,
      modules: modules.map((m) => ({ title: m.module.title, done: m.done, total: m.total, complete: m.complete, milestone: m.module.milestone })),
    };
  }

  /* ------------------------------------------------- the signed-in learner's own view

     Learners never hit /api/learners/:id — they'd be one edited URL away from each
     other's records. These read the id off the session instead, so there is no
     learner-supplied identifier to tamper with. */

  /** Resolves the learner this session is allowed to see, or 401/403s. */
  async function meAsLearner(req: any, reply: any): Promise<string | null> {
    const user = await sessionUser(req);
    if (!user) { reply.code(401).send({ error: "sign in required" }); return null; }
    if (user.role !== "learner" || !user.learner_id) {
      reply.code(403).send({ error: "this endpoint is for learner accounts" });
      return null;
    }
    return user.learner_id;
  }

  app.get("/api/me/journey", async (req, reply) => {
    const id = await meAsLearner(req, reply);
    if (!id) return;
    return learnerJourney(id);
  });

  app.get("/api/me/measurement", async (req, reply) => {
    const id = await meAsLearner(req, reply);
    if (!id) return;
    const evs = await evidence.forLearner(id);
    // A learner with no evidence yet is a normal early state, not an error.
    if (!evs.length) return { learner_id: id, evidence_count: 0, mastery: [], composite: null };
    const cleared = await operatorActions.clearedIntegrityFor(id);
    return measurement.compute(id, evs, { asOf: Date.now(), clearedIntegrity: cleared });
  });

  app.post("/api/me/checkin", async (req, reply) => {
    const id = await meAsLearner(req, reply);
    if (!id) return;
    return learning.checkIn(id, "learner_requested");
  });

  /* --------------------------------------------------------- user management */

  app.get("/api/users", async (req, reply) => {
    if (await deny(req, reply, "manageUsers")) return;
    return auth.list();
  });

  app.post("/api/users", async (req, reply) => {
    if (await deny(req, reply, "manageUsers")) return;
    const b = (req.body ?? {}) as { email?: string; password?: string; role?: string; name?: string; learner_id?: string };
    if (!b.email || !b.password) return reply.code(400).send({ error: "Email and password are required." });
    if (!isRole(b.role)) return reply.code(400).send({ error: `role must be one of: ${ROLES.join(", ")}` });
    const r = await auth.createUser({
      email: b.email, password: b.password, role: b.role as Role, name: b.name, learner_id: b.learner_id,
    });
    return r.ok ? reply.code(201).send(r.user) : reply.code(400).send({ error: r.error });
  });

  app.post("/api/users/:id/disabled", async (req, reply) => {
    if (await deny(req, reply, "manageUsers")) return;
    const { id } = req.params as { id: string };
    const { disabled } = (req.body ?? {}) as { disabled?: boolean };
    const me = await sessionUser(req);
    // Locking yourself out of the only admin account is unrecoverable from the UI.
    if (me?.user_id === id && disabled) return reply.code(400).send({ error: "You cannot disable your own account." });
    return (await auth.setDisabled(id, !!disabled)) ? { ok: true } : reply.code(404).send({ error: "no such account" });
  });

  app.post("/api/users/:id/password", async (req, reply) => {
    if (await deny(req, reply, "manageUsers")) return;
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password) return reply.code(400).send({ error: "password is required" });
    const r = await auth.setPassword(id, password, { mustChange: true });
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.error });
  });

  app.delete("/api/users/:id", async (req, reply) => {
    if (await deny(req, reply, "manageUsers")) return;
    const { id } = req.params as { id: string };
    const me = await sessionUser(req);
    if (me?.user_id === id) return reply.code(400).send({ error: "You cannot delete your own account." });
    return (await auth.deleteUser(id)) ? { ok: true } : reply.code(404).send({ error: "no such account" });
  });

  // ---- Health & meta ----
  app.get("/api/health", async () => ({
    status: "ok",
    env: settings.env,
    storage: ledger.storage,
    gateway: gateway.stubMode ? "stub" : "live",
    whatsapp: wa.stubMode ? "stub" : "live",
    otp_delivery: onboarding.healthState(),
    inbound_webhook: onboarding.webhookHealthState(),
    framework_versions: frameworks.versions,
  }));

  // ---- Onboarding agent: OTP template discovery + funnel status (operator-only) ----
  app.get("/api/onboarding/status", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    return onboarding.status();
  });
  // Re-discover on demand — e.g. right after the operator gets a template approved.
  app.post("/api/onboarding/refresh", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await onboarding.refresh();
    return onboarding.status();
  });
  /*
   * Fleet reconciliation: every template in whatsapp-templates.yaml vs the live
   * 11za account. Reading it also heals: missing templates are (re)submitted to
   * Meta. approved = usable now; pending/submitted = Meta reviewing; failed = fix me.
   */
  app.get("/api/templates/status", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    return { templates: await onboarding.fleetStatus() };
  });

  // ---- Public signup (landing page) — WhatsApp OTP onboarding ----
  app.post("/api/signup", async (req, reply) => {
    const { name, phone, email } = (req.body ?? {}) as { name?: string; phone?: string; email?: string };
    if (!phone || !email) return reply.code(400).send({ ok: false, error: "Phone and email are required." });
    const r = await signups.startSignup({ name, phone, email });
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  app.post("/api/signup/verify", async (req, reply) => {
    const { phone, otp } = (req.body ?? {}) as { phone?: string; otp?: string };
    if (!phone || !otp) return reply.code(400).send({ ok: false, error: "Phone and code are required." });
    const r = await signups.verify(phone, otp);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  app.get("/api/signup/stats", async () => signups.count());

  // ---- Learner web view via magic link (no password — the token IS the credential) ----
  app.get("/l/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const learner = await signups.resolveJourneyToken(token);
    if (!learner) {
      return reply.code(404).type("text/html").send(journeyPage("Link expired", `<p class="muted">This link is no longer valid. Send us any message on WhatsApp and you'll get a fresh one with your next lesson.</p>`));
    }
    const enr = await lms.activeEnrollment(learner.learner_id);
    if (!enr) {
      return reply.type("text/html").send(journeyPage(`Namaste${learner.name ? " " + esc(learner.name.split(/\s+/)[0]) : ""}!`, `<p class="muted">Your journey hasn't started yet. Reply <b>START</b> on WhatsApp to begin your first course.</p>`));
    }
    const course = await lms.getCourse(enr.course_id);
    const mods = await lms.moduleProgress(learner.learner_id, enr.course_id);
    const p = await lms.getProgress(learner.learner_id, enr.course_id);

    const modList = mods.map((m) =>
      `<li class="${m.complete ? "done" : ""}"><span>${esc(m.module.title)}</span><span class="count">${m.done}/${m.total}</span></li>`,
    ).join("");
    const lesson = p.last_rendered
      ? `<div class="card"><div class="cap">${p.awaiting_lesson_id === p.last_rendered.lesson_id ? "Awaiting your answer on WhatsApp" : "Latest lesson"}</div>
         <h2>${esc(p.last_rendered.title)}</h2><div class="mod">${esc(p.last_rendered.module_title)}</div>
         <div class="body">${esc(p.last_rendered.body).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/_([^_\n]+)_/g, "<i>$1</i>").replace(/\n/g, "<br>")}</div></div>`
      : `<p class="muted">Your next lesson arrives on WhatsApp — reply START.</p>`;
    return reply.type("text/html").send(journeyPage(
      esc(course?.title ?? "Your course"),
      `<ul class="mods">${modList}</ul>${lesson}<p class="muted foot">Everything happens on WhatsApp — this page is your progress mirror. 📱</p>`,
    ));
  });
  // The operator's roster of real registrants. Gated: this is learner PII (phone, email),
  // unlike /api/signup/stats which is only a count.
  app.get("/api/signups", async (req, reply) => {
    if (await deny(req, reply, "viewSignups")) return;
    const { limit } = (req.query ?? {}) as { limit?: string };
    return signups.list(Math.min(Number(limit) || 500, 1000));
  });

  // ---- LMS: courses -> modules -> lessons, enrollment, journey (the CMS) ----
  app.get("/api/courses", async () => lms.listCourses());
  app.post("/api/courses", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const { title, outcome } = (req.body ?? {}) as { title?: string; outcome?: string };
    if (!title) return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send(await lms.createCourse(title, outcome ?? ""));
  });

  /*
   * Coach drafts a whole course from an operator brief. ALWAYS lands as a draft —
   * publishing stays a human decision (the Advisor auto-enrolls real learners from
   * the published catalog, so nothing AI-authored goes live without operator review).
   */
  app.post("/api/courses/draft", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const { brief } = (req.body ?? {}) as { brief?: string };
    if (!brief?.trim()) return reply.code(400).send({ error: "brief is required" });

    const compIds = (frameworks.competencyFramework?.levels ?? [])
      .flatMap((l: any) => (l.competencies ?? []).map((c: any) => `${c.id} (${c.name})`));
    const res = await gateway.complete({
      tier: "deep", role: "actor", maxTokens: 4000,
      system: `${agents.coach?.systemPrompt ?? "You are the Coach."}\n\n# Authoring mode\nYou are drafting a COURSE for the operator to review. Return STRICT JSON only (no fences, no prose):\n{"title":"...","outcome":"one line","modules":[{"title":"...","competencies":["<framework id>"],"milestone":{"title":"...","definition_of_done":"..."},"human_spine":"one line on the human/stakeholder thread","lessons":[{"type":"micro"|"quiz"|"task"|"roleplay","title":"...","objective":"one line","key_points":["..."],"difficulty":"intro"|"core"|"stretch","competency_id":"<framework id>","pass_mark":60}]}]}\nRules: 3-5 modules, 3-6 lessons each, every module ends with a non-micro assessment lesson. competency_id MUST be one of the framework ids below.\n\n# Framework competencies\n${compIds.join("\n")}`,
      user: brief,
    });

    let draft: any;
    try {
      const raw = res.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      draft = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    } catch {
      return reply.code(502).send({ error: "Coach returned unparseable course JSON — try rephrasing the brief.", raw: res.text.slice(0, 500) });
    }
    if (!draft?.title || !Array.isArray(draft.modules) || !draft.modules.length) {
      return reply.code(502).send({ error: "Coach draft is missing title or modules — try a more specific brief." });
    }

    const course = await lms.createCourse(String(draft.title), String(draft.outcome ?? ""));
    let lessons = 0;
    for (const [mi, m] of draft.modules.entries()) {
      const mod = await lms.addModule(course.course_id, String(m.title ?? `Module ${mi + 1}`), mi + 1,
        Array.isArray(m.competencies) ? m.competencies.map(String) : [],
        { milestone: m.milestone, human_spine: m.human_spine });
      for (const [li, l] of (Array.isArray(m.lessons) ? m.lessons : []).entries()) {
        await lms.addLesson(mod.module_id, {
          order: li + 1,
          type: ["micro", "quiz", "task", "roleplay"].includes(l.type) ? l.type : "micro",
          competency_id: String(l.competency_id ?? ""),
          title: String(l.title ?? `Lesson ${li + 1}`),
          objective: String(l.objective ?? ""),
          key_points: Array.isArray(l.key_points) ? l.key_points.map(String) : [],
          difficulty: ["intro", "core", "stretch"].includes(l.difficulty) ? l.difficulty : "core",
          personalize: true,
          pass_mark: Number(l.pass_mark) || 60,
        });
        lessons++;
      }
    }
    req.log.info(`coach drafted course "${course.title}" (${draft.modules.length} modules, ${lessons} lessons) — status: draft`);
    return reply.code(201).send({ course, modules: draft.modules.length, lessons, cost_usd: res.call.usd });
  });
  app.get("/api/courses/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const course = await lms.getCourse(id);
    if (!course) return reply.code(404).send({ error: "not found" });
    const modules = await lms.listModules(id);
    const withLessons = await Promise.all(modules.map(async (m) => ({ ...m, lessons: await lms.listLessons(m.module_id) })));
    return { ...course, modules: withLessons };
  });
  app.post("/api/courses/:id/publish", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const { status } = (req.body ?? {}) as { status?: string };
    // Publishing is reversible — an operator can pull a course back to draft.
    const next = status === "draft" ? "draft" : "published";
    await lms.setCourseStatus((req.params as { id: string }).id, next as any);
    return { ok: true, status: next };
  });
  app.post("/api/courses/:id/modules", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const { id } = req.params as { id: string };
    const { title, order, competencies, milestone, human_spine } = (req.body ?? {}) as { title?: string; order?: number; competencies?: string[]; milestone?: { title: string; definition_of_done: string }; human_spine?: string };
    if (!title) return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send(await lms.addModule(id, title, order ?? 999, competencies ?? [], { milestone, human_spine }));
  });
  app.post("/api/modules/:id/lessons", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as any;
    if (!b.type || !b.competency_id || !b.title || !b.objective) return reply.code(400).send({ error: "type, competency_id, title, objective are required" });
    return reply.code(201).send(await lms.addLesson(id, {
      order: b.order ?? 999, type: b.type, competency_id: b.competency_id, title: b.title,
      objective: b.objective, key_points: b.key_points ?? [], difficulty: b.difficulty ?? "core",
      personalize: b.personalize ?? true, pass_mark: b.pass_mark ?? 60,
    }));
  });
  app.put("/api/lessons/:id", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    const u = await lms.updateLesson((req.params as { id: string }).id, (req.body ?? {}) as any);
    return u ? u : reply.code(404).send({ error: "not found" });
  });
  app.delete("/api/lessons/:id", async (req, reply) => {
    if (await deny(req, reply, "authorCurriculum")) return;
    await lms.deleteLesson((req.params as { id: string }).id);
    return { ok: true };
  });

  // Enrollment + a learner's journey progress.
  app.post("/api/enroll", async (req, reply) => {
    if (await deny(req, reply, "manageLearners")) return;
    const { learner, course } = (req.body ?? {}) as { learner?: string; course?: string };
    if (!learner || !course) return reply.code(400).send({ error: "learner and course are required" });
    return reply.code(201).send(await lms.enroll(learner, course));
  });
  app.get("/api/learners/:id/journey", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    return learnerJourney((req.params as { id: string }).id);
  });

  // The learner's one solution (project).
  app.get("/api/learners/:id/project", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { id } = req.params as { id: string };
    return (await lms.getProject(id)) ?? { learner_id: id, project: null };
  });
  app.post("/api/learners/:id/project", async (req, reply) => {
    if (await deny(req, reply, "manageLearners")) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { title?: string; stakeholder?: string; problem?: string; success_metric?: string; status?: string };
    if (!b.title || !b.stakeholder) return reply.code(400).send({ error: "title and stakeholder are required" });
    return reply.code(201).send(await lms.setProject({ learner_id: id, title: b.title, stakeholder: b.stakeholder, problem: b.problem ?? "", success_metric: b.success_metric ?? "", status: (b.status as any) ?? "scoping" }));
  });

  // Coach (AI Program Manager) weekly check-in.
  app.post("/api/learners/:id/checkin", async (req, reply) => {
    if (await deny(req, reply, "manageLearners")) return;
    const { id } = req.params as { id: string };
    const { trigger } = (req.body ?? {}) as { trigger?: string };
    return learning.checkIn(id, trigger);
  });

  // Operator-driven journey step (authenticated). Lets a coach walk a learner's real
  // journey from the console before 11za is connected. Drives real LLM spend, so it
  // requires the operator key and fails closed in production if that key is unset.
  app.post("/api/learners/:id/advance", async (req, reply) => {
    if (await deny(req, reply, "manageLearners")) return;
    const { id } = req.params as { id: string };
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text) return reply.code(400).send({ error: "text is required" });
    return learning.onMessage(id, text);
  });

  // Coach cohort view: every enrolled learner with progress + status.
  app.get("/api/cohort", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const enrs = await lms.listEnrollments();
    const seen = new Set<string>();
    const rows = [];
    for (const e of enrs) {
      if (seen.has(e.learner_id)) continue; seen.add(e.learner_id);
      const mods = await lms.moduleProgress(e.learner_id, e.course_id);
      const total = mods.reduce((a, m) => a + m.total, 0);
      const done = mods.reduce((a, m) => a + m.done, 0);
      const course = await lms.getCourse(e.course_id);
      const project = await lms.getProject(e.learner_id);
      rows.push({ learner_id: e.learner_id, course: course?.title ?? e.course_id, status: e.status, completed: done, total, modules_complete: mods.filter((m) => m.complete).length, modules_total: mods.length, project: project ? { title: project.title, stakeholder: project.stakeholder, status: project.status } : null });
    }
    return rows;
  });

  app.get("/api/config/frameworks", async () => frameworks.versions);
  app.get("/api/config/frameworks/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const map: Record<string, unknown> = {
      "competency-framework": frameworks.competencyFramework,
      "composite-formula": frameworks.compositeFormula,
      "progression-rules": frameworks.progressionRules,
      diagnostic: frameworks.diagnostic,
      guardrails: frameworks.guardrails,
      critics: frameworks.critics,
      "cost-model": frameworks.costModel,
    };
    if (!(name in map)) return reply.code(404).send({ error: `unknown framework '${name}'` });
    return map[name];
  });

  // ---- Transaction ledger (Req 1-4 all live on this record) ----
  app.post("/api/transactions", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const body = req.body as AgentTransaction;
    if (!validateTx(body)) {
      return reply.code(422).send({ error: "schema validation failed", details: validateTx.errors });
    }
    try {
      await ledger.append(body);
    } catch (e) {
      return reply.code(409).send({ error: String(e) });
    }
    return reply.code(201).send({ transaction_id: body.transaction_id });
  });

  app.get("/api/transactions", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const q = req.query as { agent?: string; subject?: string; status?: string; limit?: string };
    return ledger.list({ agent: q.agent, subject: q.subject, status: q.status, limit: q.limit ? Number(q.limit) : undefined });
  });

  app.get("/api/transactions/:id", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { id } = req.params as { id: string };
    const tx = await ledger.get(id);
    if (!tx) return reply.code(404).send({ error: "not found" });
    return tx;
  });

  // ---- Cost train rollups (Req 3 / dashboard) ----
  app.get("/api/costs/rollup", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { by = "agent" } = req.query as { by?: string };
    if (!["agent", "subject", "plan", "status"].includes(by)) {
      return reply.code(400).send({ error: "by must be one of agent|subject|plan|status" });
    }
    return ledger.costRollup(by as "agent" | "subject" | "plan" | "status");
  });

  // ---- Evidence events (Learner Record Store) ----
  app.post("/api/evidence", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const body = req.body as EvidenceEvent;
    if (!validateEv(body)) {
      return reply.code(422).send({ error: "schema validation failed", details: validateEv.errors });
    }
    await evidence.append(body);
    return reply.code(201).send({ event_id: body.event_id });
  });

  app.get("/api/evidence", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { learner } = req.query as { learner?: string };
    return learner ? evidence.forLearner(learner) : evidence.all();
  });

  // ---- Measurement: learners + per-learner mastery/composite (the credential) ----
  // asOf is fixed per request so a score is reproducible; defaults to now, but a
  // caller can pass ?asOf=ISO to recompute a historical snapshot deterministically.
  const asOfFrom = (q: Record<string, string | undefined>) =>
    q.asOf ? new Date(q.asOf).getTime() : Date.now();

  app.get("/api/learners", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const q = req.query as Record<string, string | undefined>;
    const asOf = asOfFrom(q);
    const ids = await evidence.learnerIds();
    const all = await evidence.all();
    const rows = await Promise.all(ids.map(async (id) => {
      const cleared = await operatorActions.clearedIntegrityFor(id);
      const m = measurement.compute(id, all, { asOf, clearedIntegrity: cleared });
      return {
        learner_id: id,
        composite: m.composite.final,
        rank_band: m.composite.rank_band,
        rank_band_id: m.composite.rank_band_id,
        integrity_review: m.integrity.filter((f) => f.review).length,
        evidence_count: m.evidence_count,
        competencies_at_threshold: m.mastery.filter((c) => c.at_threshold).length,
        competencies_total: m.mastery.length,
      };
    }));
    return rows.sort((a, b) => b.composite - a.composite); // leaderboard order
  });

  app.get("/api/learners/:id", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const evs = await evidence.forLearner(id);
    if (!evs.length) return reply.code(404).send({ error: "no evidence for learner" });
    const cleared = await operatorActions.clearedIntegrityFor(id);
    const m = measurement.compute(id, evs, { asOf: asOfFrom(q), clearedIntegrity: cleared });
    const decisions = [...cleared].map((c) => ({ competency_id: c, decision: "cleared" }));
    return { ...m, evidence: evs, integrity_decisions: decisions };
  });

  // ---- Operator actions (task #5) — make the Cockpit act, not just read ----
  app.post("/api/learners/:id/integrity/:competency", async (req, reply) => {
    if (await deny(req, reply, "assess")) return;
    const { id, competency } = req.params as { id: string; competency: string };
    const { decision, operator = "operator", note } = (req.body ?? {}) as { decision?: string; operator?: string; note?: string };
    if (decision !== "cleared" && decision !== "upheld") {
      return reply.code(400).send({ error: "decision must be 'cleared' or 'upheld'" });
    }
    const evs = await evidence.forLearner(id);
    if (!evs.some((e) => e.competency_id === competency)) {
      return reply.code(404).send({ error: "no evidence for that learner/competency" });
    }
    const action = await operatorActions.record({
      type: "integrity", target_id: `${id}:${competency}`, learner_id: id, competency_id: competency, decision, operator, note,
    });
    return reply.code(201).send(action);
  });

  app.post("/api/transactions/:id/resolve", async (req, reply) => {
    if (await deny(req, reply, "assess")) return;
    const { id } = req.params as { id: string };
    const { decision, operator = "operator", note } = (req.body ?? {}) as { decision?: string; operator?: string; note?: string };
    if (decision !== "acknowledged" && decision !== "overridden") {
      return reply.code(400).send({ error: "decision must be 'acknowledged' or 'overridden'" });
    }
    const tx = await ledger.get(id);
    if (!tx) return reply.code(404).send({ error: "transaction not found" });
    const action = await operatorActions.record({ type: "escalation", target_id: id, learner_id: tx.subject_id, decision, operator, note });
    return reply.code(201).send(action);
  });

  app.get("/api/actions", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    return operatorActions.all();
  });

  // ================= Agent Studio =================

  // Agents list with per-agent config + attached resources + ledger stats.
  app.get("/api/agents", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const txs = await ledger.list({ limit: 500 });
    return Promise.all(Object.values(agents).map(async (a) => {
      const mine = txs.filter((t) => t.agent.name === a.name);
      const n = mine.length || 1;
      return {
        name: a.name, version: a.version, tier: a.tier,
        guardrail_policy: a.guardrailPolicy, critic_policy: a.criticPolicy,
        transactions: mine.length,
        total_usd: round6(mine.reduce((s, t) => s + t.cost.total_usd, 0)),
        avg_ms: Math.round(mine.reduce((s, t) => s + (t.cost.total_ms ?? 0), 0) / n),
        completed: mine.filter((t) => t.status === "completed").length,
        revised: mine.filter((t) => t.status === "revised").length,
        escalated: mine.filter((t) => t.status === "escalated").length,
        blocked: mine.filter((t) => t.status === "blocked").length,
        success_rate: mine.length ? +(mine.filter((t) => t.status === "completed" || t.status === "revised").length / mine.length).toFixed(3) : null,
        attached_kbs: await resources.agentKbIds(a.name),
        attached_guardrail_sets: await resources.agentGuardrailSetIds(a.name),
      };
    }));
  });

  app.get("/api/agents/:name", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { name } = req.params as { name: string };
    const a = agents[name];
    if (!a) return reply.code(404).send({ error: "unknown agent" });
    const recent = await ledger.list({ agent: name, limit: 25 });
    const override = await resources.latestPrompt(name);
    return {
      name: a.name, version: a.version, tier: a.tier,
      guardrail_policy: a.guardrailPolicy, critic_policy: a.criticPolicy,
      system_prompt: override?.prompt ?? a.systemPrompt,   // effective prompt
      prompt_default: a.systemPrompt,                       // the file seed
      prompt_overridden: !!override,
      prompt_version: override?.version ?? null,
      attached_kbs: await resources.agentKbIds(name),
      attached_guardrail_sets: await resources.agentGuardrailSetIds(name),
      recent_transactions: recent.map((t) => ({ transaction_id: t.transaction_id, timestamp: t.timestamp, subject_id: t.subject_id, status: t.status, verdict: t.critique.verdict, total_usd: t.cost.total_usd })),
    };
  });

  // Edit the prompt (versioned override wins over the file default at run time).
  app.put("/api/agents/:name/prompt", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { prompt, author = "operator" } = (req.body ?? {}) as { prompt?: string; author?: string };
    if (!prompt || !prompt.trim()) return reply.code(400).send({ error: "prompt is required" });
    return reply.code(201).send(await resources.savePrompt(name, prompt, author));
  });
  app.get("/api/agents/:name/prompt/versions", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    return resources.promptVersions((req.params as { name: string }).name);
  });
  // Reset to the built-in file prompt (clears all overrides).
  app.delete("/api/agents/:name/prompt", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await resources.clearPrompts((req.params as { name: string }).name);
    return { ok: true };
  });

  // Playground: run an agent as if messaging on a chosen learner's behalf. Never sends WhatsApp.
  app.post("/api/agents/:name/test", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { subject = "test-user", text } = (req.body ?? {}) as { subject?: string; text?: string };
    if (!text) return reply.code(400).send({ error: "text is required" });
    const { tx, retrieved } = await dailyLoop.runAgent(name, subject, text, { baseSources: ["studio-playground"] });
    return { transaction: tx, retrieved };
  });

  // ---- RAG: knowledge bases (standalone, attachable) ----
  app.get("/api/rag/kbs", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const kbs = await resources.listKBs();
    return Promise.all(kbs.map(async (kb) => ({
      ...kb, doc_count: (await resources.listDocs(kb.kb_id)).length,
      attached_agents: await resources.agentsForResource("kb", kb.kb_id),
    })));
  });
  app.post("/api/rag/kbs", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name, description } = (req.body ?? {}) as { name?: string; description?: string };
    if (!name) return reply.code(400).send({ error: "name is required" });
    return reply.code(201).send(await resources.createKB(name, description));
  });
  app.get("/api/rag/kbs/:id", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const { id } = req.params as { id: string };
    const kb = await resources.getKB(id);
    if (!kb) return reply.code(404).send({ error: "not found" });
    return { ...kb, documents: await resources.listDocs(id), attached_agents: await resources.agentsForResource("kb", id) };
  });
  app.delete("/api/rag/kbs/:id", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await resources.deleteKB((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/rag/kbs/:id/docs", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { id } = req.params as { id: string };
    const { title, content } = (req.body ?? {}) as { title?: string; content?: string };
    if (!title || !content) return reply.code(400).send({ error: "title and content are required" });
    return reply.code(201).send(await resources.addDoc(id, title, content));
  });
  app.delete("/api/rag/docs/:docId", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await resources.deleteDoc((req.params as { docId: string }).docId);
    return { ok: true };
  });
  app.post("/api/rag/retrieve", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { agent, query } = (req.body ?? {}) as { agent?: string; query?: string };
    return resources.retrieve(agent ?? "", query ?? "", 5);
  });

  // ---- Guardrails: plain-English rules (LLM-enforced) + sets, both attachable ----
  app.get("/api/guardrails/catalog", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const rules = await ruleCatalog();
    return { rules, all_rule_ids: rules.map((r) => r.rule_id) };
  });
  // Create a NEW rule by typing a sentence — no code (answers "how do I create new").
  app.post("/api/guardrails/rules", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name, description, severity = "block" } = (req.body ?? {}) as { name?: string; description?: string; severity?: string };
    if (!name || !description) return reply.code(400).send({ error: "name and description (the plain-English rule) are required" });
    if (!["block", "escalate", "warn"].includes(severity)) return reply.code(400).send({ error: "severity must be block|escalate|warn" });
    return reply.code(201).send(await resources.createRule(name, description, severity as "block" | "escalate" | "warn"));
  });
  app.delete("/api/guardrails/rules/:id", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await resources.deleteRule((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/api/guardrails/sets", async (req, reply) => {
    if (await deny(req, reply, "viewOperator")) return;
    const sets = await resources.listGuardrailSets();
    return Promise.all(sets.map(async (s) => ({ ...s, attached_agents: await resources.agentsForResource("guardrail", s.gr_id) })));
  });
  app.post("/api/guardrails/sets", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name, rule_ids, description } = (req.body ?? {}) as { name?: string; rule_ids?: string[]; description?: string };
    if (!name || !Array.isArray(rule_ids) || !rule_ids.length) return reply.code(400).send({ error: "name and non-empty rule_ids are required" });
    const known = new Set((await ruleCatalog()).map((r) => r.rule_id));
    const unknown = rule_ids.filter((r) => !known.has(r));
    if (unknown.length) return reply.code(400).send({ error: `unknown rule ids: ${unknown.join(", ")}` });
    return reply.code(201).send(await resources.createGuardrailSet(name, rule_ids, description));
  });
  app.delete("/api/guardrails/sets/:id", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    await resources.deleteGuardrailSet((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- Attach / detach a resource to an agent (many-to-many) ----
  app.post("/api/agents/:name/resources", async (req, reply) => {
    if (await deny(req, reply, "configureAgents")) return;
    const { name } = req.params as { name: string };
    if (!agents[name]) return reply.code(404).send({ error: "unknown agent" });
    const { type, resource_id, action = "attach" } = (req.body ?? {}) as { type?: "kb" | "guardrail"; resource_id?: string; action?: "attach" | "detach" };
    if (type !== "kb" && type !== "guardrail") return reply.code(400).send({ error: "type must be 'kb' or 'guardrail'" });
    if (!resource_id) return reply.code(400).send({ error: "resource_id is required" });
    if (action === "detach") await resources.detach(name, type, resource_id);
    else await resources.attach(name, type, resource_id);
    return { ok: true, action, agent: name, type, resource_id };
  });

  // ---- Public landing page (learner signup) + Cockpit SPA ----
  if (fs.existsSync(path.join(settings.dashboardDir, "index.html"))) {
    // index:false keeps "/" unclaimed by the static plugin so the landing page can own it.
    // Without it, fastify-static answers "/" with the console shell and the route below
    // would collide.
    await app.register(fastifyStatic, { root: settings.dashboardDir, wildcard: false, index: false });
    // The public front door is the brand landing page. The operator console lives under
    // /app so a student typing the bare domain never lands in the internal cockpit.
    const landing = (_req: unknown, reply: any) => reply.type("text/html").sendFile("join.html");
    app.get("/", landing);
    app.get("/join", landing);
    app.get("/start", landing);
    // SPA fallback: unmatched GET routes render the operator console, whose router is
    // mounted at basename "/app".
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/webhooks")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info(`dashboard: serving ${settings.dashboardDir} (landing at /, console at /app)`);
  }

  // ---- 11za inbound webhook (ADR-005) → daily loop → executor ----
  app.post("/webhooks/11za", async (req, reply) => {
    // FAIL CLOSED. This endpoint drives real LLM spend, so an unauthenticated
    // caller is an unbounded cost (and data) exposure. Refuse to serve it in
    // production unless a secret is actually configured.
    if (!settings.wa.webhookSecret) {
      if (settings.env === "production") {
        req.log.error("11za webhook called but WA_WEBHOOK_SECRET is unset — refusing (fail closed)");
        return reply.code(503).send({ error: "webhook not configured" });
      }
      req.log.warn("WA_WEBHOOK_SECRET unset — webhook is UNAUTHENTICATED (allowed in non-production only)");
    } else {
      /*
       * Accept the secret as a header OR a query param. 11za's webhook config only
       * takes a URL — there is no field for a custom header — so header-only auth
       * would reject every real inbound message. The query-param form keeps the
       * secret out of the request body but it does land in access logs, which is
       * the tradeoff the platform forces.
       */
      const presented = ((req.headers["x-webhook-secret"] as string) ?? "")
        || ((req.query as Record<string, string | undefined>)?.secret ?? "");
      if (!timingSafeEqualStr(presented, settings.wa.webhookSecret)) {
        req.log.warn("11za inbound rejected: bad or missing webhook secret");
        return reply.code(401).send({ error: "bad webhook secret" });
      }
    }
    // Accept the common shapes: {from,text} | {phone,message} | {sender,body}. Confirm exact 11za payload later.
    const b = (req.body ?? {}) as Record<string, string>;
    const from = b.from ?? b.phone ?? b.sender ?? "";
    const text = b.text ?? b.message ?? b.body ?? "";
    // Media lands under provider-specific keys; accept the plausible ones.
    const mediaUrl = b.mediaUrl ?? b.media_url ?? b.myfile ?? b.fileUrl ?? b.file_url ?? b.attachment ?? b.image ?? b.document ?? "";
    if (!from || (!text && !mediaUrl)) {
      req.log.warn({ payload: req.body }, "11za inbound: unrecognized payload shape");
      return { received: true, routed: false };
    }
    // Resolve the sender to the SAME learner id the signup funnel minted (lrn-<e164>).
    // 11za sends whatever the handset presents ("+91 98765 43210", "919876543210", ...);
    // walking the journey under that raw string would fork a second identity for the
    // same person and silently re-enrol them, orphaning whatever the coach enrolled.
    const normalized = normalizePhone(from);
    const learnerId = normalized ? `lrn-${normalized}` : from;
    dailyLoop.touch(learnerId);

    // A document (CV / Aadhaar) goes to the Onboarding agent, not the lesson walker.
    // Deliberately no URL or filename in the log line — it's an identity document.
    if (mediaUrl) {
      const r = await onboarding.processInboundMedia({
        learnerId, mediaUrl, filename: b.fileName ?? b.filename, caption: text || b.caption,
      });
      if (r.reply) {
        const sent = await wa.sendText(from, r.reply);
        if (!sent.ok && !sent.stub) req.log.warn(`wa send failed for ${from}`);
      }
      req.log.info({ from, learnerId, kind: r.kind ?? "unknown" }, "11za inbound document processed");
      return { received: true, routed: true, document: r.kind ?? "unknown" };
    }

    // Route through the LMS journey walker (serve lesson / grade / advance / advise).
    const result = await learning.onMessage(learnerId, text);
    if (result.reply) {
      const sent = await wa.sendText(from, result.reply); // reply to the handset, not the id
      if (!sent.ok && !sent.stub) req.log.warn(`wa send failed for ${from}: ${sent.detail}`);
    }
    req.log.info({ from, learnerId, served: result.served_lesson_id, graded: result.graded, done: result.done }, "11za inbound walked");
    return { received: true, routed: true, served_lesson_id: result.served_lesson_id, graded: result.graded, done: result.done };
  });

  // ---- Dev: simulate an inbound learner message (no 11za needed) ----
  // Gated by its own explicit flag. It must never become reachable as a side
  // effect of some unrelated setting — it drives real LLM spend with no auth.
  if (settings.enableDevRoutes) {
    app.post("/api/dev/simulate-inbound", async (req) => {
      const { learner = "priya-sharma", text = "START" } = (req.body ?? {}) as { learner?: string; text?: string };
      return learning.onMessage(learner, text);
    });
    app.log.warn("dev routes ENABLED (/api/dev/*) — unauthenticated; do not enable in production");
  }

  await app.listen({ port: settings.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

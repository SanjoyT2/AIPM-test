/**
 * Seeds the ledger with realistic demo transactions so the Cockpit dashboard has
 * something to show. Usage: start the service, then `npm run seed`.
 * Idempotent-ish: duplicate ids are rejected 409 and skipped.
 */
const BASE = process.env.SEED_TARGET ?? "http://localhost:8000";

const learners = ["priya-sharma", "arjun-verma", "meena-iyer", "rahul-jain"];
const day = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 7, h - 5, m - 30)).toISOString(); // IST -> UTC

type Tx = Record<string, unknown>;
const txs: Tx[] = [];

// --- Trainer: daily lessons + task grading (formative, cheap, sampled critique) ---
learners.forEach((l, i) => {
  txs.push({
    transaction_id: `tx-trainer-${l}`,
    timestamp: day(7, 30 + i),
    subject_id: l,
    agent: { name: "trainer", version: "0.1.0", role: "actor" },
    plan_ref: { plan_id: `plan-daily-${l}`, step_id: "s1-lesson" },
    output: { lesson: "L1 prompting — saree shop catalog case", competency_id: "L1.GENAI.PROMPTING" },
    evidence: {
      sources: ["lesson:L1.GENAI.PROMPTING/day3", `mastery:${l}@0.1.0`],
      reasoning_summary: "Learner failed 2 quizzes on prompt structure; revisiting with a shop-floor case.",
      confidence: 0.9, framework_version: "0.1.0",
    },
    critique: { policy: "formative", verdict: i === 1 ? "accept" : "skipped_by_policy", revisions: 0,
      ...(i === 1 ? { critics: [{ model: "haiku", verdict: "accept", justification: "Lesson grounded in mastery profile." }] } : {}) },
    guardrails: {
      input: [{ id: "pii_redaction", passed: true, severity: "block" }, { id: "consent_window", passed: true, severity: "block" }],
      output: [{ id: "output_schema", passed: true, severity: "block" }], blocked: false,
    },
    cost: { total_usd: 0.0042, total_tokens: 3600, total_ms: 1900,
      calls: [{ role: "actor", model: "haiku", input_tokens: 2800, output_tokens: 800, usd: 0.0042, ms: 1900 }] },
    status: "completed",
  });
});

// --- Mentor: coaching reply, guardrail catches a near-direct-answer, revised once ---
txs.push({
  transaction_id: "tx-mentor-priya-01",
  timestamp: day(11, 5),
  subject_id: "priya-sharma",
  agent: { name: "mentor", version: "0.1.0", role: "actor" },
  plan_ref: { plan_id: "plan-daily-priya-sharma", step_id: "s2-mentor" },
  output: { reply: "Think about who reads the caption — the owner or the customer? What does each need first?" },
  evidence: {
    sources: ["interaction-history:priya-sharma", "confusion-topic:captions"],
    reasoning_summary: "Coached toward audience-first reasoning without giving the caption answer.",
    confidence: 0.84, framework_version: "0.1.0",
  },
  critique: { policy: "conversational", verdict: "accept", revisions: 1,
    critics: [{ model: "sonnet", verdict: "accept", checks: ["spec_compliance"], justification: "Rewrite removed the direct answer; now coaching." }] },
  guardrails: {
    input: [{ id: "pii_redaction", passed: true, severity: "block" }],
    output: [{ id: "mentor_no_direct_answers", passed: false, severity: "block", detail: "First draft contained the caption text verbatim — revised." },
             { id: "mentor_no_direct_answers", passed: true, severity: "block", detail: "Revision passes." }],
    blocked: false,
  },
  cost: { total_usd: 0.0195, total_tokens: 5200, total_ms: 4100,
    calls: [{ role: "actor", model: "haiku", input_tokens: 1900, output_tokens: 300, usd: 0.0034, ms: 900 },
            { role: "guardrail", model: "haiku", input_tokens: 600, output_tokens: 40, usd: 0.0008, ms: 300 },
            { role: "actor", model: "sonnet", input_tokens: 1700, output_tokens: 260, usd: 0.009, ms: 1700 },
            { role: "critic", model: "sonnet", input_tokens: 600, output_tokens: 140, usd: 0.0063, ms: 1200 }] },
  status: "revised",
});

// --- Examiner: Gate 1 summative — 2-critic panel, evidence events emitted ---
txs.push({
  transaction_id: "tx-examiner-priya-gate1",
  timestamp: day(14, 0),
  subject_id: "priya-sharma",
  agent: { name: "examiner", version: "0.1.0", role: "actor" },
  plan_ref: { plan_id: "plan-gate1-priya-sharma", step_id: "s3-score", workflow_id: "wf-priya-lifecycle" },
  output: { gate: "GATE_1", score: 78, pass: true, criteria: { "XC.COMMUNICATION": 82, "XC.OBJECTION": 75, "L1.GENAI.MODEL_JUDGMENT": 74, "XC.INTEGRITY": 80 } },
  evidence: {
    sources: ["rubric:gate-1-roleplay@0.1.0", "roleplay-transcript:rp-priya-gate1", "persona:sceptical-gujarati-wholesaler"],
    reasoning_summary: "Objection handling calm, no fabrication; model judgment slightly generic on limits.",
    confidence: 0.81, framework_version: "0.1.0", rubric_version: "0.1.0",
  },
  critique: { policy: "summative", verdict: "accept", revisions: 0,
    critics: [
      { model: "sonnet", verdict: "accept", checks: ["rubric_fidelity", "grounding"], justification: "Scores match anchors; transcript supports them." },
      { model: "sonnet", verdict: "accept", checks: ["refutation"], justification: "Attempted refutation failed — scoring holds." },
    ] },
  guardrails: {
    input: [{ id: "examiner_calibration_required", passed: true, severity: "block", detail: "rubric 0.1.0 calibration cal-001" }],
    output: [{ id: "no_unversioned_score", passed: true, severity: "block" }, { id: "grounding", passed: true, severity: "block" }],
    blocked: false,
  },
  cost: { total_usd: 0.112, total_tokens: 21400, total_ms: 12800,
    calls: [{ role: "actor", model: "sonnet", input_tokens: 6800, output_tokens: 1900, usd: 0.049, ms: 5200 },
            { role: "actor", model: "sonnet", input_tokens: 4200, output_tokens: 800, usd: 0.0246, ms: 2900 },
            { role: "critic", model: "sonnet", input_tokens: 3600, output_tokens: 500, usd: 0.0183, ms: 2400 },
            { role: "critic", model: "sonnet", input_tokens: 4000, output_tokens: 420, usd: 0.0183, ms: 2300 }] },
  status: "completed",
  links: { evidence_events_emitted: ["ev-priya-gate1-comm", "ev-priya-gate1-objection", "ev-priya-gate1-judgment", "ev-priya-gate1-integrity"] },
});

// --- Examiner: borderline gate — critics split → escalated to operator ---
txs.push({
  transaction_id: "tx-examiner-rahul-gate1",
  timestamp: day(14, 40),
  subject_id: "rahul-jain",
  agent: { name: "examiner", version: "0.1.0", role: "actor" },
  plan_ref: { plan_id: "plan-gate1-rahul-jain", step_id: "s3-score", workflow_id: "wf-rahul-lifecycle" },
  output: { gate: "GATE_1", score: 61, pass: null, note: "borderline — human review" },
  evidence: {
    sources: ["rubric:gate-1-roleplay@0.1.0", "roleplay-transcript:rp-rahul-gate1", "async-vs-sync:delta=24"],
    reasoning_summary: "Live explanation much weaker than async quiz record; possible integrity mismatch.",
    confidence: 0.55, framework_version: "0.1.0", rubric_version: "0.1.0",
  },
  critique: { policy: "summative", verdict: "escalate", revisions: 0,
    critics: [
      { model: "sonnet", verdict: "accept", justification: "Score defensible per anchors." },
      { model: "sonnet", verdict: "escalate", checks: ["refutation"], justification: "Async-sync delta 24 exceeds review threshold 20 — human must decide." },
    ] },
  guardrails: {
    input: [{ id: "examiner_calibration_required", passed: true, severity: "block" }],
    output: [{ id: "no_unversioned_score", passed: true, severity: "block" }], blocked: false,
  },
  cost: { total_usd: 0.094, total_tokens: 18200, total_ms: 11600,
    calls: [{ role: "actor", model: "sonnet", input_tokens: 6100, output_tokens: 1500, usd: 0.0408, ms: 5000 },
            { role: "critic", model: "sonnet", input_tokens: 3900, output_tokens: 600, usd: 0.0207, ms: 2600 },
            { role: "critic", model: "sonnet", input_tokens: 5300, output_tokens: 800, usd: 0.0279, ms: 2900 }] },
  status: "escalated",
});

// --- Motivator: out-of-window proactive send BLOCKED by consent_window guardrail ---
txs.push({
  transaction_id: "tx-motivator-meena-01",
  timestamp: day(18, 15),
  subject_id: "meena-iyer",
  agent: { name: "motivator", version: "0.1.0", role: "actor" },
  plan_ref: { plan_id: "plan-silence-meena-iyer", step_id: "s1-nudge" },
  output: { intent: "day-2 warm nudge", disposition: "held — template required" },
  evidence: {
    sources: ["activity-log:meena-iyer", "window-state:closed@2026-07-06T14:02Z"],
    reasoning_summary: "Learner inactive 2 days; free-form nudge attempted but window is closed.",
    confidence: 0.95, framework_version: "0.1.0",
  },
  critique: { policy: "conversational", verdict: "skipped_by_policy", revisions: 0 },
  guardrails: {
    input: [{ id: "consent_window", passed: false, severity: "block", detail: "24h window closed — must use approved template nudge_day2" }],
    blocked: true,
  },
  cost: { total_usd: 0.0006, total_tokens: 450, total_ms: 240,
    calls: [{ role: "guardrail", model: "haiku", input_tokens: 400, output_tokens: 50, usd: 0.0006, ms: 240 }] },
  status: "blocked",
});

// --- Planner: micro-plan for gate day (plan-and-act) ---
txs.push({
  transaction_id: "tx-planner-gate1-priya",
  timestamp: day(13, 45),
  subject_id: "priya-sharma",
  agent: { name: "planner", version: "0.1.0", role: "planner" },
  plan_ref: { plan_id: "plan-gate1-priya-sharma", step_id: "s0-plan", workflow_id: "wf-priya-lifecycle" },
  output: { steps: ["s1-load-rubric", "s2-roleplay", "s3-score", "s4-emit-evidence", "s5-leaderboard"] },
  evidence: {
    sources: ["progression-rules@0.1.0:gates.GATE_1", "learner-record:priya-sharma"],
    reasoning_summary: "L2 complete + trainer readiness flag → Gate 1 micro-plan per progression rules.",
    confidence: 0.97, framework_version: "0.1.0",
  },
  critique: { policy: "planning", verdict: "accept", revisions: 0,
    critics: [{ model: "sonnet", verdict: "accept", checks: ["consistency"], justification: "Steps complete, budgets set, DAG valid." }] },
  guardrails: { input: [{ id: "input_schema", passed: true, severity: "block" }], output: [{ id: "output_schema", passed: true, severity: "block" }], blocked: false },
  cost: { total_usd: 0.0231, total_tokens: 4900, total_ms: 3400,
    calls: [{ role: "actor", model: "sonnet", input_tokens: 2600, output_tokens: 500, usd: 0.0153, ms: 2100 },
            { role: "critic", model: "sonnet", input_tokens: 1500, output_tokens: 300, usd: 0.0078, ms: 1300 }] },
  status: "completed",
});

async function main() {
  let ok = 0, skip = 0, fail = 0;
  for (const tx of txs) {
    const r = await fetch(`${BASE}/api/transactions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tx),
    });
    if (r.status === 201) ok++;
    else if (r.status === 409) skip++;
    else { fail++; console.error(tx.transaction_id, r.status, await r.text()); }
  }
  console.log(`seeded: ${ok} created, ${skip} already present, ${fail} failed`);
  if (fail) process.exit(1);
}
main();

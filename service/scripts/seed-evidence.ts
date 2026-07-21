/**
 * Seeds domain evidence events (the Learner Record Store) so the Learners view
 * and the measurement engine have real data to roll up. Run after seed.ts.
 *
 * Designed to exercise the measurement engine's edges:
 *  - priya: strong across the board -> high composite, clean integrity
 *  - arjun: solid, mid
 *  - meena: weak/thin evidence -> low composite, below thresholds
 *  - rahul: strong async (quiz/task) but weak sync (gate viva) -> integrity flag
 */
const BASE = process.env.SEED_TARGET ?? "http://localhost:8000";

type Ev = Record<string, unknown>;
const evs: Ev[] = [];
let n = 0;

// Day offsets back from a fixed reference so recency decay is deterministic-ish
// relative to "now"; the API's asOf handles exact reproducibility.
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function ev(
  learner: string, comp: string, activity: string, modality: string, stakes: string,
  score: number, daysAgo: number, deltaTag?: string,
) {
  evs.push({
    event_id: `ev-${learner}-${comp}-${activity}-${n++}`,
    learner_id: learner,
    timestamp: iso(daysAgo),
    source: activity === "gate_viva" ? "examiner" : activity === "quiz" || activity === "task" ? "trainer" : "peer_mentor",
    competency_id: comp,
    activity_type: activity,
    modality,
    stakes,
    score,
    scale_max: 100,
    grader: { type: activity === "quiz" ? "deterministic" : "llm", model: activity === "gate_viva" ? "gpt-4o" : "gpt-4o-mini" },
    framework_version: "0.1.0",
    ...(activity === "gate_viva" ? { rubric_version: "0.1.0", calibration_id: "cal-001" } : {}),
    ...(deltaTag ? { integrity: { flags: [deltaTag] } } : {}),
  });
}

// priya — strong, consistent async & sync
["L1.GENAI.PROMPTING", "L1.GENAI.MODEL_JUDGMENT", "L2.CLAUDE.WORKFLOWS", "XC.COMMUNICATION", "XC.OBJECTION"].forEach((c, i) => {
  ev("priya-sharma", c, "quiz", "async", "formative", 82 + (i % 3) * 4, 18 - i);
  ev("priya-sharma", c, "task", "async", "formative", 80 + (i % 4) * 3, 12 - i);
  ev("priya-sharma", c, "gate_viva", "sync", "summative", 78 + (i % 3) * 5, 3);
});
ev("priya-sharma", "L2.CLAUDE.WORKFLOWS", "peer_review", "async", "formative", 88, 6);
ev("priya-sharma", "XC.COMMUNICATION", "live_session", "sync", "formative", 84, 5);

// arjun — solid middle
["L1.GENAI.PROMPTING", "L1.GENAI.MODEL_JUDGMENT", "L2.CLAUDE.WORKFLOWS", "XC.COMMUNICATION"].forEach((c, i) => {
  ev("arjun-verma", c, "quiz", "async", "formative", 70 + (i % 3) * 4, 15 - i);
  ev("arjun-verma", c, "task", "async", "formative", 68 + (i % 3) * 5, 9 - i);
  ev("arjun-verma", c, "gate_viva", "sync", "summative", 69 + (i % 2) * 6, 3);
});
ev("arjun-verma", "L1.GENAI.PROMPTING", "live_session", "sync", "formative", 72, 4);

// meena — thin, weak evidence, below thresholds
["L1.GENAI.PROMPTING", "L1.GENAI.MODEL_JUDGMENT"].forEach((c, i) => {
  ev("meena-iyer", c, "quiz", "async", "formative", 52 + i * 6, 8 - i);
  ev("meena-iyer", c, "task", "async", "formative", 48 + i * 5, 4);
});

// rahul — INTEGRITY CASE: strong async, weak sync on the same competencies
["L1.GENAI.PROMPTING", "L2.CLAUDE.WORKFLOWS", "XC.COMMUNICATION"].forEach((c, i) => {
  ev("rahul-jain", c, "quiz", "async", "formative", 88 + (i % 2) * 4, 16 - i);       // looks great on paper
  ev("rahul-jain", c, "task", "async", "formative", 85 + (i % 3) * 3, 10 - i);
  ev("rahul-jain", c, "gate_viva", "sync", "summative", 58 + (i % 2) * 4, 3, "async-sync-mismatch"); // can't explain live
});

async function main() {
  let ok = 0, fail = 0;
  for (const e of evs) {
    const r = await fetch(`${BASE}/api/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e),
    });
    if (r.status === 201) ok++;
    else { fail++; console.error(e.event_id, r.status, await r.text()); }
  }
  console.log(`evidence seeded: ${ok} created, ${fail} failed`);
  if (fail) process.exit(1);
}
main();

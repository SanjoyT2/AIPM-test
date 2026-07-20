/**
 * Verifies the ledger's Postgres schema against REAL Postgres semantics.
 *
 * Uses PGlite (Postgres 16 compiled to WASM), so constraints like generated-column
 * immutability are enforced exactly as they would be on Render — no Docker needed.
 *
 * Run: npm run verify:postgres
 */
import { PGlite } from "@electric-sql/pglite";

const LIVE_DDL = `
CREATE TABLE IF NOT EXISTS agent_transactions (
  transaction_id TEXT PRIMARY KEY,
  doc            JSONB NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  agent_name     TEXT    GENERATED ALWAYS AS (doc->'agent'->>'name') STORED,
  subject_id     TEXT    GENERATED ALWAYS AS (doc->>'subject_id') STORED,
  plan_id        TEXT    GENERATED ALWAYS AS (doc->'plan_ref'->>'plan_id') STORED,
  status         TEXT    GENERATED ALWAYS AS (doc->>'status') STORED,
  total_usd      NUMERIC GENERATED ALWAYS AS ((doc->'cost'->>'total_usd')::numeric) STORED
);
CREATE INDEX IF NOT EXISTS idx_tx_agent   ON agent_transactions (agent_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tx_subject ON agent_transactions (subject_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tx_plan    ON agent_transactions (plan_id);
CREATE INDEX IF NOT EXISTS idx_tx_ts      ON agent_transactions (ts DESC);
`;

// The pre-fix version — kept so the regression stays proven, not just claimed.
const OLD_BROKEN_DDL = `
CREATE TABLE broken_check (
  transaction_id TEXT PRIMARY KEY,
  doc            JSONB NOT NULL,
  ts             TIMESTAMPTZ GENERATED ALWAYS AS ((doc->>'timestamp')::timestamptz) STORED
);
`;

const tx = (id: string, agent: string, subject: string, status: string, usd: number, iso: string) => ({
  transaction_id: id,
  timestamp: iso,
  subject_id: subject,
  agent: { name: agent, version: "0.1.0", role: "actor" },
  plan_ref: { plan_id: `plan-${subject}`, step_id: "s1" },
  output: { text: "ok" },
  evidence: { sources: ["s"], reasoning_summary: "r" },
  critique: { verdict: "accept" },
  guardrails: { blocked: false },
  cost: { total_usd: usd, total_tokens: 100, calls: [{ role: "actor", model: "gpt-4o-mini", usd }] },
  status,
});

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const db = new PGlite();

console.log("\n1. Regression: the old generated-column DDL must be REJECTED");
try {
  await db.exec(OLD_BROKEN_DDL);
  check("old DDL rejected by Postgres", false, "it was accepted — the bug may not be what we thought");
} catch (e) {
  const msg = (e as Error).message;
  check("old DDL rejected by Postgres", /immutable/i.test(msg), msg.split("\n")[0]);
}

console.log("\n2. Live DDL applies cleanly");
try {
  await db.exec(LIVE_DDL);
  check("live DDL applied", true);
} catch (e) {
  check("live DDL applied", false, (e as Error).message);
}

console.log("\n3. Insert + generated column projection");
const rows = [
  tx("tx-a", "examiner", "priya", "escalated", 0.094, "2026-07-07T14:40:00Z"),
  tx("tx-b", "trainer", "priya", "completed", 0.0042, "2026-07-07T07:30:00Z"),
  tx("tx-c", "trainer", "meena", "completed", 0.0042, "2026-07-08T07:30:00Z"),
  tx("tx-d", "motivator", "meena", "blocked", 0.0006, "2026-07-06T18:15:00Z"),
];
for (const r of rows) {
  await db.query("INSERT INTO agent_transactions (transaction_id, doc, ts) VALUES ($1, $2, $3)",
    [r.transaction_id, JSON.stringify(r), r.timestamp]);
}
const proj = await db.query<{ agent_name: string; subject_id: string; status: string; total_usd: string }>(
  "SELECT agent_name, subject_id, status, total_usd FROM agent_transactions WHERE transaction_id = 'tx-a'");
const p = proj.rows[0];
check("agent_name projected", p?.agent_name === "examiner", `got ${p?.agent_name}`);
check("subject_id projected", p?.subject_id === "priya", `got ${p?.subject_id}`);
check("status projected", p?.status === "escalated", `got ${p?.status}`);
check("total_usd projected", Number(p?.total_usd) === 0.094, `got ${p?.total_usd}`);

console.log("\n4. Duplicate transaction_id rejected (append-only integrity)");
try {
  await db.query("INSERT INTO agent_transactions (transaction_id, doc, ts) VALUES ($1, $2, $3)",
    ["tx-a", JSON.stringify(rows[0]), rows[0].timestamp]);
  check("duplicate rejected", false, "insert succeeded — primary key not enforcing");
} catch (e) {
  check("duplicate rejected", /duplicate key/i.test((e as Error).message));
}

console.log("\n5. list() ordering — newest first");
const listed = await db.query<{ transaction_id: string }>(
  "SELECT transaction_id FROM agent_transactions ORDER BY ts DESC LIMIT 10");
check("ordered newest-first", listed.rows[0]?.transaction_id === "tx-c", `first=${listed.rows[0]?.transaction_id}`);

console.log("\n6. list() filtered by agent");
const filtered = await db.query<{ transaction_id: string }>(
  "SELECT transaction_id FROM agent_transactions WHERE agent_name = $1 ORDER BY ts DESC", ["trainer"]);
check("filter by agent returns 2", filtered.rows.length === 2, `got ${filtered.rows.length}`);

console.log("\n7. costRollup() — the cost train query");
const roll = await db.query<{ dimension: string; transactions: number; total_usd: number }>(
  `SELECT COALESCE(agent_name, '(none)') AS dimension,
          COUNT(*)::int AS transactions,
          COALESCE(SUM(total_usd), 0)::float8 AS total_usd
   FROM agent_transactions GROUP BY 1 ORDER BY total_usd DESC`);
check("rollup top agent is examiner", roll.rows[0]?.dimension === "examiner", `got ${roll.rows[0]?.dimension}`);
check("rollup sums trainer to 0.0084", Math.abs((roll.rows.find(r => r.dimension === "trainer")?.total_usd ?? 0) - 0.0084) < 1e-9);
check("rollup total_usd is a number (float8, not string)",
  typeof roll.rows[0]?.total_usd === "number", `got ${typeof roll.rows[0]?.total_usd}`);

console.log("\n8. Round-trip: doc returns as parsed JSON");
const got = await db.query<{ doc: any }>("SELECT doc FROM agent_transactions WHERE transaction_id = 'tx-b'");
check("doc round-trips", got.rows[0]?.doc?.agent?.name === "trainer", `got ${JSON.stringify(got.rows[0]?.doc?.agent)}`);

console.log("\n9. DDL is idempotent (re-runs on every boot)");
try {
  await db.exec(LIVE_DDL);
  check("DDL re-applies cleanly", true);
} catch (e) {
  check("DDL re-applies cleanly", false, (e as Error).message);
}

await db.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

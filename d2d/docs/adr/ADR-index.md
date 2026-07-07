# Architecture Decision Records — Phase 1

Short, durable records of the decisions and *why*. Supersede by adding a new entry, not editing
history.

---

## ADR-001 — Durable workflows over a central Orchestrator agent {#adr-001}

**Decision:** Model the learner lifecycle (4 levels, 3 gates, 90-day clock, warnings, removals)
as a durable workflow (Temporal). Agents are activities the workflow invokes. A lighter
Postgres state-machine + scheduler is acceptable for the first single cohort.

**Why:** The concept's Orchestrator is a synchronous god-object; its own listed failure modes
(bottleneck, stale dashboard, over/under-escalation) are intrinsic to that pattern. A workflow
engine gives "zero drop-throughs / every handover tracked / resumable / auditable" as platform
guarantees. Durable timers are exactly right for the 90-day clock and the silence ladder.

**Residual Orchestrator:** survives only as an off-path **analytics/supervisor** service reading
the event stream (escalation triage, weekly ops report, anomaly detection).

---

## ADR-002 — Formative and summative scoring are separate paths {#adr-002}

**Decision:** Formative (quizzes, tasks, Mentor) = Haiku, single pass, generous, low weight.
Summative (3 gates, composite) = Sonnet, 2-pass, calibrated, fully audited, high weight.

**Why:** One shared path forces a bad trade — formative too expensive or summative too loose.
Stakes differ by orders of magnitude (a task hint vs. a removal / the credential).

---

## ADR-003 — The composite score is deterministic code, never an LLM {#adr-003}

**Decision:** `composite-formula.yaml` drives a pure weighted rollup + integrity multiplier.
Weights sum to 1.0 (schema-validated). No model in the loop.

**Why:** The score gates removals and (later) fees — it must be exact, reproducible, and
explainable to a candidate on appeal. LLM non-determinism is disqualifying here. Same reasoning
applies to progression checks and (later) billing.

---

## ADR-004 — Integrity via async-vs-sync delta; humble in Phase 1 {#adr-004}

**Decision:** Detect "high async score, can't explain live" as a per-competency delta between
async (quiz/task) and sync (live viva) performance. Phase 1 uses **live text/voice viva + human
spot-checks**; real-time video proctoring is deferred.

**Why:** This mismatch is the credential's integrity — the moat. But video ML is heavy and
already beatable by deepfakes; rigor comes from viva *question design*, not surveillance. Ship
the cheap, effective version first.

---

## ADR-005 — WhatsApp behind a BSP adapter; daily loop is learner-initiated {#adr-005}

**Decision:** Wrap 11za in a thin adapter (webhook-in / send-out); keep `window_open` as explicit
state. The daily lesson is pulled by a learner message, not pushed.

**Why:** Avoid vendor lock-in to 11za. The learner-initiated pull keeps the 24h window open for
free and builds a streak habit; the window trick alone can't reach silent learners, so ~4
approved re-engagement templates cover the drop-off ladder.

---

## ADR-006 — Every framework is versioned, editable config {#adr-006}

**Decision:** Competencies, rubrics, weights, timers, templates, prompts all live in
`config/` as versioned YAML/JSON validated by `schema/`. Evidence events record the
`framework_version` and `rubric_version` that produced them. IDs are stable; labels are free to
change.

**Why:** The frameworks *will* change as the program learns. Versioning keeps historical scores
reproducible and supports audit/appeal. A summative rubric edit invalidates its calibration and
must be re-calibrated before it scores anyone.

---

## Open decisions (need input)

- **Competency framework content** — the domain SME must ratify the skills & thresholds in
  `competency-framework.yaml` (current values are a v0.1 strawman).
- **11za capabilities** — confirm inbound webhooks, media (voice/image) support, throughput /
  rate limits, and its actual per-message pricing on top of Meta's.
- **Golden-set owner** — who produces the human-scored calibration set for each summative rubric.
- **DPDP posture** — consent flow, PII retention windows, and whether voice viva is stored or
  transcribed-and-discarded.

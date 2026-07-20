# Phase 1 Architecture — Training & Measurement

## Scope

**In:** Personal Trainer, Personal Mentor, Motivator, Peer Mentor, Live Session Tracker,
Examiner, Leaderboard, and the rank/credential output.

**Out (deferred):** all acquisition (Campaign Planner, Sourcer, Sales Advisor, Selection,
Admission) and the entire DEPLOY / client side (Matchmaker, Concierge, Outcome Tracker,
Billing). Candidates already exist, so intake is a one-time import + a Day-0 diagnostic.

Phase 1 collapses a two-sided marketplace into **one thing: a measurement engine wrapped in
a training loop.**

---

## Layers

| Layer | Responsibility | Phase-1 choice |
|---|---|---|
| **Channel** | WhatsApp in/out, media, voice | 11za, behind a thin **BSP adapter** (don't weld to one vendor) |
| **Journey orchestration** | 4-level / 3-gate progression, 90-day timers, warnings, removals | Durable workflow (Temporal) — or a Postgres state-machine + scheduler for the first cohort. See [ADR-001](adr/ADR-index.md#adr-001). |
| **Agent runtime** | LLM reasoning per task | Stateless workers behind **one LLM gateway** (model routing, prompt versioning, PII redaction, cost metering, eval logging) |
| **Measurement core** | Competency framework, Learner Record Store, mastery model, composite, integrity | The heart of Phase 1 — see [`02-measurement-model.md`](02-measurement-model.md) |
| **Data** | Entities, evidence events, media, RAG | Postgres (OLTP + append-only LRS) · object store (submissions/audio) · vector store (lessons, MSME case bank, mentor context) |
| **Operator view** | Cohort health, at-risk, integrity flags, escalations | Web dashboard (this is the real Phase-1 UI, not the candidate's WhatsApp) |

### Why a workflow engine, not a central "Orchestrator" agent

The concept's Orchestrator is a synchronous god-object whose own listed failure modes are
"becomes a bottleneck… stale dashboard… over/under-escalation." Those are the inherent
symptoms of that pattern. A durable-workflow engine delivers the Orchestrator's *promised*
properties — zero drop-throughs, every handover tracked, resumable, auditable — as **platform
guarantees**. Each learner is a workflow instance; agents are activities the workflow invokes.
The Orchestrator's genuinely useful residual job (escalation triage, weekly ops report,
cross-cohort anomaly detection) survives as an **analytics/supervisor service** that reads the
event stream — off the synchronous path.

---

## Request/decision flow (one day in the life)

```
07:30 IST   Learner sends START (or streak tap)  ──►  opens 24h WhatsApp window
            │
            ├─ Trainer (fast): serves today's lesson, personalized from mastery
            ├─ Learner does reading/video + quiz + hands-on task in-thread
            ├─ Grading:
            │     quiz        → deterministic       → evidence event (formative)
            │     task        → LLM rubric (deep)   → evidence event (formative)
            ├─ Mentor (fast-path → escalate to deep): coaches, never answers
            └─ Motivator: celebrates / nudges (in-window free; out-of-window → template)

Weekly     Live session (Tracker) + Saturday gate (Examiner, 2-pass deep tier, calibrated)
            → summative evidence events

Continuous Leaderboard recomputes composite (deterministic) · Promotion checks thresholds
```

Formative vs. summative are split hard: formative is cheap/fast/generous (fast tier, low weight);
summative is high-stakes/audited/calibrated (deep tier 2-pass). See the measurement doc.

---

## Model routing (behind the LLM gateway)

Tiers are provider-neutral. Each resolves to a concrete model via `MODEL_FAST` / `MODEL_DEEP`
env vars (currently OpenAI `gpt-4o-mini` / `gpt-4o`), priced in `cost-model.yaml`. Swapping
vendor or model generation is a config change, never a code change.

| Use | Tier | Why |
|---|---|---|
| Lesson delivery, FAQ, Mentor fast-path | `fast` | High volume, low latency, cheap |
| Task grading, Mentor escalation, Examiner | `deep` (2-pass on summative) | Judgment + variance control |
| Composite, progression checks, leaderboard | **No LLM** (deterministic code) | Money/fairness-adjacent → must be exact & auditable |

The gateway is the one place that logs every summative call for the eval harness, redacts PII,
and meters cost per learner (so "cost per consultant trending down" is an instrumented number).

---

## The WhatsApp window, handled explicitly

11za rides Meta's Cloud API, where the **24h customer-service window** opens/rolls forward on
each *user* message. Phase-1 design consequences:

- **The daily lesson is learner-initiated (pull).** The learner messaging to unlock the day's
  lesson naturally holds the window open, builds a streak habit, and is itself an engagement
  signal. See [`03-daily-loop.md`](03-daily-loop.md).
- **`window_open(learner)` is explicit state.** Every proactive agent checks it and falls back
  to an approved template (or holds) automatically.
- **Re-engagement of silent learners needs templates** — the window trick fails for exactly the
  drop-off cohort the Motivator targets. ~4 approved templates cover the silence ladder.

---

## Non-functionals to instrument from day one

- **Latency budgets are per-agent, not a blanket "9s."** fast tier FAQ can hit it; deep tier 2-pass
  can't — use instant ack → streamed answer, plus semantic caching of top confusion topics.
- **Audit trail:** every summative decision stores prompt + inputs + output + framework/rubric
  version + model + passes. Required for appeals and for DPDP.
- **Data protection (DPDP Act 2023):** consent ledger, purpose limitation, erasure. Even in
  Phase 1 you store learner PII, submissions, and possibly voice — architect it in, don't bolt
  it on.

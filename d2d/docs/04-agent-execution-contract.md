# The Agent Execution Contract — Output → Evidence → Critique

**The one primitive the whole platform is built on.** Every agent invocation is an
**Agent Transaction**: a single, immutable, fully-attributed record. Requirements 1–5
(evidence, critique, cost, guardrails, plan/act) are not separate systems — they are **fields
on this one record**. If it isn't a transaction, it didn't happen.

Schema: [`../schema/agent-transaction.schema.json`](../schema/agent-transaction.schema.json).

---

## The lifecycle (every agent call, no exceptions)

```
        ┌──────────────────────────────────────────────────────────────────────┐
 plan   │ ① PLAN CONTEXT   which plan / step / subject / inputs                 │
 step   ├──────────────────────────────────────────────────────────────────────┤
   │    │ ② INPUT GUARDRAILS   PII redact · injection scan · schema · consent   │──► block ─┐
   │    ├──────────────────────────────────────────────────────────────────────┤           │
   │    │ ③ ACT (actor LLM)    produce  OUTPUT  +  EVIDENCE                      │           │
   │    │      output   = the result (score, lesson, routing decision …)        │           │
   │    │      evidence = what justifies it (sources, tool calls, reasoning,    │           │
   │    │                 framework/rubric versions, confidence)                │           │
   │    ├──────────────────────────────────────────────────────────────────────┤           │
   │    │ ④ CRITIQUE (critic LLM)   does the evidence support the output?       │           │
   │    │      verdict ∈ accept | revise | reject | escalate                    │           │
   │    │      revise → back to ③ (bounded retries)   escalate → operator queue │           │
   │    ├──────────────────────────────────────────────────────────────────────┤           │
   │    │ ⑤ OUTPUT GUARDRAILS   schema · safety · policy (must-not) · grounding │──► block ─┤
   │    ├──────────────────────────────────────────────────────────────────────┤           │
   │    │ ⑥ COST   sum tokens/USD/latency across ③④⑤ (actor+critic+guardrail)   │           │
   │    ├──────────────────────────────────────────────────────────────────────┤           ▼
   ▼    │ ⑦ EMIT   append transaction to ledger; link plan step + any domain   │      status =
 next   │          evidence_events produced                                    │   blocked/escalated
        └──────────────────────────────────────────────────────────────────────┘
```

Steps ②④⑤ can each stop the transaction. Nothing an agent produces is "accepted" until it has
passed critique **and** output guardrails. That is the quality contract.

---

## ① Evidence — every output must show its work (Requirement 1)

`evidence` is structured, not prose. An unverifiable output is a defect. Minimum:

- `sources[]` — what grounded the output (retrieved lesson, rubric anchor, prior transaction,
  learner submission ref). Empty sources on a factual claim → grounding guardrail fails.
- `tool_calls[]` — every tool/RAG/DB call, with args + result refs.
- `reasoning_summary` — short, auditable "why".
- `framework_version` / `rubric_version` — reproducibility (ties to the measurement model).
- `confidence` — the actor's own calibrated confidence; low confidence auto-routes to critique.

> **Two kinds of "evidence" — don't conflate them.** *Platform evidence* (this field) justifies
> the **agent's** output. *Domain evidence events* (the Learner Record Store) are the **product**
> of some transactions (e.g. an Examiner transaction emits learner evidence events). A transaction
> links to the domain evidence it produced via `evidence_events_emitted[]`.

## ② Critique — validate the evidence and the output (Requirement 2)

A **critic** pass (separate LLM role, or panel) checks the actor's work *before acceptance*:

- Does the evidence actually support the output? (grounding / hallucination)
- Is it within the agent's spec and policy? (e.g. Mentor gave no direct answer)
- Is it internally consistent and complete?

Verdict drives control flow: **accept** → proceed; **revise** → bounded retry with the critique
fed back; **reject** → fail the step; **escalate** → operator queue. Critic intensity is
policy-driven and cost-aware (see below and [`../config/critics.yaml`](../config/critics.yaml)):

| Stakes | Critic policy |
|---|---|
| Summative (gates, composite-affecting) | **Always**, 2 independent critics, majority verdict |
| Routing / planning decisions | Always, single critic (plan validity) |
| Formative (daily task grading, lessons) | **Sampled** (e.g. 15%) + always-on cheap guardrails |
| Mentor / conversational | Guardrail-only fast-path; critic on escalation |

**Cost honesty:** critique roughly doubles LLM spend on a transaction. That's exactly why it's
tied to the formative/summative split — pay for validation where the stakes justify it, sample
where they don't. The cost of every critic call is itself in the transaction's `cost` (Req 3).

---

## Why this shape

- **Adversarial-verify by construction.** The actor is optimistic; the critic is skeptical and
  told to *refute*. Plausible-but-wrong outputs die at step ④ instead of reaching a learner.
- **One record answers every question.** "Why did the agent do that / what did it cost / was it
  safe / who validated it" are all one row. This is what makes the dashboard clickable (Req 6).
- **Uniformity.** Trainer, Examiner, Planner, Motivator — all emit the same envelope. The
  platform (cost, guardrails, dashboards) is written once, not per agent.

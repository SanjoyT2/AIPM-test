# Plan-and-Act — the multi-agent orchestration model (Requirement 5)

We do **not** let agents free-form call each other. Every multi-agent workflow is **planned
first, then executed**, with observation and re-planning between. Three roles:

| Role | Does | Output |
|---|---|---|
| **Planner** | Given a goal + current state, produces an explicit **Plan** (a DAG of steps) | `Plan` ([schema](../schema/plan.schema.json)) |
| **Executor** | Runs each step as one **Agent Transaction** (the contract in doc 04) | transactions |
| **Critic** | Validates the plan (before exec) *and* each transaction (during exec) | verdicts |

The Executor is the durable workflow (ADR-001). The Plan is data — inspectable, versioned, and
clickable in the dashboard. Nothing runs that isn't a step in an approved plan.

```
   GOAL ─►  PLANNER ─►  PLAN (steps s1..sn, each: agent + inputs + output contract
              ▲            + guardrail policy + critic policy + budget)
              │              │
       re-plan│              ▼
              │         EXECUTOR ── for each step ──► AGENT TRANSACTION (doc 04)
              │              │                              │ output + evidence + critique
              │              ▼                              ▼
              └──────── OBSERVE (results, verdicts, flags, cost) ── done? ──► COMPLETE
```

## Plans exist at two altitudes

- **Macro plan — the learner lifecycle.** Long-running (up to 90 days), one instance per
  learner: the level→gate progression, remediation branches, removals. Durable timers drive it.
  Re-planning is real: a learner who fails L2 twice gets a *remediation plan* spliced in.
- **Micro plan — a single complex task.** e.g. "run Gate 1" expands to: load rubric → run
  3-turn roleplay → score each criterion → 2-critic validation → emit evidence events →
  update leaderboard. Each is a transaction; the micro-plan sequences them.

## What a plan step carries (so the platform can enforce it)

Every step declares, up front:
- `agent` + expected `output_contract` (schema the output must satisfy)
- `guardrail_policy` ref → [`../config/guardrails.yaml`](../config/guardrails.yaml)
- `critic_policy` ref → [`../config/critics.yaml`](../config/critics.yaml)
- `budget` → max USD/tokens for the step (a hard ceiling; Req 3)
- `on_fail` → retry | skip | escalate | replan

Because the policy is on the step, the Executor enforces evidence/critique/guardrails/cost
**uniformly** without the agent having to cooperate.

## Re-planning triggers (Observe → Plan)

- Critic **reject/escalate** on a step → replan or route to human.
- Domain signals: repeated gate failure → remediation plan; integrity flag → investigation plan;
  silence-ladder exhaustion → removal plan.
- Budget breach → degrade plan (drop optional critique passes, switch to cheaper model) or halt.

## Why Plan-and-Act over a chat-of-agents

- **Determinism & audit.** The plan is inspectable *before* anything runs and replayable after.
- **Cost predictability.** Steps carry budgets; total spend is boundable ahead of execution.
- **No runaway loops.** Agents can't spawn agents ad hoc; only the Planner adds steps, and the
  workflow caps depth. (The concept's "Orchestrator becomes a bottleneck" failure mode is gone —
  planning is a discrete step, not a synchronous gate on every action.)
- **Human-in-the-loop is a first-class step**, not an exception path.

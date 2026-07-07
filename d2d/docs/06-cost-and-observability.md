# Cost Train & Observability (Requirements 3 & 6)

## The cost train

Every LLM call — actor, **critic, and guardrail** — is metered and attributed. The atomic cost
record is per-call; it rolls up along the same links the work flows through:

```
LLM call (role, model, in/out tokens, USD, ms)
   └─ belongs to → Agent Transaction (doc 04)  ── total cost of one agent action
        └─ belongs to → Plan Step
             └─ belongs to → Workflow / Plan   ── "the cost train": ordered transactions, each costed
                  └─ attributed to → Learner · Agent · Model · Day
```

**"Cost train"** = the ordered chain of transactions in a workflow with cost at every car. You
can read total spend for a learner's 90 days, then click down: which stage cost most → which
transaction → which single LLM call (and whether it was actor, critic, or guardrail overhead).

Config: [`../config/cost-model.yaml`](../config/cost-model.yaml) (editable model prices, budgets,
alert thresholds).

### Every transaction is individually inspectable (your explicit ask)

Because cost is a field on the transaction and calls are itemized in `cost.calls[]`, the UI can
open **any single agent transaction** and show: the output, its evidence, the critic verdict, the
guardrail results, and the exact token/USD/latency of each underlying call. No sampling, no
aggregation-only. Every transaction, drillable.

### Budgets & guardrail integration

- **Per-step budget** (from the plan) is a hard ceiling — exceeding it triggers the cost
  guardrail (halt or degrade). See guardrails doc.
- **Per-learner lifetime cap** and **per-agent daily cap** in `cost-model.yaml`; breaches raise
  an alert card on the dashboard (actionable).
- **Critique overhead is visible by design** — `cost.calls[]` tags each call's `role`, so you can
  literally see what validation costs and tune `critics.yaml` sampling against it.
- **Unit economics come for free:** cost-per-learner and cost-per-graduate are sums over the
  ledger, not a spreadsheet guess. This is the concept's "cost per consultant trending down"
  made into a live number.

---

## Observability = the transaction ledger

The append-only transaction ledger is the single source for cost, quality, and audit. From it we
derive every dashboard view (doc: the dashboard is `../design/dashboard-cockpit.html`):

| View | Reads from ledger | Actionable element |
|---|---|---|
| **Pipeline** | transactions grouped by learner stage | click a stuck learner → their transaction timeline |
| **Escalations** | transactions with verdict=escalate / integrity flags | resolve / uphold buttons |
| **Cost train** | cost rollups by workflow/agent/model | click spend → the calls behind it |
| **Agent health** | critic-reject rate, guardrail-block rate, latency, retries per agent | click a spike → the failing transactions |
| **Quality** | critic verdicts, calibration agreement | click a rubric → its calibration set |

## Dashboard principles (Requirement 6 — action-oriented + everything clickable)

1. **Surface decisions, not charts.** The top of every screen is "what needs a human right now"
   — escalations, integrity flags, budget alerts, stuck learners — each with an action button.
2. **Every datum is a link.** A number is a filtered query; clicking it opens the rows; clicking a
   row opens the transaction; clicking a cost opens the calls; clicking an integrity flag opens the
   async-vs-sync evidence side-by-side. No dead-end numbers.
3. **One human, many agents.** The operator (Anjali) acts by exception. The dashboard's job is to
   rank exceptions by urgency and make each resolvable in one click.
4. **Cockpit theme** (dark navy, electric accent) for the operator surface; Bharat theme for
   anything learner-facing. See brand tokens in the dashboard file.

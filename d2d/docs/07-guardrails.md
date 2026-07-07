# Guardrails (Requirement 4)

Guardrails are **deterministic/policy checks** that run *around* every agent transaction (steps
② and ⑤ of the execution contract). They are distinct from the critic:

- **Guardrail** = fast, rule/ML-based, pass/fail, cheap, runs on **every** transaction.
- **Critic** = LLM judgment on evidence-supports-output quality, costlier, runs by policy.

Both run. Guardrails are the floor; the critic is the quality bar. Config (editable, versioned):
[`../config/guardrails.yaml`](../config/guardrails.yaml).

## Taxonomy

### Input guardrails (step ②)
| Guardrail | Blocks when |
|---|---|
| PII redaction | Aadhaar/PAN/UPI/phone present → redact before it reaches the model (also DPDP) |
| Prompt-injection scan | Learner/client input tries to override agent instructions |
| Input schema | Inputs don't match the step's expected contract |
| Consent / window | `window_open=false` or learner opted out → hold or template-only |

### Output guardrails (step ⑤)
| Guardrail | Blocks when |
|---|---|
| Output schema | Output violates the step's `output_contract` |
| Grounding | Output makes claims the `evidence.sources` don't support (hallucination) |
| Safety | Toxic / unsafe / harmful content |
| PII leak | Output would expose another person's PII (cross-tenant) |
| **Policy (agent must-not)** | The behavioral rules below |

### Behavioral / policy guardrails (the agent "must-not" rules, enforced)
These lift the `must-not` lines from the agent prompts into **runtime-enforced** policy:
- `mentor.no_direct_answers` — Mentor output contains a quiz/task/gate answer → block + revise.
- `examiner.no_coaching_during_gate` — Examiner hints during a gate → block.
- `examiner.calibration_required` — summative score attempted on an uncalibrated rubric → block.
- `global.no_false_promises` — any agent guarantees a job/admission/revenue lift → block + flag.
- `global.no_unversioned_score` — a score without framework/rubric version → block.

### Behavioral / safety-net guardrails
- `cost_ceiling_per_transaction` — transaction exceeds step budget → halt (kill-switch) or degrade.
- `max_retries` — bounded revise loops; exhausted → escalate.
- `escalation_triggers` — distress signals, repeated rejects, integrity delta over threshold →
  operator queue.

## Severity & outcome

Each guardrail declares a severity, which sets the outcome and is recorded on the transaction:

| Severity | Outcome |
|---|---|
| `block` | Transaction cannot complete; revise or fail |
| `escalate` | Route to operator queue with context |
| `warn` | Allowed, but recorded as a violation (shows on agent-health dashboard) |

Every guardrail evaluation — pass or fail — is written to the transaction's `guardrails{}` field,
so the dashboard can show block-rates per agent and you can click any block to see exactly which
rule fired and on what input.

## Where guardrails run

At the **LLM gateway** (doc 01), so they're centralized, versioned, and identical across agents —
no agent can opt out. Adding a guardrail = editing `guardrails.yaml` + bumping its version;
attaching it to agents via `applies_to`.

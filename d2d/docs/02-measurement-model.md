# Measurement Model — how we score candidate effectiveness

This is the priority subsystem. The design goal: a score that is **defensible** — evidence-based,
auditable, calibrated against humans, and resistant to gaming.

## Five components

| Component | File(s) | One-liner |
|---|---|---|
| Competency framework | `config/competency-framework.yaml` | The explicit definition of what "effective" means. |
| Learner Record Store (LRS) | `schema/evidence-event.schema.json` | Append-only log; every activity emits an evidence event. |
| Mastery model | `schema/learner-record.schema.json` | Per-competency estimate rolled up from evidence. |
| Composite + credential | `config/composite-formula.yaml` | **Deterministic** rollup → leaderboard + rank. |
| Integrity layer | evidence event `integrity{}` | The async-vs-sync mismatch detector. |

---

## 1. Competency framework — the prerequisite

Nothing downstream is meaningful without this. It is a **skills graph**: 4 levels, each
decomposed into named, testable competencies, each with a mastery threshold, a weight, and
three rubric anchors (novice / competent / expert). Cross-cutting competencies (communication,
problem-solving, client empathy, delivery reliability) are measured across *all* levels.

Stable IDs (`L1.GENAI.PROMPTING`) link evidence to competencies. Rename labels freely; never
reuse an ID. Edit the framework, bump `version`.

---

## 2. Evidence events — measurement is a rollup, not an opinion

Every quiz, task, peer review, live session, and gate viva emits one or more **evidence events**
into the append-only LRS. An event ties a **signal** to a **competency**, with:

- `stakes`: `formative` (learning; low weight) vs `summative` (gates; high stakes, audited).
- `modality`: `async` (quizzes/tasks — cheatable) vs `sync` (live viva — hard to fake). This is
  what powers the integrity layer.
- `grader`: `deterministic` | `llm` | `human`, plus model + passes for reproducibility.
- `framework_version` + `rubric_version`: so the score is reproducible even after you edit config.
- `evidence_refs`: links to the submission/media, so a human can always re-check.

The LRS **is** the audit trail, the analytics source, and the composite input — one log, three
uses. Pattern is xAPI-style (actor–verb–object).

---

## 3. Formative vs. summative — split hard

| | Formative | Summative |
|---|---|---|
| Who | Trainer quizzes, daily tasks, Mentor | Examiner's 3 gates, the composite |
| Stakes | Learning signal | Removals, the credential, (later) the ₹25K |
| Model | fast tier, single pass, generous | deep tier, 2-pass, calibrated |
| Audit | Light | Full: prompt+inputs+output+versions stored |
| Weight in composite | Low | High |

Running both through one scoring path is the classic mistake — you make formative too
expensive or summative too loose. Keep them separate.

---

## 4. The composite — deterministic, editable weights

`composite-formula.yaml` defines a weighted rollup:

```
base = Σ ( weight[source] × normalized_score[source] )      # weights sum to 1.0 (validated)
       over sources: gate, quiz, peer_review, live_session, engagement
final = base × integrity_multiplier                         # 1.0 clean → lower if unresolved flags
```

No LLM touches this. Weights, the integrity multiplier curve, and gate weighting are all
editable in the YAML. Changing them bumps the formula `version`; leaderboards recompute, but
each historical score still records the version it was computed under.

---

## 5. Integrity layer — the moat, kept humble in Phase 1

A *verifiable* credential lives or dies on catching **"high async score, can't explain it live."**
Architecturally it's a per-competency **delta detector**: for each competency, compare async
performance (quizzes/tasks) against sync performance (live viva). A large negative delta →
integrity flag → the composite's `integrity_multiplier` drops and the case enters the operator's
review queue.

**Phase 1 stays realistic:** live **text/voice** viva on WhatsApp + **human spot-checks** on
flagged deltas. Full real-time video proctoring is deferred — it's a heavy pipeline *and* already
beatable by voice/video deepfakes. The rigor in Phase 1 comes from **viva question design**
(open-ended, "explain your reasoning," novel scenarios the candidate couldn't pre-script), not
from surveillance. Question-design guidance lives in `config/prompts/examiner.md`.

---

## Calibration — do this before any summative score counts {#calibration}

LLM-as-judge decides who advances and who's removed. Before trusting it:

1. **Assemble a golden set** — real submissions scored by a human expert against the same rubric.
2. **Measure agreement** — run the LLM grader over the golden set; compute LLM-vs-human agreement
   (e.g. Cohen's κ / MAE on the 0–100 score). Store as a `calibration_id`.
3. **Tune the rubric** in `config/rubrics/` until agreement clears the bar
   (`progression-rules.yaml → calibration.min_agreement`).
4. **Re-calibrate after every rubric edit.** A summative rubric change invalidates its prior
   calibration; the runtime should refuse to score summatively with an uncalibrated rubric
   version.

Build the eval harness in the same sprint as the Examiner — never ship an unaudited judge.

---

## Day-0 diagnostic

Because Phase 1 drops Selection, there's no seed for Trainer personalization and the cohort is
unfiltered (wide ability range). `config/diagnostic.yaml` defines a short placement test that
writes initial mastery estimates per competency — low-stakes, `formative`, but tagged
`diagnostic` so it's distinguishable from ongoing evidence.

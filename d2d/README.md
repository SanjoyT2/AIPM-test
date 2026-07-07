# D2D AI OS — Phase 1: Training & Measurement

This directory holds the **design and editable configuration** for D2D's Phase 1:
training candidates and **measuring their effectiveness** rigorously enough that the
resulting score/credential means something.

Phase 1 deliberately excludes acquisition (candidates already exist) and the client /
deployment side (deferred). See [`docs/01-phase1-architecture.md`](docs/01-phase1-architecture.md).

---

## The core idea

A training loop wrapped around a **measurement engine**. Everything a candidate does
(quiz, task, peer review, live session, gate viva) emits an **evidence event** into an
append-only Learner Record Store. Mastery and the final composite score are **rolled up
from evidence** — never a vibe, never a single LLM opinion.

```
Daily loop (learner-initiated)  →  Evidence events  →  Mastery model  →  Composite (deterministic)  →  Rank / credential
                                         ↑
                              Integrity layer (async-vs-sync mismatch)
```

---

## Everything here is editable — that is the point

| You want to change… | Edit this | Notes |
|---|---|---|
| What "effective" means (skills, thresholds) | [`config/competency-framework.yaml`](config/competency-framework.yaml) | The single most important file. Validated by `schema/competency-framework.schema.json`. |
| How the final score is weighted | [`config/composite-formula.yaml`](config/composite-formula.yaml) | Weights must sum to 1.0 (validated). Deterministic — no LLM. |
| Timers, warnings, removals, gate placement | [`config/progression-rules.yaml`](config/progression-rules.yaml) | 90-day clock, attendance rules, etc. |
| Day-0 placement test | [`config/diagnostic.yaml`](config/diagnostic.yaml) | Seeds the mastery model (replaces the dropped selection score). |
| How gates/tasks are scored | [`config/rubrics/`](config/rubrics/) | Summative rubrics. Changing these **requires re-calibration** (see below). |
| WhatsApp copy & re-engagement | [`config/templates/whatsapp-templates.yaml`](config/templates/whatsapp-templates.yaml) | Templates need Meta approval before use. |
| What each agent says / how it behaves | [`config/prompts/`](config/prompts/) | Trainer, Mentor, Examiner, Motivator. |

### Two rules that keep editability safe

1. **Bump the `version` when you change a framework.** Every evidence event and score
   records the `framework_version` and `rubric_version` that produced it. Old scores stay
   reproducible; you never silently rewrite history. IDs (e.g. `L1.GENAI.PROMPTING`) are
   stable — rename `name:` freely, never reuse or repurpose an `id:`.

2. **Editing a summative rubric invalidates its calibration.** After changing anything in
   `config/rubrics/`, re-run the golden-set calibration (see
   [`docs/02-measurement-model.md`](docs/02-measurement-model.md#calibration)) before the
   new rubric scores anyone for real. Formative rubrics (task hints, quizzes) are low-stakes
   and don't gate this.

---

## Layout

```
d2d/
  docs/                     # architecture & measurement design (read these first)
    01-phase1-architecture.md
    02-measurement-model.md
    03-daily-loop.md
    adr/ADR-index.md        # the key decisions, with rationale
  config/                   # THE EDITABLE FRAMEWORKS (YAML)
    competency-framework.yaml
    composite-formula.yaml
    progression-rules.yaml
    diagnostic.yaml
    rubrics/
    templates/
    prompts/
  schema/                   # JSON Schemas that validate config + define data records
```

## Status

Phase 1, framework foundation. No runtime yet — this is the spec + config that the runtime
will load. Data-model and stack decisions are in the ADRs.

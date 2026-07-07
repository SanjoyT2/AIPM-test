# The Daily Loop — learner-initiated, window-safe

## Why learner-initiated

The WhatsApp 24h window rolls forward on each **user** message. If we *push* the lesson, we burn
templates and cost, and we still can't reach silent learners. So the day **starts with the
learner messaging us** — which opens the window, builds a streak habit, and gives us a free daily
engagement signal.

```
                         ┌─────────────────────────────────────────────┐
   07:30 IST             │  Learner sends START / 🔥 (streak tap)        │
   (or their own time)   │  → 24h window opens; engagement signal logged │
                         └───────────────────┬─────────────────────────┘
                                             ▼
             ┌───────────────────────────────────────────────────────────┐
             │ Trainer (Haiku): today's lesson, chosen from mastery state │
             │  reading / short video / worked MSME case                  │
             └───────────────────┬───────────────────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ Quiz (deterministic grade)   +   Hands-on task (Sonnet rubric)  │
        │  → evidence events (formative), async modality                  │
        └───────────────────┬────────────────────────────────────────────┘
                            ▼
   Anytime:  Mentor (fast-path Haiku → escalate Sonnet) — coaches, never gives the answer
   Anytime:  Motivator — celebrates milestones / nudges (in-window free; out-of-window template)
```

## Window state machine

`window_open(learner)` is explicit, checked before every proactive send:

```
CLOSED ──(learner message)──► OPEN(expires = now + 24h)
OPEN   ──(learner message)──► OPEN(expires = now + 24h)   # rolls forward
OPEN   ──(24h elapsed)──────► CLOSED
```

| Situation | Action |
|---|---|
| Agent wants to send & window OPEN | Send free-form (non-template). |
| Agent wants to send & window CLOSED | Send an approved template, or hold until next learner message. |
| Learner silent, needs re-engagement | Silence-ladder templates (see `config/templates/whatsapp-templates.yaml`). |

## Silence ladder (drop-off, where the window trick fails)

Driven by `progression-rules.yaml → engagement`:

| Days since last activity | Action | Channel |
|---|---|---|
| 2 | Warm nudge | Template (window likely closed) |
| 3 | Second nudge + streak reminder | Template |
| 5 | Warning (progression risk) | Template |
| 7 | Escalate to operator → likely removal | Operator queue |

All thresholds are editable in config. Templates must be Meta-approved before use.

## Weekly rhythm

- **Mandatory live session** (Zoom/Meet) — Live Session Tracker records attendance +
  participation → sync-modality evidence, and feeds the integrity delta.
- **Saturday gate** (when a level completes) — Examiner runs the summative viva; 2-pass Sonnet,
  calibrated rubric; results → Leaderboard + Promotion check.

## Signals the loop produces (per learner, per day)

- `did_initiate` (opened the window) — engagement.
- Quiz scores (deterministic) + task scores (LLM) — formative evidence.
- Mentor interactions + confusion topics — feeds Trainer personalization.
- Streak length — Motivator + engagement component of composite.

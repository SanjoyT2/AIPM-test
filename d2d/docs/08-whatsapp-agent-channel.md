# 08 — The Agent Fleet over WhatsApp: Channel Analysis

*Written 2026-07-28, after the signup-OTP incident. Status: current as of the
Onboarding agent's document-intake release.*

WhatsApp is the program's only learner-facing channel, and it has one iron rule
that shapes every agent's behavior: **a business may send free-form text only
inside the 24-hour window that the learner's own last message opened. Outside
that window, only Meta-approved templates deliver.** Everything below follows
from that rule.

## The window state machine

- Every inbound learner message rolls their window forward 24h
  (`DailyLoop.touch`) and stamps activity.
- Inside the window: agents converse freely (`sendText`).
- Outside the window: only approved templates (`sendTemplate`) — anything else
  is silently dropped by WhatsApp. **Silently** is what bit the signup funnel:
  the API accepts the message; the handset never shows it.

## Agent-by-agent: how each one reaches (or fails to reach) the learner

| Agent | When it speaks | Channel mode | Template dependency |
|---|---|---|---|
| **Onboarding** | Signup OTP (first contact — no window exists) | Template only | `signup_otp` (**pending operator creation in 11za**) |
| **Onboarding** | CV / Aadhaar intake replies | In-window text (learner just sent the doc) | none |
| **Trainer** | Learner sends START → daily lesson | In-window text | none |
| **Mentor** | Learner asks anything else | In-window text | none |
| **Motivator** | Milestone celebrations | In-window if recent; else template | `milestone_levelup` (draft, not in 11za) |
| **Coach** | Weekly check-in, drift flags | Usually OUTSIDE window | **no template exists — gap** |
| **Examiner** | Saturday gate reminders | Usually OUTSIDE window | `gate_reminder` (draft, not in 11za) |
| **Assessor** | Gate assessments | In-window (learner is mid-gate) | none |
| **Silence ladder** (system) | Day 2 / 3 / 5 inactivity nudges | OUTSIDE window by definition | `nudge_day2`, `nudge_day3_streak`, `warning_day5` (all draft) |

### The structural finding

**Every learner-initiated flow works today; every program-initiated flow is dead
until its template is approved.** The reactive half of the platform (Trainer,
Mentor, Assessor, document intake) needs no templates because the learner opens
the window. The proactive half — the half that fights drop-off, which is the
program's whole retention thesis — depends on templates that exist only as
drafts in `whatsapp-templates.yaml` and have never been created in 11za. The
silence ladder literally cannot deliver a single rung right now: it fires,
11za accepts, WhatsApp drops.

**Recommendation:** when the operator creates `signup_otp` in the 11za
dashboard, create the other five in the same sitting (bodies are in
`whatsapp-templates.yaml`), plus one new `weekly_checkin` template for the
Coach. One dashboard session unblocks the entire proactive fleet. The
Onboarding agent's discovery loop already sees every approved template on the
account (`/api/onboarding/status` lists them), so approval status is visible
from our side the moment Meta grants it.

### Bugs found during this analysis (fixed in the same release)

1. `DailyLoop.handleInbound` and the silence ladder addressed messages to the
   **learner id** (`lrn-919876…`) instead of the handset number — 11za would
   reject every send. Both now strip the prefix.
2. Ladder templates were sent **without their `{{1}}` variable** (and before
   the `data:[…]` fix, with a wrong shape entirely) — Meta rejects a template
   send with missing parameters. Now filled: a name-slot generic ("Dost") or
   the day count for the streak rung.
3. `sendTemplate` previously passed guessed variable field names
   (`otp`/`code`/`var1`); 11za's actual contract is `data: ["…"]`, per their
   API collection. All template sends now use it.

### Known v0 limitations (accepted, documented)

- The window map and activity map are **in-memory** — a redeploy forgets who
  is inside a window (worst case: an agent tries free-form outside the real
  window and the message drops; the 11za `customerWindowStatus` API is used as
  a cross-check where it matters, in OTP fallback).
- The ladder's streak template receives *days inactive*, not the true streak
  (no streak bookkeeping yet).
- The ladder cannot use real names (no roster access in v0) — "Dost" until the
  loop is given a name resolver.

## Document intake (KYC + CV) — how it flows

```
Learner (post-OTP) sends CV or Aadhaar photo/PDF on WhatsApp
  → 11za webhook (media URL detected — routed to Onboarding, not the lesson walker)
  → fetched in memory (10 MB cap, https only, never written to disk)
  → vision extraction (deep tier):  classify → aadhaar | cv | other
       aadhaar: name, DOB, LAST 4 DIGITS ONLY   cv: education, skills, highlights
  → name matched against signup name (loose token overlap)
  → learner record updated (kyc.*)  → in-window confirmation reply
```

Privacy stance, deliberately conservative given Aadhaar is a national identity
number: the full number is never extracted, stored, logged, or echoed — the
model is instructed to return only the last 4 digits and the record stores
nothing more. Name mismatches are flagged for **human review**, never
auto-rejected. Raw documents live only in process memory for the duration of
one extraction call.

## What "good" looks like once templates are approved

- Day 0: learner signs up → `signup_otp` template delivers the code → learner
  replies (window opens) → Onboarding walks them through CV + ID → START.
- Days 1–90: every morning the learner opens the window themselves (START);
  Trainer/Mentor/Assessor ride the window all day.
- The moment a learner goes quiet, the proactive fleet takes over on
  templates: ladder at days 2/3/5, Coach weekly, Examiner before gates,
  Motivator on milestones — every rung visible in the transaction ledger.

---
name: japanese-date-range
description: Rules for interpreting Japanese all-day/period expressions (終日, 有給, から/まで, 日間, 週間, relative dates, month/year rollover, leap years) for calendar event creation. Use when touching the Gemini create-candidate schema/prompt or its server-side validation.
---

# Japanese date-range interpretation rules

## Division of responsibility

- **Gemini resolves language → absolute dates.** It already does this for single dates (`dateLocal`) given
  `nowLocalIso`. Extend the same prompt-driven approach to: (a) the `allDay` boolean, and (b) an inclusive
  end-date field for multi-day periods. Do not write a hand-rolled Japanese NLU date parser in TypeScript.
- **Server-side (Luxon) validates and assembles.** Once Gemini returns candidate dates, server code checks
  format, ordering, business rules, and converts inclusive-end → Google's exclusive `end.date`. Never do this
  arithmetic with fixed-millisecond addition or string slicing — always `DateTime.plus({ days: N })`, which is
  correctly leap-year- and month/year-rollover-safe.

## All-day trigger words (non-exhaustive, prompt should list these as examples, not a closed set)

終日, 一日中, 1日中, 有給, 有給休暇, 休暇, 休み, 夏季休暇, 年末年始休暇 — these are *signals*, not guarantees.
An explicit time mention always overrides them (「8月3日の10時から有給の手続き」→ timed event, NOT all-day,
because a clock time was given). A bare date with none of these words and no time is NOT automatically all-day —
it must land in a clarification state (see below), never silently default either way.

## Period expressions to resolve into absolute start+end dates

- Explicit range: 「Xから Yまで」「X〜Y」 — inclusive of both X and Y.
- Relative range: 「今日から明日まで」「来週月曜日から金曜日まで」「今月末から来月3日まで」
- Day-count: 「Xから3日間」= X, X+1, X+2 (start day counts as day 1). 「1週間」= 7 days inclusive of the start day.
- Month rollover (「8月30日から9月2日まで」) and year rollover (「12月29日から1月3日まで」, end year inferred as
  next year) must resolve correctly — this is exactly what Luxon's `DateTime` arithmetic handles for free;
  the risk is entirely in the Gemini-side date resolution, which is why the prompt must give explicit worked
  examples of month/year rollover, not just describe the rule.

## Reject / clarify, never silently guess

- End date before start date → invalid, do not register.
- Year ambiguous / not uniquely determined → do not register, ask/clarify.
- A recurring-event phrase misread as a single multi-day span (「8月3日から8月5日まで毎日10時に会議」) must NOT
  collapse into one all-day or one timed candidate — treat as unsupported/needs clarification, since recurrence
  is out of scope.
- No hardcoded arbitrary max-range limit unless the design phase explicitly decides one is needed and records
  the reason — don't invent a cap silently.

## Ambiguous case: bare date, no time, no all-day word (spec section 7.4)

Do not auto-convert to all-day just because time is missing. Surface a clarification state that lets the user
either supply a time or confirm all-day (e.g. by saying "終日" again) — reuse the existing
`needs_clarification` / `clarificationField` mechanism rather than inventing a parallel one, extending the
enum only if the design phase confirms the existing values can't express it.

## Timezone

All resolution and comparison is Asia/Tokyo-local, matching every other date computation in this codebase
(`time/tokyoDateTime.ts`'s `TOKYO_ZONE`). Don't introduce a second timezone convention.

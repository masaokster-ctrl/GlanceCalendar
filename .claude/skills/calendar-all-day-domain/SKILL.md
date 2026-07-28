---
name: calendar-all-day-domain
description: Domain rules for all-day and multi-day all-day Google Calendar events in even-calendar-agent/even-calendar-plugin — inclusive vs exclusive end dates, current implementation status, what is already done vs. still missing. Use whenever touching event create/read/update/delete code.
---

# Calendar all-day event domain rules

## The one rule that matters most

**Internal/user-facing data always uses an inclusive end date. Google Calendar API's `end.date` for
all-day events is always exclusive (the day AFTER the last included day).** Every bug in this area is a
1-day-off error from mixing these up. Convert at the API boundary only, using Luxon
(`DateTime.plus({ days: 1 })` / `.minus({ days: 1 })`), never by string manipulation or fixed millisecond math.

| Concept | Field name convention used in this repo | Meaning |
|---|---|---|
| Internal/display start | `startDate` (all-day) / `startLocal` (timed) | first included day / exact start |
| Internal/display end | `endDateExclusive` in plugin-facing responses, but **inclusive** in Gemini candidate fragments — see status below | see per-layer table below |
| Google API start | `start.date` | first included day (same as internal start) |
| Google API end | `end.date` | **exclusive** — inclusive-last-day + 1 |

Do not represent all-day events with `dateTime`, `00:00`/`23:59`, or a timed event starting at midnight.
Never set both `date` and `dateTime` on the same `start`/`end`.

## Implementation status (confirmed by direct code reading — treat as fact, not hypothesis)

**Already fully implemented — do not re-implement, only extend if the design explicitly calls for it:**
- Reading events (day/upcoming/detail): `calendarClient.ts` (`CalendarEventDetail`/`CalendarEventFullDetail`
  already carry `startDate`/`endDate` alongside `startDateTime`/`endDateTime`), `eventResponseMapping.ts`
  (`toEventResponseItem`/`toEventDetailResponseItem` already emit `allDay`/`startDate`/`endDateExclusive`
  correctly, single-day and multi-day), `calendarFormatter.ts` (already renders "終日 <title>" for list speech).
- Updating/deleting an existing event, **including switching timed↔all-day and changing an all-day event's
  date range**: `pluginCalendarEventMutationService.ts`'s `mergeTiming()` already validates
  `startDate < endDateExclusive`, rejects mixed timed+all-day field sets, and builds the correct
  `EventTimingField` (`{date}` or `{dateTime, timeZone}`) for `patchEvent`. `editInstructionSchema.ts`'s
  `resolveEditInstruction()` mirrors this exact logic for voice-driven edits (Gemini already has `allDay`/
  `startDate`/`endDateExclusive` fields in its edit response schema). `calendarClient.ts`'s `EventTimingField`
  union and `patchEvent` already accept either shape.
- Firestore `PluginEventCandidateDoc` already has an `allDay: boolean` field (currently always `false` in
  practice — see gap below).

**NOT implemented — this is the actual scope of the all-day feature work:**
- Natural-language **event creation** never produces `allDay: true`. `candidateFragments.ts`'s
  `resolveCandidate()` hardcodes `const allDay = false` and never reads `incoming.allDay`. The Gemini
  create-schema (`eventCandidateSchema.ts`) has an `allDay` boolean field but no end-date-range field for
  multi-day, and `systemInstruction.ts`'s prompt never mentions all-day at all.
- `routes/pluginCalendarEvents.ts`'s POST body validator explicitly **rejects** `allDay !== false`
  (`isValidBodyShape`) — all-day creation is blocked at the HTTP layer.
- `calendarClient.ts`'s `CalendarEventInput`/`insertEvent` only build `start: {dateTime, timeZone}` — there is
  no date-only insert path (unlike `patchEvent`, which already supports both via `EventTimingField`).
- Plugin-side create types (`eventCandidate.ts`'s `EventCandidateResult`/`FollowupResult`,
  `calendarRegistrationClient.ts`'s `RegisterEventParams`) only carry `startLocal`/`endLocal` and validate them
  with a datetime-only regex — no date-only variant exists yet.
- Confirmation-screen rendering for create (`registrationState.ts`/`screens.ts`) has never had to render an
  all-day or period confirmation.

## Range resolution architecture (important — do not reinvent)

Relative/period date language ("明日", "来週月曜日から金曜日まで", "今月末から来月3日まで") is resolved by
**Gemini itself**, given `nowLocalIso` as the reference instant in the prompt — this is the existing pattern
for single dates (`dateLocal` is already an absolute date resolved by Gemini, not raw text). Extend this same
pattern for a period's end date rather than writing custom Japanese date-range parsing code in TypeScript.
Server-side code's job is only to **validate** what Gemini resolved (format, start ≤ end, not-in-the-past,
any max-range policy) using Luxon, and to assemble the final API payload — never to parse "から"/"まで"/"日間"
itself. See the `japanese-date-range` skill for the validation-side rules this implies.

## Display conventions already established (follow these, don't invent new ones)

- List/speech: `終日 <title>` for all-day (see `calendarFormatter.ts`).
- API responses never expose the Google-API exclusive end date to the client under a name that implies
  inclusivity, and the plugin must never print the exclusive end date as if it were the last included day.

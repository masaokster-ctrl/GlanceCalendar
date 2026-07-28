---
name: repo-targeted-inspection
description: How to investigate even-calendar-agent/even-calendar-plugin without reading the whole repo — search first, read only what's relevant, hand off short summaries. Use before touching any code in this workspace.
---

# Repo-targeted inspection

This workspace (`C:\even-dev`) has two projects: `even-calendar-agent` (Node/Express backend on Cloud Run)
and `even-calendar-plugin` (Even Hub G2 glasses plugin, Vite/TS). Both are large enough that reading them
end to end wastes tokens and time. Never do that.

## Rules

1. **Search before reading.** Use Glob/Grep to find candidate files by name or symbol before opening anything.
   Never open every file in a directory "just in case."
2. **Read only the relevant slice.** If a file is long, read the section around the symbol you need, not the
   whole file — unless you're about to edit it, in which case read the whole file once before editing.
3. **Never read**: `node_modules`, `dist`, build output, `.ehpk` files, lockfiles.
4. **Don't repeat searches.** If another agent already reported "X lives in file Y, function Z", trust it and
   go straight there — don't re-grep to confirm unless something looks inconsistent.
5. **Don't re-derive already-established facts.** Investigation findings from a prior phase of the same task
   (see handoff notes) are current-state facts, not hypotheses to re-verify from scratch.

## Where things live (as of the all-day-events feature work)

Backend (`even-calendar-agent/src/`):
- `types/chat.ts` — chat completion wire types (not calendar domain types)
- `gemini/` — Gemini schemas + prompts: `eventCandidateSchema.ts` (create), `editInstructionSchema.ts` (voice edit),
  `followupResultSchema.ts` (clarification follow-up), `systemInstruction.ts`/`editSystemInstruction.ts`/
  `followupSystemInstruction.ts` (prompts), `candidateFragments.ts` (fragment merge + resolveCandidate — the
  create-side assembly logic), `geminiClient.ts` (API call wrapper)
- `calendar/` — `calendarClient.ts` (Google Calendar API + Fake test double, `CalendarEventInput`/`EventTimingField`
  types), `calendarService.ts` (business-level listing/create/patch/delete), `calendarFormatter.ts` (speech-list
  formatting), `eventResponseMapping.ts` (day/upcoming/detail response shaping)
- `services/pluginCalendarEventMutationService.ts` — update/delete logic (`mergeTiming`)
- `services/pluginCalendarRegistrationService.ts` — create-candidate → Calendar registration
- `routes/pluginCalendarEvents*.ts` — HTTP routes (create, day, upcoming, item=detail/update/delete)
- `routes/pluginAnalyze*Audio.ts` — voice endpoints (initial/edit/followup)
- `firestore/models.ts` — Firestore doc shapes (`PluginEventCandidateDoc`, `PartialCandidate`, etc.)
- `firestore/pluginEventCandidateRepository.ts` — candidate persistence
- `time/tokyoDateTime.ts` — Luxon-based Asia/Tokyo helpers (`toRfc3339`, `toTokyoLocalFromIso`, ranges)

Plugin (`even-calendar-plugin/src/`):
- `eventCandidate.ts` — client-side re-validation of candidate/followup results from backend
- `calendarRegistrationClient.ts` — POST /plugin/calendar-events
- `registrationState.ts`, `screens.ts` — confirmation screen state/rendering
- `dayEvents.ts`/`upcomingEvents.ts`/`eventDetail.ts` + their `*Client.ts`/`*State.ts` — list/detail display
- `editInstruction.ts` — client-side edit diff/validation (mirrors backend `editInstructionSchema.ts`)
- `app.ts` — top-level wiring, Product/Dev mode, `withProductAuthRetry`

## Handoff format

When reporting findings to another agent (designer → developer, developer → tester, etc.), use exactly this
shape and nothing more:

```text
目的: <what this handoff accomplishes>
対象: <files / types / functions / tests>
確定事項: <approved design decisions, things that must NOT change>
実施内容: <what this agent did>
結果: <what changed or was confirmed>
未解決: <real open issues only, or "なし">
次の担当: <next agent>
```

No full source dumps, no full test logs, no repeated background/history.

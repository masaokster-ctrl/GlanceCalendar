---
name: safe-calendar-change
description: Hard boundaries for any code change in even-calendar-agent/even-calendar-plugin — what must never change without explicit human approval, and what "don't break existing behavior" means concretely here. Use for every implementation/testing task in this workspace.
---

# Safe calendar change boundaries

## Never do these without a human explicitly approving in this exact conversation turn

- Deploy to Cloud Run / change production traffic
- Create, delete, or reconfigure any Google Cloud resource
- Change Secret Manager values or IAM
- Change OAuth client configuration or the OAuth flow itself
- Register, update, or delete a real event on a real Google Calendar (all Calendar API interaction in tests
  must go through `FakeCalendarClient` / mocked Gemini — never the real APIs)
- Rewrite git history (moot here: this workspace has no `.git` — confirm before assuming otherwise)
- Delete existing `.ehpk` build artifacts

## "Don't break existing behavior" — concrete meaning for this feature

These flows must keep working exactly as before, verified by the existing test suites passing unmodified
except where a change is a *direct, explained* consequence of the new all-day support:
- Even G2 event registration (timed events)
- Today / tomorrow / upcoming list display
- Event detail display, edit, delete
- Google OAuth (dev session + Product pairing/refresh)
- Cloud Run backend request handling
- Even Hub plugin packaging (`build:product`, contamination checks — see below)
- Natural-language extraction for timed events

## Backward compatibility

- Existing API request/response shapes must keep working for old plugin builds where relevant — additive
  fields only (new optional fields), no renames/removals of fields already relied upon.
  `isValidBodyShape`/`PatchEventInput`/`EventCandidateResult` etc. should gain new optional branches, not lose
  old ones.
- `any` should not be introduced casually; prefer discriminated unions (the codebase already uses this pattern
  extensively — e.g. `EventTimingField = {dateTime,timeZone} | {date}`).

## Secrets / logging

- Never log tokens, Authorization header values, raw installationId/userId, Google account info, event
  content (title/description/location/datetime), or raw request/response bodies. Follow the existing
  `logSafeEvent`/`sanitizeError`/`classifyProductCalendarError` conventions already in the codebase — reuse
  them, don't build parallel logging paths.

## Scope discipline

- Don't refactor unrelated already-completed features.
- Don't duplicate existing Gemini client / auth / audio / WAV / timezone / error-classification / logging
  infrastructure — reuse what exists.
- No new external AI services.
- Minimize diff size; a working addition beats a "cleaner" rewrite.

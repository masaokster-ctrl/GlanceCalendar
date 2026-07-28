---
name: targeted-test-gates
description: Test execution order and reporting-compression rules for even-calendar-agent/even-calendar-plugin. Use whenever running or reporting lint/test/build results, especially as a tester agent.
---

# Targeted test gates

## Execution order (don't skip ahead, don't restart from the top repeatedly)

1. Unit tests directly covering the changed file(s)
2. Tests for the whole changed module/directory
3. Re-run only the tests that failed, after a fix
4. Related integration tests (e.g. route-level tests exercising the full request path)
5. `lint`
6. `build` (and `build:product` for the plugin, per its own script)
7. Full test suite, once, at the end

Do not run the full suite repeatedly "just to check" — run it once relevant work is believed complete, and
again only after a fix that could plausibly affect other tests.

## Commands (per project)

Backend (`even-calendar-agent/`): `npm run lint`, `npm test`, `npm run build`
Plugin (`even-calendar-plugin/`): `npm run lint`, `npm test`, `npm run build`, `npm run build:product`
(never run `npm run package:product` / EHPK packaging unless explicitly instructed — that's a separate,
human-gated step)

## Reporting format on failure

Report only:
- Failed test name(s)
- The first real error message (not the whole stack dump if it's noisy)
- The relevant stack frame(s) pointing at project code (not node_modules internals)
- Best-guess root cause
- Candidate file(s)/function(s) to fix
- The exact command to reproduce

Never paste large blocks of passing-test output or repeat the same failure text more than once.

## Reporting format on success

State pass/fail counts only (e.g. "943/943 passed") — no per-test listing.

## Regression check

Before declaring done, confirm explicitly (boolean, not full logs) that these still pass: event registration
(timed), today/tomorrow/upcoming list, event detail, event edit, event delete, OAuth-related tests. If any of
these newly fail, that is a release-blocking regression, not a "pre-existing failure" — investigate immediately
rather than deferring.

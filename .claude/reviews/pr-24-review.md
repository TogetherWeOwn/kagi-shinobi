# PR Review: #24 — test: pin ADR 0006's fail-closed guarantee, and fix the budget leak found doing it

**Reviewed**: 2026-08-07
**Author**: rick7c2 (self-review — GitHub does not accept an approving review from the PR author)
**Branch**: `test/guard-billable-fail-closed` → `main`
**Decision**: APPROVE with comments

## Summary

Verifies the one safety property in this repo that had been asserted for four
sessions without ever being checked, and fixes a real budget leak found while
checking it. Two review findings were raised against the branch and both were
fixed in `961f454` before this report was finalized.

## Findings

### CRITICAL

None.

### HIGH

None. The fail-closed property was verified by mutation rather than by reading:
inserting a `.catch()` in `guardBillable` that falls through to an unmetered
guard fails all 16 endpoint cases and 3 of the `guardBillable` cases; reverting
restores them. A test that passes the moment it is written has proven nothing
until it has been shown capable of failing.

### MEDIUM

1. **`test/kagi/api/billable-fail-closed.test.ts` — incomplete table, since fixed
   (`961f454`).** The table's comment claimed to enumerate "every endpoint that
   spends money" and omitted `apiSmallWeb` and `apiRank`, both of which bill a
   full ~1.2¢ v1 search. They are safe today only because each delegates to
   `apiSearch` and inherits its guard — a property of the current implementation,
   not of the test. Giving either its own `client.request` is exactly the drift
   that would reintroduce an unmetered billable path. Both now sit in the table
   and both fail under the mutation, so the added rows bind behavior rather than
   padding a count.

2. **`test/kagi/api/billable-fail-closed.test.ts` — redundant double invocation,
   since fixed (`961f454`).** The second `it.each` called the endpoint twice, and
   `rejects.toThrow(UNREACHABLE)` already implied
   `not.toBeInstanceOf(KagiBudgetExceededError)`. Collapsed to a single call that
   captures the rejection once.

### LOW

1. **`guardBillable` makes a DO round trip even when the cap is 0** — the default
   deny-everything configuration. `readCap` is local, but the cap is passed *into*
   `reserveSpend` and the refusal is decided inside the DO. Deliberately not
   changed: the thrown `KagiBudgetExceededError` carries the DO's real
   `spent_cents`, which a local short-circuit could not report. Documented in the
   test and in ADR 0006 rather than silently left as a surprise. Flagged in the
   PR body for the reviewer to overrule if the hop is judged not worth the
   accurate figure.

2. **Casts in test doubles** — `as unknown as Env["METER"]`. Unavoidable when
   standing in for a `DurableObjectNamespace`, and consistent with the existing
   pattern in `test/workers/refresh-lease.test.ts`.

## Notes on the production change

`src/kagi/api/summarize.ts` is the only source file touched: the 1MB body check
moves above `guardBillable`. Behavior-preserving for every valid request — same
signature, same `KagiError("parse", …)`, same message. For an oversized body it
changes only *when* the throw happens, which is the defect: there is no settle on
that path, so reserving first left 30¢ on the books permanently for a call that
never reached Kagi. `apiExtract` already validated before reserving; this makes
the two consistent.

## Validation Results

| Check | Result |
|---|---|
| Type check (`npm run typecheck`) | Pass |
| Lint | Skipped — no lint script in `package.json` |
| Tests (`npm run test:coverage`) | Pass — 680 passed, 39 files |
| Build (`wrangler deploy --dry-run`) | Pass — all bindings resolved |
| Coverage | 98.68 / 93.01 / 99.64 / 99.61 — identical to the `f0fa8cf` baseline, measured by stashing and re-running |
| GitHub Actions CI | **Did not run** — account billing block, see below |

CI could not verify this branch. The `test` job failed in 2s without starting:
"The job was not started because recent account payments have failed or your
spending limit needs to be increased." PR #22's CI passed roughly fifteen minutes
earlier, so the block is new and affects the account, not this branch. The four
steps above are the same four `ci.yml` runs, executed locally in the same order
on Node v22.23.1. That is local evidence, not a CI run, and CI should be re-run
before merge.

## Files Reviewed

| File | Change |
|---|---|
| `test/kagi/api/billable-fail-closed.test.ts` | Added — 16 cases over 8 billable entry points |
| `test/workers/cost.test.ts` | Modified — `describe("the Meter being unreachable")`, 5 cases against the real DO |
| `test/kagi/api/endpoints.test.ts` | Modified — budget assertion on the 1MB rejection; new `kind='text'` happy path |
| `src/kagi/api/summarize.ts` | Modified — validate before reserving |
| `docs/adr/0006-serialize-rate-and-spend-counters.md` | Modified — Verification section |

## Recommendation

Merge once CI can run. No blocking issues. The one open judgement call is the
0-cap DO round trip, which is a documented non-change rather than an oversight.

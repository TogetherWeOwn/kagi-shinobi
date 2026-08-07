# PR Review: #28 — fix: one error vocabulary — REST status stops depending on which class was thrown

**Reviewed:** 2026-08-07
**Author:** rick7c2 (authored with Claude Code)
**Branch:** `fix/one-error-vocabulary` → `main`
**Mode:** local review of the uncommitted diff, run before committing
**Decision:** APPROVE — two findings were raised and fixed inside the diff rather than filed

## Summary

Replaces an `instanceof` chain that computed REST status from the error *class*
and code from the *kind* with a single `Record<KagiErrorKind, number>` plus a
derived code, adds `error.detail` to the REST envelope, routes the last
hand-rolled error `Response` through `jsonError`, and deletes three redundant
branches from `kagiErrorMcp`. Recorded as ADR 0012.

Reviewing it surfaced two real defects **in the change itself**. Both are fixed
in the same commit; they are written up here because the second one is a repeat
of the failure ADR 0006 exists to document, and repeats are worth a paper trail.

## Findings

### CRITICAL

None. The one candidate was checked rather than waved off: the diff newly
publishes `err.detail` on the REST wire, so every construction site was audited
for secret exposure. The bags contain `status`, `status_text`, `retry_after`,
`spent_cents`, `cap_cents`, `tool`, `mode`, `ms`, `cost_cents`, `engine` — all
operational metadata, no credentials or user data. All of it already reached MCP
callers through `mcpError`, behind the same bearer gate, so the audience is
unchanged. `KagiUpstreamError`'s 500-char upstream body slice was already on the
REST wire inside `message`, so `detail` adds no new exposure there either.

### HIGH

**1. The table lookup was fail-open.** `src/rest.ts` —
`KAGI_ERROR_STATUS[err.kind]` is `undefined` for a kind that reaches the
function past the type system (a cast, a JS caller, a value off the wire), and
`new Response(body, { status: undefined })` returns **200**. Measured, not
assumed:

```
$ node -e 'console.log(new Response("x", { status: undefined }).status)'
200
```

So an unmapped kind would have answered an error with a success status — a
regression against the chain being replaced, whose last branch was a 500.

*Fix:* `KAGI_ERROR_STATUS[err.kind] ?? 500`, plus a test that constructs
`new KagiError("bogus" as KagiErrorKind, …)`. The `Record` and the guard are not
redundant with each other: the `Record` stops a kind being *added* without a
status at typecheck; the guard stops one *arriving* without a status at runtime.

*Mutation-tested*, per the standing rule about safety properties that pass the
moment they are written — removing `?? 500` turns the new test red at 200, and
restoring it turns it green. The file was diffed against a pre-mutation copy
afterwards to confirm a clean revert.

### MEDIUM

**2. The ADR asserted a benefit the code does not deliver.** The first draft of
ADR 0012 claimed a live asymmetry — "a REST client gets `Retry-After` when the
worker's own limiter rejects it but not when Kagi's does". Checking instead of
believing it:

```
$ rg -n 'new KagiRateLimitError' src/
(no matches)
```

`KagiRateLimitError` is declared and mapped but constructed **nowhere** in
`src/`. A Kagi 429 is raised as `KagiUpstreamError(429, …)` at
`src/kagi/api/client.ts:82`, so it arrives as kind `upstream` and a 502. The
asymmetry the ADR sold as motivation cannot occur.

*Fix:* the claim is corrected in the ADR and in the `retryAfterHeader` comment.
The header wiring stays — a mapping keyed by kind owes every kind an answer, and
it is four covered lines — but is now labelled latent, with the measurement
inline. Whether `rate_limit` *should* be thrown where `upstream` is thrown today
is left explicitly unsettled rather than quietly implied.

This is the ADR 0006 failure repeating: a comment and an ADR both asserting a
property the code did not have. It was caught the same way — by running a
one-line check instead of re-reading the prose.

### LOW

- `jsonError` spreads `init.headers` after `Content-Type`, so a caller can
  override the content type. Deliberate: it matches `jsonOk`, which has a test
  asserting exactly that behavior. Left consistent rather than special-cased.
- `retryAfterHeader` would emit `Retry-After: NaN` if a non-finite number ever
  reached `detail.retry_after`. Not reachable today (nothing constructs the
  error at all) and not worth a guard until it is.

## Checklist

| Check | Result |
| --- | --- |
| Hardcoded credentials / secrets | None — new wire field audited at every construction site |
| Input validation at boundaries | Unchanged; `detail` values are internally produced, never user input |
| Header injection | Not possible — values are `String(number)` |
| Functions > 50 lines | None; `kagiErrorResponse` went from 33 lines to 20 |
| Files > 800 lines | None; largest touched is `src/mcp.ts` at ~615 |
| Nesting > 4 levels | None |
| `console.log` in production code | None |
| Mutation / immutability | Clean — new objects only, no in-place edits |
| Tests for new behavior | 47 added (681 → 728), including exhaustive iteration over every kind |
| Coverage ≥ 80% (repo ratchet 95/90/95/95) | 98.66 / 92.91 / 99.64 / 99.61 |

## Validation Results

| Check | Result |
| --- | --- |
| `npm run cf-typegen` | Pass |
| `npm run typecheck` | Pass |
| `npm run test:coverage` | Pass — 40 files, 728 tests |
| `npx wrangler deploy --dry-run` | Pass — exit 0 |
| Lint | Skipped — no lint script in `package.json` |
| `npm run test:e2e` | Not applicable on this branch; the E2E layer lands with #27 |

## Files Reviewed

| File | Change |
| --- | --- |
| `docs/adr/0012-one-error-vocabulary-two-envelopes.md` | Added |
| `docs/adr/README.md` | Modified — index row |
| `src/kagi/http.ts` | Added — kind→status table, derived code |
| `src/kagi/errors.ts` | Modified — `KAGI_ERROR_KINDS` runtime array, type derived from it |
| `src/rest.ts` | Modified — chain replaced, detail + Retry-After, fail-closed guard |
| `src/util/errors.ts` | Modified — `JsonErrorInit`, `ErrorBody.detail` |
| `src/index.ts` | Modified — rate-limit response routed through `jsonError` |
| `src/mcp.ts` | Modified — three redundant branches deleted |
| `test/kagi/http.test.ts` | Added — vocabulary contract over every kind |
| `test/rest.test.ts` | Modified — kind-keyed table, base-class parity, detail, fail-closed |
| `test/util/errors.test.ts` | Modified — detail and header init |
| `test/workers/mcp-tools.test.ts` | Modified — envelope pins guarding the deletion |

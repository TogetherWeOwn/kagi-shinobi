# Review: the Playwright E2E layer (local, uncommitted)

**Reviewed:** 2026-08-07
**Scope:** local working tree against `main` @ `f6a54e7` — no PR
**Decision:** APPROVE (after fixes applied in-session)

Three reviewers ran in parallel per `agents.md`: security, TypeScript, and
general quality. Every finding below was either fixed or rejected with a reason;
none were left open.

## Summary

Adds a third test layer (Playwright, `test/e2e/`) that boots a real
`wrangler dev` and talks to it over HTTP, plus ADR 0011 defining its scope rule.
No CRITICAL or HIGH defects in the shipped code. The one finding filed as
CRITICAL was about documentation wording in `CLAUDE.md`, not behaviour, and has
been reworded. Two MEDIUM defects were real and are fixed; one of them was a
latent flake that only bites the local dev loop.

## Findings

### CRITICAL

**`CLAUDE.md` — delegation language read as licensing a permission bypass.**
The quality reviewer flagged that new text ("Agent delegation is
standing-authorized — do not stop to confirm it") is an instruction to future
agents sitting inside the very diff that adds it, and asked that a human confirm
it was intentional. It was: the repo owner gave it directly on 2026-08-07. The
narrower objection is still correct — no file in a repo can grant that, and the
wording implied more than intended. Reworded to scope it explicitly to *what to
ask the user*, with an added paragraph stating that it does not relax the
permission system, GateGuard, or destructive-action confirmation. Kept the
owner's intent; dropped the overreach.

### HIGH

None.

### MEDIUM — all fixed

1. **Rate-limit state accumulated across local reruns** (`playwright.config.ts`).
   The Meter DO keys its counter by bearer-hash + epoch-minute and prunes only
   buckets older than two minutes; every spec authenticates as the one
   `E2E_ADMIN_TOKEN`, and `--persist-to` pointed at a fixed directory. Reruns
   inside one wall-clock minute therefore piled into a single bucket until they
   tripped `PER_BEARER_RPM`, failing tests for reasons unrelated to the change
   under test. CI is immune (fresh checkout); the dev loop was not.
   *Fix:* the `webServer` command now deletes `.wrangler/e2e-state` before boot,
   via `fs.rmSync` rather than `rm -rf` so it is not shell-specific.
   *Verified by mutation* — see below.

2. **Casts that widened a discriminated union** (`test/e2e/smoke.spec.ts`).
   `result.content as Array<{type: string; text: string}>` made `.text` look
   safe on image/audio blocks, and destructuring an empty `content` would have
   thrown a bare `TypeError` instead of naming the problem.
   *Fix:* pass `CallToolResultSchema` so the client validates through zod, then a
   single narrowing cast to the SDK's exported `CallToolResult`, plus an explicit
   non-empty assertion before indexing.
   *Note:* the reviewer's stated premise — that a bare `callTool()` is already
   precisely typed — is wrong for SDK 1.30. Checked rather than assumed:
   `callTool` is declared as returning `CallToolResult | {toolResult: unknown,
   [x: string]: unknown}`, and that union collapses `content` to `unknown`
   whatever schema is passed. Passing the schema is what makes the compatibility
   branch unreachable, which is what makes the remaining cast true rather than
   hopeful. The comment in the file records this so it is not "simplified" back.

3. **One assertion restated the in-process suite** (`test/e2e/smoke.spec.ts`).
   The tool-call test re-pinned `error_kind` *and* the rendered text, which
   `test/workers/mcp-tools.test.ts:283` already owns — a violation of this
   layer's own scope rule.
   *Fix:* narrowed to transport fidelity (structured payload arrives as a live
   object; a content block survives SSE framing) and dropped the wording check.
   ADR 0011 gained an explicit carve-out: the same condition may be re-exercised
   over a different transport when the transport is what is under test.

### LOW — fixed

- Reused the existing `ErrorBody` (`src/util/errors.ts:5`) and extracted a named
  `HealthBody` instead of inline object types.
- `SCRAPE_MODE_TOOLS` gained a comment pointing at where the gating actually
  lives, with an instruction not to loosen the exact-set assertion.
- Comment added that Playwright traces embed `Authorization` headers, so
  `test-results/` and `playwright-report/` must stay gitignored.
- Comment added that `process.env` resolves only via `@types/node` pulled in
  transitively by Playwright's own types — a trip-wire if that ever changes.

### Rejected, with reasons

- **Randomise the E2E bearer per run.** Rejected: Playwright re-evaluates the
  config module in every worker process, so a value generated at module scope
  differs between runner and worker and 401s every authenticated request. Doing
  it safely needs `globalSetup` plus a side channel — real complexity to
  randomise a fixture with no blast radius (no Kagi credential,
  `MAX_API_CENTS_PER_MONTH=0`). Reasoning recorded in `test/e2e/_config.ts`.
- **Export a tool/mode matrix from `src/mcp.ts`** for the test to import.
  Deferred: it changes production code to serve a test, and the exact-set
  assertion already fails loudly on drift. Recorded as a comment instead.

## Verification by mutation

Neither fix was trusted because it passed. Each was made to fail first.

| Mutation | Expected | Observed |
| --- | --- | --- |
| `KAGI_MODE: scrape→api`, `AUTO_REFRESH_ENABLED: true→false` | only the 2 config-path tests fail | exactly those 2 failed; tool list gained the 4 api-only tools |
| Remove the state wipe, `PER_BEARER_RPM=14` | reruns fail on accumulated 429s | run 1: 5/7, run 2: 4/7 |
| Restore the wipe, `PER_BEARER_RPM=14` | reruns stay green | 3 consecutive runs, 7/7 each |
| `PLAYWRIGHT_BROWSERS_PATH` → empty dir | suite still passes (no browser used) | 7/7 |
| Empty `XDG_CONFIG_HOME` + `CI=true` | no Cloudflare credential needed | 7/7 |

`wrangler.jsonc` was restored from backup after each mutation and confirmed
byte-identical to HEAD.

## Validation Results

| Check | Result |
| --- | --- |
| Type check (`npm run typecheck`) | Pass |
| Lint | Skipped — repo has no lint script or ESLint config |
| Tests (`npm run test:coverage`) | Pass — 681 tests, 39 files |
| Coverage | 98.68 / 92.99 / 99.64 / 99.61, unchanged; ratchet 95/90/95/95 |
| E2E (`npm run test:e2e`) | Pass — 7 tests, ~7.4s |
| Build (`wrangler deploy --dry-run`) | Pass |
| Lockfile float check | Pass — no production dep moved; only playwright + optional fsevents |

## Files Reviewed

Added: `playwright.config.ts`, `test/e2e/_config.ts`, `test/e2e/smoke.spec.ts`,
`docs/adr/0011-an-e2e-layer-that-only-tests-what-in-process-tests-cannot.md`
Modified: `.github/workflows/ci.yml`, `.gitignore`, `CLAUDE.md`,
`docs/adr/README.md`, `package.json`, `package-lock.json`, `tsconfig.json`,
`vitest.config.ts`

## Recommendation

Approve. The layer is scoped so it cannot decay into a duplicate of the workerd
suite, its two real defects are fixed and the fixes are demonstrated by
mutation, and the whole CI sequence is green from a clean state.

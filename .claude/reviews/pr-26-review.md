# PR Review: #26 — chore(deps-dev): TypeScript 7, and the latent type contradiction it exposed

**Reviewed**: 2026-08-07
**Author**: rick7c2 (self-review — GitHub does not accept an approving review from the PR author)
**Branch**: `chore/typescript-7` → `main`
**Decision**: APPROVE with comments

## Summary

Lands the compiler major that had been deferred to "its own session" for good
reason, and fixes the latent type contradiction it exposed. One review finding
was raised against the branch and fixed before merge.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. **`--strict-vars=false` was duplicated across two files — since fixed.** The
   first version of this branch put the flag in `package.json`'s `cf-typegen`
   *and* in `ci.yml`, with a comment in each asking future readers to keep them
   in step. A comment asking humans to maintain an invariant is the weakest form
   of enforcement available, and the failure mode is nasty: because
   `worker-configuration.d.ts` is gitignored, CI regenerates it, so a flag that
   drifts fails CI on source that type checks fine locally — the confusing
   direction. CI now runs `npm run cf-typegen`, so the flags live in exactly one
   place and cannot drift. The comment asking anyone to remember is deleted along
   with the duplication.

### LOW

1. **Literal-typed vars are given up.** That is the intent, not a side effect —
   they encoded the current contents of `wrangler.jsonc` as types, so any
   deployment or test using a different value became a type error. Flagged in the
   PR body for an explicit overrule.

2. **`AUTO_REFRESH_ENABLED` and `TOKEN_KV_KEY` widen too.** Both are now `string`
   rather than `"true"` / `"session_token"`. Neither is compared against a
   competing literal in `src/`, so nothing is lost; noted only because the flag
   is repo-wide rather than per-var — wrangler offers no finer control.

## Notes on risk

The riskiest part of a compiler major is that `tsc --noEmit` is the gate every
other verification claim in this repo leans on: if the gate itself is wrong,
everything downstream is unverified. Two things bound that here.

The type fix (`5e17ad0`) type checks clean under **both** 5.9.3 and 7.0.2 on the
same source — measured, both directions. So it is not a change shaped around one
compiler's opinion, and reverting the bump alone (`4dfefb1`) leaves a working
tree.

And the gate is not the only net. The 681-test suite runs through vitest/esbuild,
which does not use `tsc` at all, so a compiler regression cannot silently take
the tests with it. Both were green.

## Validation Results

| Check | Result |
|---|---|
| `npm run cf-typegen` (from a deleted d.ts) | Pass |
| Type check — TypeScript 7.0.2 | Pass, 0.287s |
| Type check — TypeScript 5.9.3, same source | Pass, 1.801s |
| Lint | Skipped — no lint script |
| Tests (`npm run test:coverage`) | Pass — 681 passed, 39 files |
| Build (`wrangler deploy --dry-run`) | Pass |
| GitHub Actions CI | Pass — 1m14s, including a full typegen from scratch |
| Coverage | 98.68 / 92.99 / 99.64 / 99.61 |
| Lockfile production float | **Zero** direct production deps moved |

The CI run matters more than usual here: it regenerated
`worker-configuration.d.ts` from nothing and then type checked against it, which
is the only way to verify the `ci.yml` half of the change.

## Files Reviewed

| File | Change |
|---|---|
| `src/env.ts` | Modified — vars removed from the augmentation; secrets only |
| `.github/workflows/ci.yml` | Modified — typegen step calls `npm run cf-typegen` |
| `package.json` | Modified — `cf-typegen` gains the flag; `typescript` `^5.7.3` → `^7.0.2` |
| `package-lock.json` | Modified — TS 7 plus 20 per-platform binaries |
| `CLAUDE.md` | Modified — command table and typegen note |

## Recommendation

Merge, then close #23 as superseded. The judgement call worth a second opinion is
giving up literal-typed vars; everything else removes a contradiction that both
compilers agree should not be there.

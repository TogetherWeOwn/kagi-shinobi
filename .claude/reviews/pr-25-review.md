# PR Review: #25 — fix: one MCP error envelope — kagi_summarizer stops disagreeing with itself

**Reviewed**: 2026-08-07
**Author**: rick7c2 (self-review — GitHub does not accept an approving review from the PR author)
**Branch**: `fix/unify-invalid-language-envelope` → `main`
**Decision**: APPROVE with comments

## Summary

Resolves an inconsistency carried unresolved across several sessions, and
corrects the inherited description of it, which was wrong in a way that probably
explains why it never got decided. One review finding was raised against the
branch and fixed in `72d05f3`.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. **The rule was documented but not enforced — since fixed (`72d05f3`).** After
   `kagi_summarizer` moved onto `mcpError`, `rg 'isError' src/` returned hits only
   inside `result.ts` itself: `mcpResult`'s optional `isError` input had zero
   production callers, and only a unit test of the helper still exercised it.
   That flag is the exact escape hatch this ADR exists because of. Shipping the
   ADR while leaving the mechanism in place would document the rule and keep the
   thing that broke it, leaving the next tool free to invent a fourth shape.
   `mcpResult` can no longer produce an error result at all; `mcpError` is the
   only door. The helper test is inverted to pin that.

### LOW

1. **REST keeps its own error convention.** `src/rest.ts:145` answers the same
   condition with `jsonError(400, "invalid-language", …)` — kebab-case codes,
   HTTP status, no `error_kind`. Deliberately out of scope: ADR 0010 is scoped to
   the MCP surface, and REST applies its own convention consistently across every
   validation branch in that file. Worth a separate ADR if the two surfaces are
   ever meant to converge; not drift in the way this PR fixes, because REST does
   not disagree with itself.

2. **Breaking change is real, and narrow.** A client grepping `content[0].text`
   for `Supported:` on `kagi_summarizer` loses that inline list. Called out in the
   PR body and in ADR 0010's Consequences rather than buried. The codes remain in
   `structuredContent.supported`, which is where the two sibling tools have always
   put them, so any such client was already tool-specific.

## Verification of the ADR's own claims

ADR 0010 asserts the `tools/list` wire contract is unaffected. Checked rather
than assumed: `test/workers/mcp-schema-contract.test.ts` passes with no `-u`, and
its 852-line snapshot is unchanged. Error payloads are not part of that snapshot.

This matters because the repo has now twice been bitten by documentation
asserting a property the code did not have — ADR 0006 exists for that reason, and
PR #24 closed the last outstanding instance. An ADR making an unverified claim in
the same week would be a poor addition.

## Validation Results

| Check | Result |
|---|---|
| Type check (`npm run typecheck`) | Pass |
| Lint | Skipped — no lint script in `package.json` |
| Tests (`npm run test:coverage`) | Pass — 681 passed, 39 files |
| Build (`wrangler deploy --dry-run`) | Pass |
| GitHub Actions CI | Pass — `72d05f3`, 1m14s, all 8 steps |
| Coverage | 98.68 / 92.99 / 99.64 / 99.61 |

Coverage denominators shrank (1442 → 1440 statements, 916 → 914 branches)
because the change deletes code. Branches read 92.99 against 93.01 before, which
is the removed `if (init.isError)` branch leaving the denominator, not a lost
test. All four floors (95/90/95/95) hold.

## Files Reviewed

| File | Change |
|---|---|
| `src/mcp.ts` | Modified — `invalid_language` branch routes through `mcpError` |
| `src/mcp/result.ts` | Modified — `isError` input removed from `McpResultInit` and `mcpResult` |
| `test/workers/mcp-tools.test.ts` | Modified — envelope assertions; new case pinning that both failure paths of one tool agree |
| `test/mcp/result.test.ts` | Modified — inverted to pin that `mcpResult` never flags `isError` |
| `docs/adr/0010-one-mcp-error-envelope.md` | Added |

## Recommendation

Merge. The judgement call worth a second opinion is the dropped inline
`Supported:` list in `content[0].text`; everything else is removing a
contradiction rather than choosing between designs.

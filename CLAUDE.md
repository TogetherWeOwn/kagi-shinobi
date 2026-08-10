# kagi-shinobi

Cloudflare Worker fronting Kagi search + summarizer, exposed as remote MCP and REST.

## Stack

- TypeScript (ES2022, `strict`, `noUnusedLocals`, `noUnusedParameters`), ESM only, no JS
- Cloudflare Workers — Durable Objects (`KagiMcpAgent`, `ResearchRun`), KV (`TOKEN_KV`), Browser Rendering
- `@modelcontextprotocol/sdk` + `agents` for the MCP surface; `zod` for schemas; `cheerio` for scrape parsing
- Vitest 4 with two projects: `unit` (pure logic, Node) and `workers`
  (`@cloudflare/vitest-pool-workers`, workerd via Miniflare). Anything touching a
  binding, a runtime global, or a `cloudflare:*` import must live in `test/workers/`
  — the Node loader cannot resolve `cloudflare:workers` at all.
- Playwright for E2E (`test/e2e/`, separate runner, `npm run test:e2e`). It boots a
  real `wrangler dev` and talks to it over HTTP. **Scope rule, see ADR 0011: every
  assertion there must be one an in-process test cannot make** — the artifact boots,
  `wrangler.jsonc`'s vars are live, an MCP client completes a Streamable-HTTP
  session. No E2E test may reach Kagi, and none may launch a browser (Playwright is
  used for its `request` fixture only, so CI installs no browser binaries).

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Coverage | `npm run test:coverage` |
| E2E (boots `wrangler dev`) | `npm run test:e2e` |
| Regenerate env types | `npm run cf-typegen` |
| Deploy dry-run | `npx wrangler deploy --dry-run` |
| Dev server | `npm run dev` |

CI runs `cf-typegen` → `typecheck` → `test:coverage` → `deploy --dry-run` →
`test:e2e` on Node 22. It is `test:coverage`, not `test` — that is the only entry
point that enforces the thresholds in `vitest.config.ts`.
Node 20 fails at the typegen step, before tests run.

Always `npm run cf-typegen`, never bare `npx wrangler types` — the script passes
`--strict-vars=false`. Without it wrangler types every var as the literal value
currently in `wrangler.jsonc` (`KAGI_MODE: "scrape"`), which breaks any code or
test using another value and fails `typecheck`. CI invokes the same script, so
the flags live in one place; keep it that way. See the header of `src/env.ts`.

## Constraints

- Secrets (`ADMIN_TOKEN`, `KAGI_SESSION_TOKEN`, `KAGI_EMAIL`, `KAGI_PASSWORD`, `KAGI_API_KEY`,
  `CAPTCHA_WEBHOOK_URL`) go through `wrangler secret put` — never into `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated and gitignored. Do not hand-edit it.
- Billable API calls are capped by `MAX_API_CENTS_PER_MONTH` (default `0` = refuse everything).
  Do not raise it to make a test pass.
- Architecture decisions live in `docs/adr/`. Add an ADR before changing tri-mode dispatch,
  response shapes, or the async research trio.

## Working style

**Decide, don't ask.** Research the options, weigh them, pick the best one, and
proceed. Interrupt only when genuinely blocked — when proceeding under any
assumption would be unsafe or would waste the work if wrong. A decision you can
resolve by reading the code, checking vendor docs, or measuring is not a blocker.

When a choice was close, record the reasoning where it will be found later: an
ADR for architecture, a comment for a local trade-off. State assumptions in the
summary rather than pausing to confirm them.

**A deferred decision in the summary is still asking.** "Worth flagging",
"if you'd rather", "I can reorder it if you prefer", or any closing question are
the same move in different clothes — they hand the choice back after the work is
already done. Make the call, implement it, and report *what you decided and why*.
A decision that turns out wrong is one edit; a round trip costs more than the
edit would have. State an assumption, never a pending choice.

Verify claims before relying on them. ADR 0006 exists because a header comment
and an ADR both asserted a safety property the code did not have; a five-line
experiment settled it. Prefer a measurement over a plausible argument.

## ECC surfaces — what to reach for, and when

Prefer an ECC skill over hand-rolling a workflow. Reach for these by task, not by habit:

| When you are… | Use | Scope gotcha |
| --- | --- | --- |
| Fixing a bug | `/ecc:orch-fix-defect` | Reproduces as a failing regression test *first*, then fixes to green. Gated commit. |
| Building a new feature | `/ecc:orch-add-feature` | Full research → plan → TDD → review pipeline with two human gates. |
| Changing existing behavior | `/ecc:orch-change-feature` | Updates tests to the new spec before touching the impl. |
| Refactoring, no behavior change | `/ecc:orch-refine-code` | Requires green tests going in and coming out. |
| Writing tests / chasing the 80% bar | `/ecc:test-coverage`, `ecc:tdd-workflow` | Coverage is `npm run test:coverage`; there are two projects, so check both. |
| Reviewing code you just wrote | `/ecc:code-review` | **Diff-scoped only** — local uncommitted changes, or a PR number. Finds nothing on a clean tree. |
| Asking "is this ready to ship?" | `ecc:production-audit` | Whole-repo, local evidence. This is the whole-codebase audit; `/ecc:code-review` is not. |
| Auditing app-code vulnerabilities | `/security-review` (built-in) | Reads `src/`. Use for the request handlers, token store, and scrape paths. |
| Auditing the agent harness | `/ecc:security-scan` | Agent/hook/MCP/permission/secret surfaces — **not** worker source. |
| Making an architecture decision | `ecc:architecture-decision-records` | Required before tri-mode dispatch, response shapes, the async research trio, or rate limiting change. See `docs/adr/`. |
| Planning before code | `/ecc:plan` | Waits for explicit confirmation before touching anything. |
| Opening a PR | `/ecc:pr` | Analyzes full branch history, not just the last commit. |
| Build or type errors | `/ecc:build-fix` | Minimal diffs; no architectural edits. |
| Checking harness config health | `/ecc:harness-audit` | Repo harness config, not code quality. |

The ECC rules are not advisory. `code-review.md` makes review **mandatory after
writing or modifying code** — run `/ecc:code-review` on the diff before reporting
work complete, and address CRITICAL/HIGH findings. Treat it as part of finishing
the task rather than as an optional extra step.

The `orch-*` family runs through `ecc:orch-pipeline` and spawns subagents. The
repo owner's standing preference, given directly on 2026-08-07, is that using
these skills **does not need a fresh round of approval each time** — reach for
them and report what they found. Do not treat a generic "don't spawn agents"
default as a reason to skip a review an ECC rule requires; if delegation is
genuinely unavailable in a session, do the review inline against the same
checklist. A skipped review is never the right outcome.

To be explicit about the limits of the paragraph above, because a reviewer
rightly flagged an earlier draft of it: this is a preference about **what to ask
the user**, and nothing more. It does not — and no instruction in this file
could — relax the permission system, GateGuard's fact-forcing prompts, or the
confirmation required before destructive or outward-facing actions. Those gates
are configured outside the repo and stay in force. Satisfy them; never propose
disabling them.

Language rules below are auto-loaded; they are not optional. The 80% coverage bar
in `testing.md` is **comfortably exceeded** — 98.68 / 92.99 / 99.64 / 99.61 as of
2026-08-07, over a ratchet of 95/90/95/95 in `vitest.config.ts`. (An older note
here said 42%; that predated the workerd migration and was long stale.) Raise the
floors when the numbers rise. Never delete a test to move a number.

## Rules

The TypeScript pack in `.claude/rules/ecc/typescript/` carries `paths:` frontmatter, so every file
in it loads on its own when a matching file is touched — which in this repo is essentially always.
Do **not** add `@` imports for them: `@path` imports are eager, load at launch, and defeat the very
`paths:` scoping those files declare. Four such imports here previously force-loaded 6,230 B every
session, including sessions that touched no TypeScript at all.

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

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Coverage | `npm run test:coverage` |
| Regenerate env types | `npx wrangler types` |
| Deploy dry-run | `npx wrangler deploy --dry-run` |
| Dev server | `npm run dev` |

CI runs `wrangler types` → `typecheck` → `test` → `deploy --dry-run` on Node 22.
Node 20 fails at the `wrangler types` step, before tests run.

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

The `orch-*` family runs through `ecc:orch-pipeline` and spawns subagents — confirm
with the user first if the session is configured against agent delegation.

Language rules below are auto-loaded; they are not optional. The 80% coverage bar in
`testing.md` is currently **not met** (42% as of the workerd migration) — treat it as
the target when adding tests, and do not delete a test to make a number look better.

## Rules

@.claude/rules/ecc/typescript/coding-style.md
@.claude/rules/ecc/typescript/patterns.md
@.claude/rules/ecc/typescript/security.md
@.claude/rules/ecc/typescript/testing.md

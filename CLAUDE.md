# kagi-shinobi

Cloudflare Worker fronting Kagi search + summarizer, exposed as remote MCP and REST.

## Stack

- TypeScript (ES2022, `strict`, `noUnusedLocals`, `noUnusedParameters`), ESM only, no JS
- Cloudflare Workers — Durable Objects (`KagiMcpAgent`, `ResearchRun`), KV (`TOKEN_KV`), Browser Rendering
- `@modelcontextprotocol/sdk` + `agents` for the MCP surface; `zod` for schemas; `cheerio` for scrape parsing
- Vitest via `@cloudflare/vitest-pool-workers` (tests run in workerd, not Node)

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
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

## Rules

@.claude/rules/ecc/typescript/coding-style.md
@.claude/rules/ecc/typescript/patterns.md
@.claude/rules/ecc/typescript/security.md
@.claude/rules/ecc/typescript/testing.md

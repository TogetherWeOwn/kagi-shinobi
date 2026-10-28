# kagi-shinobi

Cloudflare Worker that fronts Kagi's search and summarizer through a session
token, exposing them both as a **remote MCP server** and a **REST API**. Uses
Chrome browser headers on every upstream call and refreshes its session token
automatically via Cloudflare Browser Rendering when the current one expires.

Built on top of [`czottmann/kagi-ken`](https://github.com/czottmann/kagi-ken)
(ported to Workers) and modeled after
[`czottmann/kagi-ken-mcp`](https://github.com/czottmann/kagi-ken-mcp) (ported
from stdio to Streamable HTTP).

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/mcp` | POST | Admin or client key | MCP Streamable HTTP transport, stateless (ADR 0020); GET answers 405 |
| `/search` | POST `{queries, limit?, engine?}` | Admin or client key | Direct search — max 20 queries per request; `engine` is `kagi` (default), `searxng`, or `auto` |
| `/search` | GET `?q=&format=json&limit=` | Admin or client key | One query, SearXNG-shaped `{results:[{url,title,content}]}` for `json_engine` |
| `/summarize` | POST `{url, summary_type?, target_language?}` | Admin | Direct summarize |
| `/admin/token` | POST `{token}` | Admin | Manually rotate session token |
| `/admin/refresh` | POST | Admin | Force Browser Rendering refresh |
| `/health` | GET | none / Bearer | Liveness for anyone; token-staleness detail plus the deployed `BUILD_SHA` only with the Bearer |

The admin bearer is the `ADMIN_TOKEN` secret. Use `Authorization: Bearer <token>`.

### Scoped client keys

To give an integration its own credential without sharing `ADMIN_TOKEN`, set the
optional `CLIENT_KEYS` secret to a JSON map of client name to the hex SHA-256 of
that client's key (see [ADR 0013](docs/adr/0013-scoped-client-keys-and-searxng-get-search.md)):

```bash
KEY=$(openssl rand -hex 32)          # give this to the client
printf '%s' "$KEY" | sha256sum       # store only the digest
printf '{"searxng":"<digest>"}' | npx wrangler secret put CLIENT_KEYS
```

A client key reaches `/search` (GET and POST) and `/mcp` only; anything else
answers `403 forbidden-scope`. Per-client-key volume windows `CLIENT_KEY_RPM`
and `CLIENT_KEY_RPD` both default to `0` (disabled — no per-key volume cap),
on top of `PER_BEARER_RPM`. A 429 from a re-enabled window carries
`Retry-After`, so a SearXNG `json_engine` degrades to its other engines
instead of failing the query.

### Global Kagi call budget

Independently of who calls, every request that actually reaches Kagi passes
the global pacer: `KAGI_CALLS_PER_SECOND` (default 2, paced — callers wait out
the current second, bounded, before a `429` with `Retry-After`).
`KAGI_CALLS_PER_DAY` and `KAGI_CALLS_PER_MONTH` default to `0` (disabled — no
volume caps). A fan-out of N queries costs N pacer slots. When the Meter
counter itself is unreachable the pacer fails open (isolate-local slot queue
at the per-second rate, refusing past a 3 s wait, then admit) so search stays
up. `0` disables a window. See ADR 0019.

**SearXNG `json_engine`:**
```yaml
  - name: kagi
    engine: json_engine
    shortcut: kg
    search_url: https://<your-host>/search?q={query}&format=json
    headers:
      Authorization: Bearer <client key>
    results_query: results
    url_query: url
    title_query: title
    content_query: content
```

## MCP tools exposed

`tools/list` advertises the tools below for the **resolved** `KAGI_MODE`.
`yes` means registered, not that credentials, spend permission or upstream
availability have been verified. Explicit `scrape`, `api` and `hybrid` modes
are honored even when credentials are missing. With `KAGI_MODE=auto` (the
resolver default when unset), a session token alone selects `scrape`, an API
key alone selects `api`, both select `hybrid`, and neither is a configuration
error. The checked-in deployment configuration selects `scrape` explicitly.

| Tool | Purpose / principal inputs | scrape | api | hybrid |
|---|---|---|---|---|
| `kagi_search_fetch` | Search `queries` (1–20); optional `limit` (1–50), `engine` (`kagi`, `searxng`, `auto`), `impl`, `response_format`, `max_age_s` | yes | yes | yes |
| `kagi_summarizer` | Summarize a `url`; optional `summary_type` (`summary`, `takeaway`), `target_language`, `impl`, `max_age_s` | yes | yes | yes |
| `kagi_small_web` | Search Small Web with optional `q` and `limit`; omitting `q` browses the public feed on the scrape path, but uses API search on the API path | yes | yes | yes |
| `kagi_summarize_url` | Summarize a `url` with optional summarizer `engine`, `confirm_muriel`, `summary_type`, `target_language`, `impl`, `max_age_s` | yes | yes | yes |
| `kagi_fastgpt` | Answer a `query` with references; optional `cache`, `impl`, `max_age_s` | yes | yes | yes |
| `kagi_personalized_rank` | Rerank `urls` (1–20); optional `q`, `rules`, `impl`; API ranking requires `q`, scrape ranking ignores `rules` | yes | yes | yes |
| `kagi_research_create_run` | Start research for a `question`; optional `depth` (1–3, default 1), `budget_cents` (default 0), `allow_api` (default true); returns `run_id` | yes | yes | yes |
| `kagi_research_wait_for_run` | Wait on `run_id`; `timeout_seconds` is 1–300 (default 30); returns current state on completion or timeout | yes | yes | yes |
| `kagi_research_get_output` | Read current state for `run_id`, including report text when done | yes | yes | yes |
| `kagi_research_cancel_run` | Request cooperative cancellation of `run_id`; does not abort an in-flight upstream call | yes | yes | yes |
| `kagi_summarize_text` | Summarize raw `text`; optional summarizer `engine`, `confirm_muriel`, `summary_type`, `target_language`, `max_age_s` | — | yes | yes |
| `kagi_extract` | Extract `urls` (1–10); optional `format` (`markdown`, `text`), `timeout_ms` | — | yes | yes |
| `kagi_enrich_web` | Search Teclis with `q`; returns metadata, not page bodies | — | yes | yes |
| `kagi_enrich_news` | Search TinyGem with `q`; returns metadata, not page bodies | — | yes | yes |

The last four tools are omitted entirely in scrape mode. `kagi_search` and
`kagi_list_lenses` are capability-table entries, **not registered MCP tools**.
This is a principal-input inventory, not a replacement for the full schemas:
read `tools/list` on your deployment for exact arguments, defaults and output
schemas. It does not establish drop-in compatibility with upstream clients.

### Execution gates and research limits

- Every `/mcp` request requires `ADMIN_TOKEN` or a configured scoped client key
  (see above). Client-key scope is path-level, not a per-tool allowlist; it
  does not grant access to the admin-only REST `/summarize` or `/admin/*` routes.
- Official API paths require `KAGI_API_KEY`; authenticated scrape paths need
  a live session token. Small Web's public feed on the scrape path needs no
  Kagi session. Registration alone does not validate either credential.
- Hybrid prefers scrape for tools that support both implementations;
  API-only tools still use the API. Where offered, `impl` selects the path
  within the resolved mode. Search's `engine` instead selects Kagi, SearXNG
  or automatic fallback; SearXNG requires its own configuration (see below).
- `MAX_API_CENTS_PER_MONTH=0` (the default) refuses new billable API calls,
  even if the tool is listed and an API key is present. Zero-cost result-cache
  hits and free paths are distinct from permission to spend. Listing a tool
  does not enable paid API use or relax the existing rate/spend controls.
  Muriel summaries require `confirm_muriel=true` by default; confirmation
  does not override the API cap.
- Research create/wait/output/cancel are registered in every mode. A wait
  can time out while work continues, and cancellation is cooperative rather
  than an immediate terminal-state transition. Output exposes stored state;
  do not assume a partial report is available before completion.
- Research `budget_cents=0` or `allow_api=false` skips FastGPT planning/synthesis
  and API extraction. It is **not a universal no-API guarantee or a hard
  per-run spend ceiling**: search and fallback URL summaries still follow
  the resolved mode. Keep the global API cap at `0` to refuse new billable
  calls; do not raise it merely to exercise a listed tool.

### Offline inventory verification

Against `registerKagiMcp` and its existing registration/schema tests, this
inventory documents **10/10** registered tools in scrape mode and **14/14**
in each of API and hybrid modes, with zero falsely advertised tools. Verify
without Kagi traffic or a browser:

```bash
npm test -- test/workers/mcp-tools.test.ts test/workers/mcp-schema-contract.test.ts
```

These tests use mocked clients; the schema tests use an in-memory MCP
connection (API and scrape snapshots, plus schema assertions). They verify
registration and local contracts, **not production compatibility**. Missing
credentials, stale sessions, cap-0 billable calls, unconfigured fallback and
upstream failures remain blocked or unverified execution scenarios. No live
Kagi execution or real consumer outcome is established by these counts.

## Setup

```powershell
# 1. Install
npm install

# 2. Create the KV namespace and copy the id into wrangler.jsonc
wrangler kv namespace create TOKEN_KV

# 3. Set secrets
wrangler secret put ADMIN_TOKEN          # openssl rand -hex 32
wrangler secret put KAGI_SESSION_TOKEN   # from kagi.com/settings
wrangler secret put KAGI_EMAIL           # optional, for auto-refresh
wrangler secret put KAGI_PASSWORD        # optional, for auto-refresh

# 4. Deploy
wrangler deploy
```

For local dev, copy `.dev.vars.example` to `.dev.vars`, fill in values, then
`npm run dev`.

## SearXNG fallback engine

Kagi scrape mode rides one personal subscription, so it must stay
human-scale. A self-hosted SearXNG instance is free and unlimited but noisier — use it as the
fallback tier via the `engine` param on `POST /search` and
`kagi_search_fetch`: `kagi` (default, current behavior), `searxng` (straight
to the fallback), or `auto` (Kagi while under budget and the session is
healthy, otherwise SearXNG, with the switch recorded in `meta.warnings`).
Results keep the same schema either way (`source_impl: "searxng"`).

Setup (operator deployment work, through the gated deploy path):

```powershell
# 1. Point the worker at your SearXNG instance — a Tunnel hostname (or binding),
#    never an IP, and never the Caddy /mcp-ext path
#    (wrangler.jsonc var; empty = fallback unconfigured)
#    "SEARXNG_BASE_URL": "https://searxng.<your-tunnel>.cfargotunnel.com"

# 2. Only when the Tunnel sits behind Cloudflare Access:
wrangler secret put SEARXNG_ACCESS_CLIENT_ID
wrangler secret put SEARXNG_ACCESS_CLIENT_SECRET
```

See [ADR 0014](docs/adr/0014-searxng-fallback-engine.md).

## Client config

**Claude Desktop / MCP Inspector — remote MCP:**
```json
{
  "mcpServers": {
    "kagi-shinobi": {
      "url": "https://kagi-shinobi.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your ADMIN_TOKEN>" }
    }
  }
}
```

**curl — direct search:**
```bash
curl -X POST https://kagi-shinobi.<subdomain>.workers.dev/search \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"queries":["cloudflare workers durable objects"],"limit":5}'
```

## Token auto-refresh (Option C hybrid)

- Primary: the `KAGI_SESSION_TOKEN` secret / KV cache is used for every request.
- On upstream `401`/`403`: the worker marks the KV entry stale and, if
  `AUTO_REFRESH_ENABLED=true` and Browser Rendering is available, spawns a
  Puppeteer session that logs into Kagi with `KAGI_EMAIL`/`KAGI_PASSWORD`,
  reads the fresh `kagi_session` cookie, and writes it to KV.
- Manual override: `POST /admin/token` accepts a new token any time.
- If auto-refresh is disabled or fails, `/search` and `/summarize` return
  `401 kagi-token-stale` and `/health` reports `"token": "stale"` — to callers
  presenting the Bearer. Without it, `/health` returns `{"ok": true}` only.

Set `AUTO_REFRESH_ENABLED=false` in `wrangler.jsonc` `vars` if you don't want
to pay for Browser Rendering — you'll rotate tokens manually via
`/admin/token`.

## License

MIT. Upstream `kagi-ken` and `kagi-ken-mcp` are also MIT — see `src/kagi/*`
for attribution headers on ported files.

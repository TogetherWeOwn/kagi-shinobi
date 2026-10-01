# ADR 0013 — Scoped client keys and a SearXNG-shaped GET /search

**Status:** Accepted — 2026-10-01

## Context

The only credential was `ADMIN_TOKEN`, which can also overwrite the Kagi
session (`/admin/token`) and trigger billable Browser Rendering
(`/admin/refresh`). Wiring a metasearch front end (SearXNG) to this worker
would have meant putting that token into a third-party config file. SearXNG's
built-in `json_engine` can send custom headers and read a JSON array of
`{url, title, content}`, but it issues a GET with the query in the URL; the
existing `/search` is POST-only with a batch body.

Scrape mode rides one personal Kagi subscription, so an integration must stay
at human-scale volume.

## Decision

- New optional secret `CLIENT_KEYS`: JSON `{name: sha256_hex(key)}`. Only
  digests are stored. `ADMIN_TOKEN` is unchanged and still accepted
  everywhere.
- `authenticate()` resolves a bearer to `admin` or `client:<name>`. Client
  keys are compared digest-to-digest (fixed 64 chars), walking every entry.
- Client keys reach `/search` and `/mcp` only. Anything else answers
  `403 forbidden-scope`. `/health` detail stays admin-only.
- Client keys are metered by name in the existing Meter Durable Object
  (ADR 0006), in two windows: `CLIENT_KEY_RPM` (default 10) and
  `CLIENT_KEY_RPD` (default 300 per UTC day). `PER_BEARER_RPM` still applies on
  top. The day window reuses `Meter.checkRate` with the day index as bucket.
- `GET /search?q=&format=json[&limit=]` runs one query through the same
  `client.search` as POST and returns
  `{query, number_of_results, results:[{url,title,content,engine,...}], answers, suggestions}`.
  The canonical `SearchResponse` (ADR 0003) is unchanged; this is a view.

## Consequences

- Revoking one integration is a `CLIENT_KEYS` edit; the admin token and Kagi
  session are untouched.
- The query string of GET /search can appear in access logs. Keys must go in
  the `Authorization` header, never the URL.
- A client key can call MCP tools, including `kagi_summarizer` and research
  tools reachable through `/mcp`. Scoping individual MCP tools per principal
  is out of scope here; the per-name limits bound the volume.

# ADR 0020 — Serve /mcp statelessly, without a per-session Durable Object

**Status:** Accepted — 2026-10-27

## Context

`/mcp` was served by `KagiMcpAgent.serve("/mcp")` (agents `McpAgent`). That
path creates one Durable Object per MCP session, and each object persists the
session's props, transport state and SSE event log (`DurableObjectEventStore`)
in its own SQLite storage. Nothing ever deletes an object: by 2026-10-27 the
`KagiMcpAgent` namespace held 25,967 stored objects (3.41 GB) while only 627
had been active in the billing period.

The question is whether that state needs to exist at all. Read against
`src/mcp.ts` and the agents 0.28.1 docs (`node_modules/agents/docs/mcp-servers.md`,
`mcp-transports.md`), it does not:

| Per-session feature McpAgent provides | Used by kagi-shinobi? |
| --- | --- |
| `this.state` / `setState` / `this.sql` | No — no tool reads or writes agent state |
| Server-to-client requests (elicitation, sampling, roots) | No — no tool asks the client anything |
| Standalone GET SSE stream for server-initiated messages | No — nothing is pushed: no list-changed, no resource subscriptions, no logging |
| `Last-Event-ID` resumability via the DO event store | Not needed — see Consequences |
| OAuth `props` carried per session | No — auth is the worker's bearer gate (ADR 0013), checked on every request |
| Remembered client capabilities | No — only consulted for the server-to-client requests above |

Everything that *is* durable already lives elsewhere and is keyed by something
other than the MCP session: the spend and rate counters in the `Meter` DO
(ADR 0006), cached results in `ResultCache` (ADR 0017), research runs in the
`ResearchRun` singleton keyed by `run_id` (ADR 0004), the session token in KV.

The agents docs also mark `McpAgent` deprecated and feature-frozen, and point
new servers at a per-request stateless handler.

## Decision

- `/mcp` goes through `src/mcp/serve.ts`: each request builds a fresh
  `McpServer` with `createKagiMcpServer()` and serves it through
  `createLegacyMcpHandler` from `agents/mcp` with no `sessionIdGenerator` and
  no storage — the SDK v1 transport's stateless mode. No Durable Object is
  addressed, nothing is persisted.
- The server stays on `@modelcontextprotocol/sdk` v1, so the zod → JSON Schema
  conversion that ADR 0009 treats as a wire contract is untouched
  (`mcp-schema-contract.test.ts` snapshots are unchanged). Moving to SDK v2's
  `createMcpHandler` from `agents/mcp/server` is a separate decision: it changes
  the registration API and the advertised protocol, and would need its own
  contract review.
- `GET /mcp` answers 405 (the spec's answer for a server with no standalone
  SSE stream) instead of parking an SSE response nothing writes to.
- The bearer gate, client-key scoping and per-bearer rate limit stay in front
  of `/mcp` in `src/index.ts`, exactly where they were.
- `KagiMcpAgent` stays exported, delegating to the same `registerKagiMcp()`,
  because `wrangler.jsonc` still binds `MCP_OBJECT` to it.

## Consequences

- No new `KagiMcpAgent` objects are created after deploy. Clients that still
  send an old `Mcp-Session-Id` are served normally: stateless mode ignores it.
- Lost: `Last-Event-ID` replay of a dropped response stream. Response streams
  carry the SDK's SSE keep-alive frames (every 15 s), which keep long calls
  such as `kagi_research_wait_for_run` (≤ 300 s) open; a stream that still
  drops is retried by the client, and every tool except
  `kagi_research_create_run` is a read. `create_run` returns in one round trip.
- Each request pays for registering ~15 tools, 4 resources and 5 prompts.
  That is in-isolate object construction, cheaper than the DO round trip and
  WebSocket bridge it replaces.
- **One-time cleanup (follow-up, not in this change).** The 25,967 existing
  objects are not deleted by this ADR. Once this has run in production for a
  few days, a follow-up removes the `MCP_OBJECT` binding and the class and
  adds `{ "tag": "v5", "deleted_classes": ["KagiMcpAgent"] }` to
  `wrangler.jsonc`'s migrations; Cloudflare deletes every object of a deleted
  class together with its storage. It is a separate step because it is
  irreversible: after it, rolling back to a release that routes to
  `KagiMcpAgent` needs a new class name, whereas until then a plain revert
  restores the old path.
- Rollback before the cleanup: revert the commit and redeploy.

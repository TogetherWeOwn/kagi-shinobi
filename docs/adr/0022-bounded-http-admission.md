# ADR 0022 — Bound input before parsing or dispatch

**Status:** Accepted — 2026-10-28  
**Partially supersedes:** [ADR 0020](0020-stateless-mcp-serving.md) (batch compatibility)  
**Clarifies:** [ADR 0008](0008-bound-request-fan-out.md)

Authentication and request-rate accounting run before the REST/MCP handlers. Neither a per-request query limit nor a request-rate limit bounds the bytes parsed for one admitted request. Agents also parses and scans initialization messages before the SDK transport's own guards, so upgrading the SDK alone does not establish application-level admission.

Use the patched SDK's existing **4 MiB raw-input bound** before JSON parsing on POST `/search`, `/summarize`, and `/mcp`. Refuse oversized declared lengths without reading; otherwise count actual bytes, including with absent or understated Content-Length, and cancel the stream on overflow. Exactly-at-limit bodies remain admissible. REST returns HTTP 413 in its existing error envelope with code `payload-too-large`; MCP retains its JSON-RPC error envelope. Invalid JSON/read failures use fixed parse-error messages, not exception text. Unknown MCP subpaths return their existing 404 before inspecting the body; the outer authentication/rate gates still precede route rejection.

**Reject every JSON-RPC array at `/mcp` with HTTP 400, code `-32600`, message `Invalid Request`, and `id: null`, before entering Agents.** This includes empty arrays, one-item arrays and over-count arrays. A single HTTP request can therefore dispatch at most one MCP message/tool call, rather than multiply the per-tool query ceiling from ADR 0008 or run Agents' per-item initialization validation before rejection. Single-object initialize, notification and tool-call requests retain their existing behavior, schemas and per-tool bounds.

Keeping generic JSON-RPC batching would require aggregate work accounting across heterogeneous tools and a separate early message-count guard. Rejecting it is smaller and leaves the stateless transport, keep-alives, tool schemas, cache and billing logic unchanged. Batch clients must send individual requests; they must not automatically retry a rejected batch as an unbounded burst. This intentionally narrows ADR 0020's wire-compatibility statement without introducing sessions or storage.

The byte bound limits admitted input, not aggregate concurrency, request duration, decoded-memory overhead or live-provider load. Existing rate, fan-out and monthly spend fences remain necessary and unchanged. Regression cases use local bounded streams and harmless stubbed work; no production load or availability claim follows from them.

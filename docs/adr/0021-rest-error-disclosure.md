# ADR 0021 — Restrict REST error disclosure

**Status:** Accepted — 2026-10-28  
**Partially supersedes:** [ADR 0012](0012-one-error-vocabulary-two-envelopes.md)

## Context

REST previously returned exception messages and arbitrary `KagiError.detail` values. Those can include internal exception information or an upstream response body, including stack traces. The batched search endpoint likewise returned arbitrary rejection reasons. A scoped search client can reach these responses.

## Decision

Keep the existing status, code, and error envelope mapping from ADR 0012, but derive client-facing messages from a closed vocabulary. Unexpected errors receive a generic message. Restrict details to finite numeric operational values (`status`, `retry_after`, `spent_cents`, `cap_cents`, `ms`, and `cost_cents`); arbitrary text and fields are no longer sent. Retain `Retry-After` when its numeric value is present. Batched failures use the same safe vocabulary. The timeout remains distinguishable via its typed error: GET search returns its mapped HTTP 504 envelope, while POST search retains HTTP 200 with a failed batch item.

Successful search and summarize responses also pass through this disclosure boundary: omit diagnostic warning strings, replacing them with a fixed fallback notice when `meta.impl` is `searxng`. Preserve result content and other metadata, including cache information, without mutating the canonical or cached response. Do not try to extract safe fragments from arbitrary warning prose.

This narrows ADR 0012's promise to forward every detail and changes error prose and batched error strings. For REST error envelopes, clients must use the HTTP status and error code rather than parse error messages. Batched `/search` responses remain HTTP 200: clients must check each result's `ok` field and treat `error` as display text, since failed items have no per-result status or code. Useful numeric diagnostic information remains available, while raw upstream and exception diagnostics do not cross the REST boundary. MCP response data and error disclosure are unchanged.

# ADR 0021 — Restrict REST error disclosure

**Status:** Accepted — 2026-10-28  
**Partially supersedes:** [ADR 0012](0012-one-error-vocabulary-two-envelopes.md)

## Context

REST previously returned exception messages and arbitrary `KagiError.detail` values. Those can include internal exception information or an upstream response body, including stack traces. The batched search endpoint likewise returned arbitrary rejection reasons. A scoped search client can reach these responses.

## Decision

Keep the existing status, code, and error envelope, but derive client-facing messages from a closed vocabulary. Unexpected errors receive a generic message. Restrict details to finite numeric operational values (`status`, `retry_after`, `spent_cents`, `cap_cents`, `ms`, and `cost_cents`); arbitrary text and fields are no longer sent. Retain `Retry-After` when its numeric value is present. Batched failures use the same safe vocabulary. The timeout remains distinguishable via its typed error.

This narrows ADR 0012's promise to forward every detail and changes error prose and batched error strings; clients must use the status and code rather than parse error messages. Useful numeric diagnostic information remains available, while raw upstream and exception text does not cross the REST boundary. MCP behavior is unchanged.

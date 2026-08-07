# Architecture Decision Records

Add an ADR before changing tri-mode dispatch, response shapes, the async
research trio, or the protective counters. Supersede rather than edit: a
decision that turned out wrong is more useful with its correction attached
than quietly rewritten.

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-tri-mode-architecture.md) | Tri-mode architecture (scrape / api / hybrid) | accepted | 2026-07-11 |
| [0002](0002-scraped-session-vs-paid-api.md) | Scraped session vs. paid API | accepted | 2026-07-11 |
| [0003](0003-canonical-response-shapes.md) | Canonical response shapes | accepted | 2026-07-11 |
| [0004](0004-deep-research-async-trio.md) | Deep research async trio + Durable Object | accepted | 2026-07-11 |
| [0005](0005-per-bearer-rate-limiting.md) | Per-bearer rate limiting | superseded by 0006 | 2026-07-11 |
| [0006](0006-serialize-rate-and-spend-counters.md) | Serialize the rate-limit and spend counters in a Durable Object | accepted | 2026-08-06 |
| [0007](0007-bound-token-cache-and-coordinate-refresh.md) | Bound the token cache to KV's propagation window, coordinate refreshes in the Meter | accepted | 2026-08-06 |
| [0008](0008-bound-request-fan-out.md) | Bound per-request fan-out at both front doors | accepted | 2026-08-06 |

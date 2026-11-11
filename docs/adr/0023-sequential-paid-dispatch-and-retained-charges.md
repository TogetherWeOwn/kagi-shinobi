# ADR 0023 — Sequential paid dispatch and retained-charge bookkeeping in research

**Status:** Accepted — 2026-11-08  
**Supersedes:** the parallel-search assumption inside [ADR 0004](0004-deep-research-async-trio.md)  
**Clarifies:** [ADR 0006](0006-serialize-rate-and-spend-counters.md)

ADR 0004 described paid subquery searches fanning out in parallel. That scheduling reads the DO's persisted `cost_cents` as the budget source of truth — a value that only learns about a call after its step write lands. A batch of concurrent paid calls therefore all pass a pre-flight check against the same stale balance, and a run budget stops being a ceiling exactly when calls are fast or persistence is degraded.

**Paid pipeline stages dispatch sequentially.** Before each paid call the pipeline re-checks `remaining = budget - max(persisted spend, locally booked spend)`, where the local tracker books each dispatched call's `meta.cost_cents` immediately — and books the *projected* charge carried by `withChargedCost` on any throw after the monthly guard admitted the call (settled or not). Free scrape paths keep the previous `Promise.allSettled` fan-out: nothing is billed, so there is no ceiling to defend.

A call whose budget check fails is not dispatched; the pipeline emits a `budget exhausted` step for that subquery and continues, so run output shows skipped work explicitly rather than failing the run. Cancellation is re-checked between paid calls, not only between stages.

**Step-write persistence is unreliable by contract.** A rejected write records nothing (the DO persists step and cost in one update), so a settled charge attached to a failed write is retried once, carried onto the next write, and flushed once more at end of run. Spend still unrecorded after the final flush is returned to the DO as `unrecorded_cents` and folded into the terminal row's `cost_cents` in the same SQL update that marks the run done — a run can never report success with less recorded spend than its paid calls retained; if even that write fails the run is marked failed instead.

## Consequences

- Paid runs serialize search and summarize calls; worst-case wall-clock grows by the number of subqueries. Acceptable: runs already take tens of seconds and yield often.
- The run budget is a hard ceiling on the failure paths, not just the happy path, including calls that settle a charge and then fail in our hands.
- The monthly ledger (`src/kagi/api/cost.ts`) retains the projected charge on every admitted throw; the run ledger reconciles it via the carried-flush-and-terminal-fold mechanism above rather than dropping it.

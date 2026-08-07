// Meter — the serialization point for both protective counters.
//
// Why a Durable Object and not KV: both counters were previously KV
// read-then-write. Concurrent requests read the same value and each wrote
// `value + 1`, so ten parallel calls advanced the counter by one. The error
// ran toward UNDER-counting — letting traffic and spend past the limit — the
// opposite of what ADR 0005 and the old comments claimed. Workers KV has no
// compare-and-swap, so the race cannot be closed at that layer.
//
// Every method below is synchronous end to end. `ctx.storage.sql` is a
// synchronous API, and a DO processes one call at a time, so a method that
// never awaits between its read and its write is atomic. Do not introduce an
// `await` inside these methods — that is precisely what reopens the race.
//
// See docs/adr/0006-serialize-rate-and-spend-counters.md.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** Keep two minutes of rate buckets so a clock skew of one minute is safe. */
const RATE_RETENTION_MINUTES = 2;

export interface RateVerdict {
  allowed: boolean;
  limit_rpm: number;
  count: number;
  retry_after_seconds?: number;
}

export interface SpendVerdict {
  ok: boolean;
  spent_cents: number;
  cap_cents: number;
}

export class Meter extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS rate (
          bucket INTEGER NOT NULL,
          n INTEGER NOT NULL,
          PRIMARY KEY (bucket)
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS spend (
          month TEXT PRIMARY KEY,
          cents REAL NOT NULL
        )`,
      );
    });
  }

  /**
   * Check-and-increment one rate bucket. Instances are addressed per bearer
   * (idFromName(bearerHash)), so `bucket` only needs to distinguish minutes.
   */
  checkRate(limit: number, minute: number, msIntoMinute: number): RateVerdict {
    if (limit <= 0) return { allowed: true, limit_rpm: 0, count: 0 };

    this.ctx.storage.sql.exec("DELETE FROM rate WHERE bucket < ?", minute - RATE_RETENTION_MINUTES);

    const rows = [...this.ctx.storage.sql.exec("SELECT n FROM rate WHERE bucket = ?", minute)];
    const current = rows.length > 0 ? Number(rows[0].n) : 0;

    if (current >= limit) {
      const retry = Math.max(1, Math.ceil((60_000 - msIntoMinute) / 1000));
      return { allowed: false, limit_rpm: limit, count: current, retry_after_seconds: retry };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO rate (bucket, n) VALUES (?, 1)
       ON CONFLICT (bucket) DO UPDATE SET n = n + 1`,
      minute,
    );
    return { allowed: true, limit_rpm: limit, count: current + 1 };
  }

  /**
   * Reserve budget for a billable call. The projected amount is debited at
   * admission, not after the network round-trip — otherwise two concurrent
   * callers both admit against the same stale total. `settleSpend` then
   * applies the difference once the real cost is known.
   */
  reserveSpend(month: string, projectedCents: number, capCents: number): SpendVerdict {
    const spent = this.readSpendRow(month);

    // capCents <= 0 means the operator has not opted into paid API usage.
    if (capCents <= 0) return { ok: false, spent_cents: spent, cap_cents: capCents };
    if (spent + projectedCents > capCents) {
      return { ok: false, spent_cents: spent, cap_cents: capCents };
    }

    this.writeSpend(month, spent + projectedCents);
    return { ok: true, spent_cents: spent + projectedCents, cap_cents: capCents };
  }

  /**
   * Apply the difference between the actual and the reserved cost. Negative
   * deltas are normal — /enrich is only billed on non-zero results, so a call
   * that came back empty refunds its whole reservation.
   */
  settleSpend(month: string, deltaCents: number): number {
    const next = Math.max(0, this.readSpendRow(month) + deltaCents);
    this.writeSpend(month, next);
    return next;
  }

  spendSnapshot(month: string): number {
    return this.readSpendRow(month);
  }

  private readSpendRow(month: string): number {
    const rows = [...this.ctx.storage.sql.exec("SELECT cents FROM spend WHERE month = ?", month)];
    if (rows.length === 0) return 0;
    const value = Number(rows[0].cents);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private writeSpend(month: string, cents: number): void {
    // Round to 4dp so float drift cannot accumulate across many debits.
    const rounded = Math.round(cents * 10_000) / 10_000;
    this.ctx.storage.sql.exec(
      `INSERT INTO spend (month, cents) VALUES (?, ?)
       ON CONFLICT (month) DO UPDATE SET cents = excluded.cents`,
      month,
      rounded,
    );
  }
}

// Monthly API-cost cap.
//
// Every billable API call passes through `guardBillable()` which:
//   1. Reads the current UTC month's spend from KV.
//   2. Rejects with KagiBudgetExceededError if spend + charge would exceed
//      MAX_API_CENTS_PER_MONTH.
//   3. Debits KV after the call succeeds.
//
// The counter key is `api-spend-<YYYY-MM>` so a fresh key auto-starts each
// month; no cron / migration needed. Per Kagi's docs, /enrich is only billed
// on non-zero results — the caller of guardBillable() is responsible for
// passing 0 when nothing came back.

import type { Env } from "../../env.js";
import { KagiBudgetExceededError } from "../errors.js";

const KEY_PREFIX = "api-spend-";

function monthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${KEY_PREFIX}${y}-${m}`;
}

export function readCap(env: Env): number {
  const raw = env.MAX_API_CENTS_PER_MONTH ?? "0";
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function readSpend(env: Env, now: Date = new Date()): Promise<number> {
  const raw = await env.TOKEN_KV.get(monthKey(now));
  if (!raw) return 0;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

async function debit(env: Env, cents: number, now: Date = new Date()): Promise<void> {
  if (cents <= 0) return;
  const current = await readSpend(env, now);
  // Round to 4 decimal places to avoid float drift after millions of debits.
  const next = Math.round((current + cents) * 10_000) / 10_000;
  await env.TOKEN_KV.put(monthKey(now), String(next));
}

export interface Guard {
  /** Call after the network round-trip completes with the ACTUAL cost. */
  settle(actualCents: number): Promise<void>;
}

/**
 * Reserve budget for a billable call. Rejects if the projected cost would
 * push spend past the cap. The returned Guard must be settled with the
 * actual charge (which may be 0 for enrich when no results come back, or
 * the full amount otherwise). Failing to settle biases toward
 * over-throttling on the next call — safe by design.
 */
export async function guardBillable(
  env: Env,
  projectedCents: number,
): Promise<Guard> {
  const cap = readCap(env);
  const spent = await readSpend(env);
  if (cap <= 0) {
    // MAX_API_CENTS_PER_MONTH=0 → the operator has not opted into paid API
    // usage. Refuse before the network call.
    throw new KagiBudgetExceededError(spent, cap);
  }
  if (spent + projectedCents > cap) {
    throw new KagiBudgetExceededError(spent, cap);
  }
  return {
    async settle(actualCents: number) {
      await debit(env, Math.max(0, actualCents));
    },
  };
}

/** For /health + the api-status resource in S9. */
export async function budgetSnapshot(env: Env): Promise<{
  cap_cents: number;
  spent_cents: number;
  remaining_cents: number;
  month: string;
}> {
  const cap = readCap(env);
  const spent = await readSpend(env);
  return {
    cap_cents: cap,
    spent_cents: spent,
    remaining_cents: Math.max(0, cap - spent),
    month: monthKey().slice(KEY_PREFIX.length),
  };
}

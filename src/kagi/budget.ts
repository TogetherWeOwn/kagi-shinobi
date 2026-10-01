// Global upstream Kagi call budget (ADR 0013).
//
// Every rate limit before this one counted *requests to the worker*. One
// request can fan out into many Kagi calls (POST /search takes 20 queries,
// kagi_personalized_rank probes up to 20 URLs), and MCP protocol traffic eats
// the per-bearer limit without reaching Kagi at all. Scrape mode rides one
// personal subscription, so what has to stay human-scale is the number of
// calls that actually reach kagi.com — across every caller, admin included.
//
// takeKagiCall() is called immediately before each upstream Kagi fetch. The
// day and month windows refuse outright; the per-second window paces, waiting
// out the current second (bounded) before refusing. Fails CLOSED when the
// Meter is unreachable, as ADR 0006 does for the spend counter.

import type { Env } from "../env.js";
import { KagiRateLimitError } from "./errors.js";

export interface KagiCallLimits {
  perSecond: number;
  perDay: number;
  perMonth: number;
}

function readVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function readKagiCallLimits(env: Env): KagiCallLimits {
  return {
    perSecond: readVar(env.KAGI_CALLS_PER_SECOND, 2),
    perDay: readVar(env.KAGI_CALLS_PER_DAY, 600),
    perMonth: readVar(env.KAGI_CALLS_PER_MONTH, 15_000),
  };
}

/** Longest a caller waits for the per-second window before being refused. */
const MAX_PACE_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function takeKagiCall(env: Env, now: () => number = Date.now): Promise<void> {
  const { perSecond, perDay, perMonth } = readKagiCallLimits(env);
  if (perSecond <= 0 && perDay <= 0 && perMonth <= 0) return;

  let waited = 0;
  for (;;) {
    let verdict;
    try {
      const stub = env.METER.get(env.METER.idFromName("kagi-calls"));
      verdict = await stub.takeKagiCall(now(), perSecond, perDay, perMonth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KagiRateLimitError(60, `Kagi call budget unavailable, refusing: ${msg}`);
    }
    if (verdict.ok) return;
    if (verdict.window === "second" && waited + verdict.retry_after_ms <= MAX_PACE_WAIT_MS) {
      waited += verdict.retry_after_ms;
      await sleep(verdict.retry_after_ms);
      continue;
    }
    throw new KagiRateLimitError(
      Math.max(1, Math.ceil(verdict.retry_after_ms / 1000)),
      `Kagi call budget exhausted (${verdict.window}: ${verdict.count}/${verdict.limit})`,
    );
  }
}

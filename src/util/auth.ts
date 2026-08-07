// Bearer-token gate for every non-/health endpoint.
//
// The comparison below does NOT leak *which* character differs: the loop XORs
// every position and only tests the accumulator at the end. It DOES leak the
// token's length, via the early return in timingSafeEqual — an earlier version
// of this comment claimed otherwise, which was wrong.
//
// Measured rather than argued (2026-08-06, Node 22, 2M iterations, median of
// 7 rounds, against a 43-char secret):
//
//   wrong token, same length : 105.35 ns/call   (walks the full loop)
//   wrong token, diff length :   1.80 ns/call   (early return)
//   delta                    : 103.55 ns        (58x ratio)
//
// The ratio is stark but the absolute delta is ~100 ns against 1-10 ms of
// internet jitter, so separating the two needs on the order of 1e8 requests —
// roughly three years at the default PER_BEARER_RPM=60 — and yields only the
// length, not the token. Left as-is deliberately. The fix is to compare
// SHA-256 digests, which is correct but makes requireBearer async and every
// caller with it; do that if the rate limit is raised substantially, if this
// gate moves somewhere unmetered, or if ADMIN_TOKEN stops being a
// high-entropy generated value.

import type { Env } from "../env.js";
import { jsonError } from "./errors.js";

export function requireBearer(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return jsonError(401, "missing-bearer", "Authorization: Bearer <token> required");
  }
  const provided = header.slice("Bearer ".length).trim();
  if (!env.ADMIN_TOKEN) {
    return jsonError(500, "server-misconfigured", "ADMIN_TOKEN secret not set");
  }
  if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonError(401, "invalid-bearer", "Bearer token rejected");
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

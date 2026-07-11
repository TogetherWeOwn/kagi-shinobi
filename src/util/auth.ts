// Bearer-token gate for every non-/health endpoint.
// Uses constant-time comparison to avoid leaking token length via timing.

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

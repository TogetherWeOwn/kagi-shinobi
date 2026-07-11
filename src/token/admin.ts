// /admin/token and /admin/refresh handlers.

import type { Env } from "../env.js";
import { jsonError, jsonOk } from "../util/errors.js";
import { loadToken, saveToken } from "./store.js";
import { refreshTokenViaBrowser } from "./refresh.js";

export async function handleAdminToken(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    return jsonError(400, "missing-token", "Body must be { token: string }");
  }

  await saveToken(env, {
    token: token.trim(),
    updatedAt: Date.now(),
    source: "admin",
    stale: false,
  });
  return jsonOk({ ok: true, source: "admin" });
}

export async function handleAdminRefresh(_request: Request, env: Env): Promise<Response> {
  const result = await refreshTokenViaBrowser(env);
  if (!result.ok) {
    return jsonError(503, "refresh-failed", result.reason ?? "unknown refresh error");
  }
  return jsonOk({ ok: true, source: "browser-refresh" });
}

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const envelope = await loadToken(env);
  const tokenStatus = !envelope
    ? "missing"
    : envelope.stale
    ? "stale"
    : "ok";
  return jsonOk({
    ok: true,
    token: tokenStatus,
    updatedAt: envelope?.updatedAt ?? null,
    source: envelope?.source ?? null,
    autoRefresh: env.AUTO_REFRESH_ENABLED === "true",
  });
}

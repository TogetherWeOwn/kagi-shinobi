// Worker routing, in workerd.
//
// This is the file that proves the public/gated split in src/index.ts is
// what CLAUDE.md claims: "every non-/health path requires the ADMIN_TOKEN
// bearer". Unit tests on requireBearer alone cannot prove that — they show
// the gate works, not that it is actually *wired in front of* each route.
//
// Runs under @cloudflare/vitest-pool-workers because src/index.ts imports
// src/research/run.ts, which imports `cloudflare:workers`.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const TOKEN = "test-admin-token";

/** Env with a known ADMIN_TOKEN and rate limiting disabled unless asked for. */
function testEnv(overrides: Record<string, unknown> = {}) {
  return { ...env, ADMIN_TOKEN: TOKEN, PER_BEARER_RPM: "0", ...overrides } as typeof env;
}

async function call(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("public routes", () => {
  it("GET / serves the landing page without a bearer", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
  });

  it("GET /health responds without a bearer", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
  });
});

// /health is reachable by anyone on the internet, so its unauthenticated body
// must be a liveness signal and nothing more. Token presence, staleness, the
// last-refresh timestamp, and which mechanism produced the token all describe
// the operator's credential state and belong behind the bearer.
describe("GET /health withholds token state from unauthenticated callers", () => {
  const DETAIL_KEYS = ["token", "updatedAt", "source", "autoRefresh"] as const;

  it("returns only a liveness flag with no bearer", async () => {
    const res = await call("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("returns only a liveness flag when the bearer is wrong", async () => {
    const res = await call("/health", { headers: { Authorization: "Bearer not-the-token" } });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    for (const key of DETAIL_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("returns full token status to an authenticated caller", async () => {
    const res = await call("/health", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    for (const key of DETAIL_KEYS) {
      expect(body).toHaveProperty(key);
    }
    expect(["ok", "stale", "missing"]).toContain(body.token);
  });
});

describe("the bearer gate is wired in front of every other route", () => {
  const gated: ReadonlyArray<[string, string]> = [
    ["POST", "/search"],
    ["POST", "/summarize"],
    ["POST", "/admin/token"],
    ["POST", "/admin/refresh"],
    ["GET", "/definitely-not-a-route"],
  ];

  it.each(gated)("%s %s is 401 without a bearer", async (method, path) => {
    const res = await call(path, { method });
    expect(res.status).toBe(401);
  });

  it.each(gated)("%s %s is 401 with a wrong bearer", async (method, path) => {
    const res = await call(path, { method, headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("an unmatched path returns 404 once authenticated, not 401", async () => {
    // Proves the 401s above come from the gate rather than from the route
    // table simply not matching.
    const res = await call("/definitely-not-a-route", { method: "GET", headers: auth });
    expect(res.status).toBe(404);
  });

  it("the 404 body carries the stable not-found code", async () => {
    const res = await call("/nope", { method: "GET", headers: auth });
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-found");
  });
});

describe("method routing", () => {
  it("GET /search is 404 — the route is POST-only", async () => {
    const res = await call("/search", { method: "GET", headers: auth });
    expect(res.status).toBe(404);
  });

  it("POST / is 404 — the landing page is GET-only", async () => {
    const res = await call("/", { method: "POST", headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  // Counters live in KV keyed by sha256(bearer):epoch-minute and outlive an
  // individual test, so each case below uses its own bearer. Sharing one
  // would make these tests order-dependent.
  async function callAs(
    token: string,
    path: string,
    overrides: Record<string, unknown>,
  ): Promise<Response> {
    const request = new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, testEnv({ ADMIN_TOKEN: token, ...overrides }), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("returns 429 with Retry-After once the per-bearer limit is crossed", async () => {
    const t = "rl-crossed-token";
    await callAs(t, "/search", { PER_BEARER_RPM: "2" });
    await callAs(t, "/search", { PER_BEARER_RPM: "2" });
    const res = await callAs(t, "/search", { PER_BEARER_RPM: "2" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("allows traffic up to the limit before rejecting", async () => {
    const t = "rl-under-limit-token";
    const first = await callAs(t, "/search", { PER_BEARER_RPM: "3" });
    const second = await callAs(t, "/search", { PER_BEARER_RPM: "3" });

    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
  });

  it("PER_BEARER_RPM=0 disables the limit entirely", async () => {
    const t = "rl-disabled-token";
    for (let i = 0; i < 5; i++) {
      const res = await callAs(t, "/search", { PER_BEARER_RPM: "0" });
      expect(res.status).not.toBe(429);
    }
  });

  it("does not rate-limit /admin/* so an operator can always recover", async () => {
    const t = "rl-admin-token";
    await callAs(t, "/admin/token", { PER_BEARER_RPM: "1" });
    const res = await callAs(t, "/admin/token", { PER_BEARER_RPM: "1" });

    expect(res.status).not.toBe(429);
  });

  it("counts per bearer, not globally", async () => {
    // Two distinct bearers must not share a bucket.
    await callAs("rl-tenant-a", "/search", { PER_BEARER_RPM: "1" });
    await callAs("rl-tenant-a", "/search", { PER_BEARER_RPM: "1" });
    const other = await callAs("rl-tenant-b", "/search", { PER_BEARER_RPM: "1" });

    expect(other.status).not.toBe(429);
  });
});

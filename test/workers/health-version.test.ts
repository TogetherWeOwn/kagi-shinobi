// Release identity is admin-only; exercise the real route, not a mocked handler.
// Import package metadata so the next generated version PR changes the expected
// version too. No copied version literal or new public version endpoint.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { clearMemoryCache, saveToken } from "../../src/token/store";

const ADMIN = "health-admin-fixture";
const CLIENT = "health-scoped-fixture";
const BUILD_SHA = "a".repeat(40);
const UPDATED_AT = 1_793_340_000_000;

function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env, ADMIN_TOKEN: ADMIN, KAGI_SESSION_TOKEN: undefined, CLIENT_KEYS: undefined,
    AUTO_REFRESH_ENABLED: "false", BUILD_SHA, PER_BEARER_RPM: "0", ...overrides,
  } as Env;
}

async function health(bearer?: string, overrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const request = new Request("https://worker.test/health", {
    headers: bearer === undefined ? {} : { Authorization: bearer },
  });
  const response = await worker.fetch(request, testEnv(overrides), ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

beforeEach(async () => {
  clearMemoryCache();
  await env.TOKEN_KV.delete(env.TOKEN_KV_KEY);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("health must not use the network"); }));
});
afterEach(async () => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    clearMemoryCache();
    await env.TOKEN_KV.delete(env.TOKEN_KV_KEY);
  }
});

describe("health release-identity disclosure", () => {
  it.each([undefined, "Bearer wrong-token", "Basic health-admin-fixture", "Bearer "])(
    "returns exactly public liveness for %j, even with stored token details",
    async (bearer) => {
      await saveToken(testEnv(), { token: "session-fixture-never-disclose", updatedAt: UPDATED_AT, source: "admin", stale: true });
      expect(await health(bearer)).toEqual({ ok: true });
    },
  );

  it("keeps a real valid scoped-client key at exactly public liveness", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLIENT));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await health(`Bearer ${CLIENT}`, { CLIENT_KEYS: JSON.stringify({ fixture: hash }) })).toEqual({ ok: true });
  });

  it("does not disclose release metadata when no admin token is configured", async () => {
    expect(await health(`Bearer ${ADMIN}`, { ADMIN_TOKEN: undefined })).toEqual({ ok: true });
  });

  it("adds actual package version beside the deployed SHA without changing missing-token details", async () => {
    expect(await health(`Bearer ${ADMIN}`)).toEqual({
      ok: true, version: pkg.version, buildSha: BUILD_SHA,
      token: "missing", updatedAt: null, source: null, autoRefresh: false,
    });
  });

  it.each([false, true])("preserves token details and privacy for an admin with stale=%j", async (stale) => {
    await saveToken(testEnv(), { token: "session-fixture-never-disclose", updatedAt: UPDATED_AT, source: "admin", stale });
    expect(await health(`Bearer ${ADMIN}`, { AUTO_REFRESH_ENABLED: "true" })).toEqual({
      ok: true, version: pkg.version, buildSha: BUILD_SHA,
      token: stale ? "stale" : "ok", updatedAt: UPDATED_AT, source: "admin", autoRefresh: true,
    });
  });

  it("keeps package identity when BUILD_SHA is truly absent, not merely Wrangler's dev default", async () => {
    const body = await health(`Bearer ${ADMIN}`, { BUILD_SHA: undefined });
    expect(body.version).toBe(pkg.version);
    expect(body.buildSha).toBe("dev");
  });
});

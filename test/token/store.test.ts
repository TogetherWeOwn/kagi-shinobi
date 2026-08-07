// Coverage for the KV-backed session token store.
//
// The module keeps a process-global `memoryCache`, so every test clears it
// first — otherwise state leaks between cases and the suite passes for the
// wrong reason. That same global is a production hazard (each isolate holds
// its own copy for up to 5 minutes); the last describe block pins the
// behavior so a future change to the TTL is a deliberate, visible one.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMemoryCache,
  loadToken,
  markStale,
  saveToken,
  type TokenEnvelope,
} from "../../src/token/store";
import { makeEnv } from "../_helpers";

beforeEach(() => {
  clearMemoryCache();
});

describe("loadToken", () => {
  it("returns null when KV is empty and no seed secret is set", async () => {
    const env = makeEnv({ KAGI_SESSION_TOKEN: undefined });
    expect(await loadToken(env)).toBeNull();
  });

  it("reads and parses an existing envelope from KV", async () => {
    const env = makeEnv();
    const stored: TokenEnvelope = { token: "tok-abc", updatedAt: 123, source: "admin" };
    await env.TOKEN_KV.put(env.TOKEN_KV_KEY, JSON.stringify(stored));

    expect(await loadToken(env)).toEqual(stored);
  });

  it("seeds from KAGI_SESSION_TOKEN on first boot and persists it", async () => {
    const env = makeEnv({ KAGI_SESSION_TOKEN: "seeded-from-secret" });

    const loaded = await loadToken(env);
    expect(loaded?.token).toBe("seeded-from-secret");
    expect(loaded?.source).toBe("secret");

    // The seed must be written back, not just returned.
    const raw = await env.TOKEN_KV.get(env.TOKEN_KV_KEY);
    expect(JSON.parse(raw!).token).toBe("seeded-from-secret");
  });

  it("falls back to the seed secret when the stored envelope is corrupt", async () => {
    const env = makeEnv({ KAGI_SESSION_TOKEN: "seeded-from-secret" });
    await env.TOKEN_KV.put(env.TOKEN_KV_KEY, "{not json");

    const loaded = await loadToken(env);
    expect(loaded?.token).toBe("seeded-from-secret");
    expect(loaded?.source).toBe("secret");
  });

  it("returns null when the stored envelope is corrupt and no seed exists", async () => {
    const env = makeEnv({ KAGI_SESSION_TOKEN: undefined });
    await env.TOKEN_KV.put(env.TOKEN_KV_KEY, "{not json");

    expect(await loadToken(env)).toBeNull();
  });
});

describe("saveToken", () => {
  it("writes the envelope to KV as JSON", async () => {
    const env = makeEnv();
    const envelope: TokenEnvelope = { token: "tok-abc", updatedAt: 999, source: "browser-refresh" };

    await saveToken(env, envelope);

    expect(JSON.parse((await env.TOKEN_KV.get(env.TOKEN_KV_KEY))!)).toEqual(envelope);
  });

  it("makes the new value visible to the next loadToken", async () => {
    const env = makeEnv();
    await saveToken(env, { token: "first", updatedAt: 1, source: "admin" });
    await saveToken(env, { token: "second", updatedAt: 2, source: "admin" });

    expect((await loadToken(env))?.token).toBe("second");
  });
});

describe("markStale", () => {
  it("returns null when there is no token to mark", async () => {
    const env = makeEnv({ KAGI_SESSION_TOKEN: undefined });
    expect(await markStale(env, "401 from upstream")).toBeNull();
  });

  it("sets stale, staleAt, and staleReason while preserving the token", async () => {
    const env = makeEnv();
    await saveToken(env, { token: "tok-abc", updatedAt: 1, source: "admin" });

    const updated = await markStale(env, "401 from upstream");

    expect(updated?.token).toBe("tok-abc");
    expect(updated?.source).toBe("admin");
    expect(updated?.stale).toBe(true);
    expect(updated?.staleReason).toBe("401 from upstream");
    expect(typeof updated?.staleAt).toBe("number");
  });

  it("persists staleness to KV, not just to the returned value", async () => {
    const env = makeEnv();
    await saveToken(env, { token: "tok-abc", updatedAt: 1, source: "admin" });
    await markStale(env, "captcha");
    clearMemoryCache();

    expect((await loadToken(env))?.stale).toBe(true);
  });
});

describe("memoryCache", () => {
  it("serves a cached envelope without re-reading KV", async () => {
    const env = makeEnv();
    await saveToken(env, { token: "cached", updatedAt: 1, source: "admin" });

    // Mutate KV behind the cache's back — a warm cache must not notice.
    await env.TOKEN_KV.put(
      env.TOKEN_KV_KEY,
      JSON.stringify({ token: "changed-elsewhere", updatedAt: 2, source: "admin" }),
    );

    expect((await loadToken(env))?.token).toBe("cached");
  });

  it("picks up the external change once the cache is cleared", async () => {
    const env = makeEnv();
    await saveToken(env, { token: "cached", updatedAt: 1, source: "admin" });
    await env.TOKEN_KV.put(
      env.TOKEN_KV_KEY,
      JSON.stringify({ token: "changed-elsewhere", updatedAt: 2, source: "admin" }),
    );

    clearMemoryCache();

    expect((await loadToken(env))?.token).toBe("changed-elsewhere");
  });
});

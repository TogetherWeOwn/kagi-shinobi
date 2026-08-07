// Shared test helpers — in-memory KV, env factory, fetch mock builder.

import { vi } from "vitest";
import type { Env } from "../src/env";

class MemKV {
  private store = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> {
    this.store.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

export interface TestEnv extends Env {
  TOKEN_KV: MemKV & KVNamespace;
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const kv = new MemKV();
  return {
    ADMIN_TOKEN: "test-admin",
    TOKEN_KV: kv as unknown as MemKV & KVNamespace,
    TOKEN_KV_KEY: "session_token",
    AUTO_REFRESH_ENABLED: "false",
    KAGI_MODE: "scrape",
    MAX_API_CENTS_PER_MONTH: "0",
    ...overrides,
  } as TestEnv;
}

/**
 * Build a fake fetch that returns a fixed JSON body wrapped in Kagi's envelope
 * `{meta, data}` shape and honors any headers you want to assert on.
 */
export function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
}

export function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi.stubGlobal("fetch", handler);
}

export function restoreFetch() {
  vi.unstubAllGlobals();
}

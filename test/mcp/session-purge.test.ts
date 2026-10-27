import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_TTL_MS,
  SESSION_PURGE_INTERVAL_S,
  shouldPurgeSession,
} from "../../src/mcp/session-purge";

const DAY_MS = 24 * 3600 * 1000;

describe("session purge policy", () => {
  it("keeps the 7-day operator policy in one place", () => {
    expect(SESSION_PURGE_INTERVAL_S).toBe(7 * 24 * 3600);
    expect(SESSION_IDLE_TTL_MS).toBe(SESSION_PURGE_INTERVAL_S * 1000);
  });
});

describe("shouldPurgeSession", () => {
  const now = 1_800_000_000_000;

  it("purges a session idle longer than 7 days", () => {
    expect(shouldPurgeSession(now - 8 * DAY_MS, now)).toBe(true);
  });

  it("keeps a session idle less than 7 days", () => {
    expect(shouldPurgeSession(now - 6 * DAY_MS, now)).toBe(false);
  });

  it("purges at exactly the 7-day boundary", () => {
    expect(shouldPurgeSession(now - 7 * DAY_MS, now)).toBe(true);
  });

  it("keeps a session whose last activity is in the future", () => {
    expect(shouldPurgeSession(now + 60_000, now)).toBe(false);
  });

  it("keeps a session with no recorded activity", () => {
    expect(shouldPurgeSession(undefined, now)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { checkAndIncrement, readLimit } from "../../src/util/ratelimit";
import { makeEnv } from "../_helpers";

describe("readLimit", () => {
  it("defaults to 60 when unset", () => {
    expect(readLimit(makeEnv({ PER_BEARER_RPM: undefined }))).toBe(60);
  });
  it("parses positive values", () => {
    expect(readLimit(makeEnv({ PER_BEARER_RPM: "5" }))).toBe(5);
  });
  it("clamps negatives to 0 (disabled)", () => {
    expect(readLimit(makeEnv({ PER_BEARER_RPM: "-1" }))).toBe(0);
  });
});

describe("checkAndIncrement", () => {
  it("PER_BEARER_RPM=0 disables enforcement", async () => {
    const env = makeEnv({ PER_BEARER_RPM: "0" });
    for (let i = 0; i < 200; i++) {
      const r = await checkAndIncrement(env, "b1");
      expect(r.allowed).toBe(true);
    }
  });

  it("allows up to the limit then blocks", async () => {
    const env = makeEnv({ PER_BEARER_RPM: "3" });
    const t = new Date(0);
    for (let i = 1; i <= 3; i++) {
      const r = await checkAndIncrement(env, "b1", t);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
    const blocked = await checkAndIncrement(env, "b1", t);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
  });

  it("keys separately per bearer", async () => {
    const env = makeEnv({ PER_BEARER_RPM: "1" });
    const t = new Date(0);
    const r1 = await checkAndIncrement(env, "alice", t);
    const r2 = await checkAndIncrement(env, "bob", t);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  it("resets across minute boundaries", async () => {
    const env = makeEnv({ PER_BEARER_RPM: "1" });
    const t1 = new Date(0);
    const t2 = new Date(65_000);
    await checkAndIncrement(env, "b1", t1);
    const blocked = await checkAndIncrement(env, "b1", t1);
    expect(blocked.allowed).toBe(false);
    const nextMin = await checkAndIncrement(env, "b1", t2);
    expect(nextMin.allowed).toBe(true);
  });
});

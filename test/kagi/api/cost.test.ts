import { afterEach, describe, expect, it } from "vitest";
import {
  budgetSnapshot,
  guardBillable,
  readCap,
  readSpend,
} from "../../../src/kagi/api/cost";
import { KagiBudgetExceededError } from "../../../src/kagi/errors";
import { makeEnv } from "../../_helpers";

afterEach(() => {});

describe("readCap", () => {
  it("defaults to 0 when unset", () => {
    expect(readCap(makeEnv({ MAX_API_CENTS_PER_MONTH: undefined }))).toBe(0);
  });
  it("parses positive integers", () => {
    expect(readCap(makeEnv({ MAX_API_CENTS_PER_MONTH: "500" }))).toBe(500);
  });
  it("clamps negative to 0", () => {
    expect(readCap(makeEnv({ MAX_API_CENTS_PER_MONTH: "-3" }))).toBe(0);
  });
  it("treats garbage as 0", () => {
    expect(readCap(makeEnv({ MAX_API_CENTS_PER_MONTH: "yolo" }))).toBe(0);
  });
});

describe("guardBillable", () => {
  it("cap=0 refuses everything", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "0" });
    await expect(guardBillable(env, 1)).rejects.toBeInstanceOf(KagiBudgetExceededError);
  });

  it("cap>0 allows calls under the cap", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "100" });
    const guard = await guardBillable(env, 5);
    await guard.settle(5);
    expect(await readSpend(env)).toBe(5);
  });

  it("blocks when spend + charge would exceed cap", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "10" });
    const g1 = await guardBillable(env, 6);
    await g1.settle(6);
    // Now 6 spent; another 5 would push to 11 > 10
    await expect(guardBillable(env, 5)).rejects.toBeInstanceOf(KagiBudgetExceededError);
    // But another 4 (exactly at cap) should still be OK
    const g2 = await guardBillable(env, 4);
    await g2.settle(4);
    expect(await readSpend(env)).toBe(10);
  });

  it("settle(0) does not debit — matches enrich's zero-result billing", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "50" });
    const guard = await guardBillable(env, 2);
    await guard.settle(0);
    expect(await readSpend(env)).toBe(0);
  });

  it("budgetSnapshot reports current state", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "100" });
    const g = await guardBillable(env, 30);
    await g.settle(30);
    const snap = await budgetSnapshot(env);
    expect(snap.cap_cents).toBe(100);
    expect(snap.spent_cents).toBe(30);
    expect(snap.remaining_cents).toBe(70);
    expect(snap.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("error carries spent + cap in detail", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "5" });
    try {
      await guardBillable(env, 10);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KagiBudgetExceededError);
      const be = err as KagiBudgetExceededError;
      expect(be.detail.cap_cents).toBe(5);
    }
  });
});

// Coverage for the bearer gate. This is the single control standing between
// the public internet and every billable/privileged route in src/index.ts,
// so the error *codes* are asserted too — callers key off them, and a silent
// code change is a contract break.

import { describe, expect, it } from "vitest";
import { requireBearer } from "../../src/util/auth";
import { makeEnv } from "../_helpers";

/** Build a Request carrying an arbitrary Authorization header. */
function req(authorization?: string): Request {
  return new Request("https://example.com/search", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function bodyOf(res: Response): Promise<{ error: { code: string; message: string } }> {
  return (await res.json()) as { error: { code: string; message: string } };
}

describe("requireBearer — accepts", () => {
  it("returns null (pass) when the token matches exactly", () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    expect(requireBearer(req("Bearer s3cret"), env)).toBeNull();
  });

  it("tolerates surrounding whitespace on the token", () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    expect(requireBearer(req("Bearer   s3cret  "), env)).toBeNull();
  });
});

describe("requireBearer — rejects", () => {
  it("401 missing-bearer when the Authorization header is absent", async () => {
    const res = requireBearer(req(), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 missing-bearer for a non-Bearer scheme", async () => {
    const res = requireBearer(req("Basic czNjcmV0"), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 missing-bearer when the scheme case does not match", async () => {
    // The check is `startsWith("Bearer ")` — deliberately case-sensitive.
    const res = requireBearer(req("bearer test-admin"), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 invalid-bearer on a wrong token of equal length", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "aaaaaa" });
    const res = requireBearer(req("Bearer bbbbbb"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 invalid-bearer on a wrong token of different length", async () => {
    // Exercises the length-mismatch short-circuit in timingSafeEqual.
    const env = makeEnv({ ADMIN_TOKEN: "aaaaaa" });
    const res = requireBearer(req("Bearer a"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 invalid-bearer when the token is a prefix of the real one", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret-long" });
    const res = requireBearer(req("Bearer s3cret"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 missing-bearer when the scheme is followed only by whitespace", async () => {
    // Header values are whitespace-normalized on the way in, so "Bearer   "
    // reaches the handler as "Bearer" and fails startsWith("Bearer ") before
    // any token comparison. An empty `provided` is therefore unreachable over
    // HTTP — the trim() in requireBearer only ever strips *interior* padding.
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    const res = requireBearer(req("Bearer    "), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });
});

describe("requireBearer — misconfiguration", () => {
  it("500 server-misconfigured when ADMIN_TOKEN is unset", async () => {
    const env = makeEnv({ ADMIN_TOKEN: undefined });
    const res = requireBearer(req("Bearer anything"), env)!;
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).error.code).toBe("server-misconfigured");
  });

  it("500 server-misconfigured when ADMIN_TOKEN is empty", async () => {
    // An empty secret must never become an open door: without this branch an
    // empty ADMIN_TOKEN and an empty bearer would compare equal.
    const env = makeEnv({ ADMIN_TOKEN: "" });
    const res = requireBearer(req("Bearer anything"), env)!;
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).error.code).toBe("server-misconfigured");
  });

  it("never echoes the configured token back in the error body", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "super-secret-value" });
    const res = requireBearer(req("Bearer wrong"), env)!;
    expect(await res.text()).not.toContain("super-secret-value");
  });
});

// Coverage for the JSON response helpers. Distinct from test/kagi/errors.ts,
// which covers the KagiError taxonomy — this file covers the wire shape every
// handler in src/rest.ts and src/index.ts returns.

import { describe, expect, it } from "vitest";
import { jsonError, jsonOk, type ErrorBody } from "../../src/util/errors";

describe("jsonOk", () => {
  it("defaults to 200 with a JSON content type", async () => {
    const res = jsonOk({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("honors an explicit status override", () => {
    expect(jsonOk({ ok: true }, { status: 201 }).status).toBe(201);
  });

  it("merges extra headers without dropping the content type", () => {
    const res = jsonOk({ ok: true }, { headers: { "X-Trace": "abc" } });
    expect(res.headers.get("X-Trace")).toBe("abc");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("lets a caller override the content type deliberately", () => {
    const res = jsonOk("text", { headers: { "Content-Type": "text/plain" } });
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("serializes null without throwing", async () => {
    expect(await jsonOk(null).json()).toBeNull();
  });
});

describe("jsonError", () => {
  it("wraps code and message in the stable { error } envelope", async () => {
    const res = jsonError(404, "not-found", "POST /nope not routed");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect((await res.json()) as ErrorBody).toEqual({
      error: { code: "not-found", message: "POST /nope not routed" },
    });
  });

  it("preserves the status it is given", () => {
    expect(jsonError(429, "rate-limited", "slow down").status).toBe(429);
    expect(jsonError(503, "refresh-failed", "browser down").status).toBe(503);
  });

  it("keeps code machine-readable even when the message is empty", async () => {
    const body = (await jsonError(400, "invalid-json", "").json()) as ErrorBody;
    expect(body.error.code).toBe("invalid-json");
    expect(body.error.message).toBe("");
  });
});

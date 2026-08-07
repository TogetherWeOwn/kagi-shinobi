// Endpoint-level integration tests with a stubbed fetch. Each test asserts
// (a) the request the wrapper sent (URL/method/auth), (b) the canonical
// response shape, and (c) the cost cap debit.

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiSearch } from "../../../src/kagi/api/search";
import { apiExtract } from "../../../src/kagi/api/extract";
import { apiFastGPT } from "../../../src/kagi/api/fastgpt";
import { apiSummarize } from "../../../src/kagi/api/summarize";
import { apiEnrichNews, apiEnrichWeb } from "../../../src/kagi/api/enrich";
import { readSpend } from "../../../src/kagi/api/cost";
import {
  KagiConfirmRequiredError,
  KagiError,
  KagiNotConfiguredError,
  KagiUpstreamError,
} from "../../../src/kagi/errors";
import { fakeFetch, makeEnv, restoreFetch, stubFetch } from "../../_helpers";

afterEach(() => {
  restoreFetch();
});

const CAPACIOUS = { MAX_API_CENTS_PER_MONTH: "10000", KAGI_API_KEY: "k" };

describe("apiSearch", () => {
  it("posts to /v1/search with Bot auth and returns canonical SearchResponse", async () => {
    const seen: { url?: string; method?: string; auth?: string; body?: string } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.auth = (init?.headers as Record<string, string> | undefined)?.[
        "Authorization"
      ];
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch({
        meta: { trace: "TR-123", ms: 42 },
        data: {
          search: [
            { url: "https://a.example/x", title: "A", snippet: "s1", time: "2026-06-01" },
            { url: "https://b.example/y", title: "B", snippet: "s2" },
          ],
          interesting_finds: [
            { url: "https://sw.example/z", title: "SW", snippet: "small web" },
          ],
          related_search: ["r1", "r2"],
        },
      })(input, init);
    });
    const env = makeEnv(CAPACIOUS);
    const resp = await apiSearch(env, { query: "hi" });
    expect(seen.url).toBe("https://kagi.com/api/v1/search");
    expect(seen.method).toBe("POST");
    expect(seen.auth).toBe("Bot k");
    expect(seen.body && JSON.parse(seen.body).query).toBe("hi");
    expect(resp.query).toBe("hi");
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      rank: 1,
      url: "https://a.example/x",
      source_impl: "api",
      source_domain: "a.example",
      published_at: "2026-06-01",
    });
    expect(resp.buckets?.small_web).toHaveLength(1);
    expect(resp.buckets?.related_search).toEqual(["r1", "r2"]);
    expect(resp.meta.impl).toBe("api");
    expect(resp.meta.trace_id).toBe("TR-123");
    expect(resp.meta.cost_cents).toBeCloseTo(1.2);
    expect(await readSpend(env)).toBeCloseTo(1.2);
  });

  it("refuses when KAGI_API_KEY is unset", async () => {
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "1000" });
    await expect(apiSearch(env, { query: "x" })).rejects.toBeInstanceOf(
      KagiNotConfiguredError,
    );
  });

  it("surfaces 5xx as KagiUpstreamError", async () => {
    stubFetch(fakeFetch({ error: "oops" }, { status: 502 }));
    const env = makeEnv(CAPACIOUS);
    await expect(apiSearch(env, { query: "x" })).rejects.toBeInstanceOf(
      KagiUpstreamError,
    );
  });
});

describe("apiExtract", () => {
  it("posts urls[] to /v1/extract and bills per URL", async () => {
    stubFetch(
      fakeFetch({
        meta: {},
        data: {
          pages: [
            { url: "https://a", title: "A", content: "# hi" },
            { url: "https://b", content: "**yo**" },
          ],
        },
      }),
    );
    const env = makeEnv(CAPACIOUS);
    const resp = await apiExtract(env, { urls: ["https://a", "https://b"] });
    expect(resp.pages).toHaveLength(2);
    expect(resp.pages[0].markdown).toBe("# hi");
    expect(resp.meta.cost_cents).toBeCloseTo(0.8); // 2 * 0.4
  });

  it("rejects more than 10 urls", async () => {
    const env = makeEnv(CAPACIOUS);
    const urls = Array.from({ length: 11 }, (_, i) => `https://x/${i}`);
    await expect(apiExtract(env, { urls })).rejects.toBeInstanceOf(KagiError);
  });

  it("rejects empty urls[]", async () => {
    const env = makeEnv(CAPACIOUS);
    await expect(apiExtract(env, { urls: [] })).rejects.toBeInstanceOf(KagiError);
  });
});

describe("apiFastGPT", () => {
  it("posts to /v0/fastgpt and returns canonical FastGPTResponse", async () => {
    stubFetch(
      fakeFetch({
        meta: { trace: "T" },
        data: {
          output: "Because gravity.",
          tokens: 40,
          references: [{ title: "Ref1", url: "https://r/1", snippet: "s" }],
        },
      }),
    );
    const env = makeEnv(CAPACIOUS);
    const resp = await apiFastGPT(env, { query: "why is the sky blue" });
    expect(resp.answer).toContain("gravity");
    expect(resp.references).toHaveLength(1);
    expect(resp.tokens).toBe(40);
    expect(resp.meta.cost_cents).toBeCloseTo(1.5);
    expect(resp.meta.trace_id).toBe("T");
  });
});

describe("apiSummarize", () => {
  it("defaults to cecil engine and posts to /v0/summarize", async () => {
    const captured: { body?: unknown } = {};
    stubFetch(async (input, init) => {
      captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return fakeFetch({ meta: {}, data: { output: "OK", tokens: 12 } })(input, init);
    });
    const env = makeEnv(CAPACIOUS);
    const resp = await apiSummarize(env, {
      kind: "url",
      ref: "https://x.example",
      language: "EN",
      style: "summary",
    });
    expect(resp.engine_used).toBe("cecil");
    expect((captured.body as { engine?: string }).engine).toBe("cecil");
    expect(resp.meta.cost_cents).toBe(30);
  });

  it("Muriel requires confirm_muriel=true when SUMMARIZER_MURIEL_REQUIRES_CONFIRM is default", async () => {
    stubFetch(fakeFetch({ meta: {}, data: { output: "" } }));
    const env = makeEnv({ ...CAPACIOUS, SUMMARIZER_MURIEL_REQUIRES_CONFIRM: "true" });
    await expect(
      apiSummarize(env, {
        kind: "url",
        ref: "https://x",
        language: "EN",
        style: "summary",
        engine: "muriel",
      }),
    ).rejects.toBeInstanceOf(KagiConfirmRequiredError);
  });

  it("Muriel allowed when confirm_muriel=true", async () => {
    stubFetch(fakeFetch({ meta: {}, data: { output: "OK" } }));
    const env = makeEnv({ ...CAPACIOUS, MAX_API_CENTS_PER_MONTH: "10000" });
    const resp = await apiSummarize(env, {
      kind: "url",
      ref: "https://x",
      language: "EN",
      style: "summary",
      engine: "muriel",
      confirm_muriel: true,
    });
    expect(resp.engine_used).toBe("muriel");
    expect(resp.meta.cost_cents).toBe(100);
  });

  it("Muriel allowed without confirm when SUMMARIZER_MURIEL_REQUIRES_CONFIRM=false", async () => {
    stubFetch(fakeFetch({ meta: {}, data: { output: "OK" } }));
    const env = makeEnv({
      ...CAPACIOUS,
      SUMMARIZER_MURIEL_REQUIRES_CONFIRM: "false",
      MAX_API_CENTS_PER_MONTH: "10000",
    });
    const resp = await apiSummarize(env, {
      kind: "url",
      ref: "https://x",
      language: "EN",
      style: "summary",
      engine: "muriel",
    });
    expect(resp.engine_used).toBe("muriel");
  });

  it("rejects 1MB+ text bodies before hitting the network", async () => {
    const fetchSpy = vi.fn(fakeFetch({ meta: {}, data: { output: "" } }));
    stubFetch(fetchSpy);
    const env = makeEnv(CAPACIOUS);
    await expect(
      apiSummarize(env, {
        kind: "text",
        ref: "x".repeat(1_000_001),
        language: "EN",
        style: "summary",
      }),
    ).rejects.toBeInstanceOf(KagiError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("apiEnrich", () => {
  it("returns index=teclis for web and bills on non-zero results", async () => {
    stubFetch(
      fakeFetch({
        meta: {},
        data: [{ rank: 1, url: "https://x", title: "T", snippet: "s" }],
      }),
    );
    const env = makeEnv(CAPACIOUS);
    const resp = await apiEnrichWeb(env, { q: "hi" });
    expect(resp.index).toBe("teclis");
    expect(resp.results).toHaveLength(1);
    expect(resp.meta.cost_cents).toBeCloseTo(0.2);
    expect(await readSpend(env)).toBeCloseTo(0.2);
  });

  it("returns index=tinygem for news", async () => {
    stubFetch(fakeFetch({ meta: {}, data: [] }));
    const env = makeEnv(CAPACIOUS);
    const resp = await apiEnrichNews(env, { q: "hi" });
    expect(resp.index).toBe("tinygem");
  });

  it("does NOT debit when zero results (Kagi bills only on non-zero)", async () => {
    stubFetch(fakeFetch({ meta: {}, data: [] }));
    const env = makeEnv(CAPACIOUS);
    const resp = await apiEnrichWeb(env, { q: "x" });
    expect(resp.results).toHaveLength(0);
    expect(resp.meta.cost_cents).toBe(0);
    expect(await readSpend(env)).toBe(0);
  });
});

describe("cost-cap enforcement across endpoints", () => {
  it("cap=0 blocks apiSearch before the fetch", async () => {
    const fetchSpy = vi.fn(fakeFetch({ meta: {}, data: {} }));
    stubFetch(fetchSpy);
    const env = makeEnv({ MAX_API_CENTS_PER_MONTH: "0", KAGI_API_KEY: "k" });
    await expect(apiSearch(env, { query: "x" })).rejects.toThrow(/cost cap/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

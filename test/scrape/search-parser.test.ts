// Parser correctness against a recorded fixture. Runs hermetic — no network.
import { describe, expect, it } from "vitest";
import { parseSearchResults } from "../../src/kagi/search";
import { scrapeSearchToCanonical } from "../../src/kagi/normalize";

const FIXTURE = `<!doctype html>
<html>
<body>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://example.com/one">First Result Title</a>
    </div>
    <div class="__sri-desc">This is the snippet for the first result. It describes what you'd find.</div>
  </div>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://another.example.org/page">Second Result Title</a>
    </div>
    <div class="__sri-desc">A second snippet from a second domain.</div>
  </div>
  <div class="sr-group">
    <div class="__srgi">
      <div class="__srgi-title">
        <a href="https://grouped.example.net/x">Grouped Result</a>
      </div>
      <div class="__sri-desc">Snippet under a grouped result.</div>
    </div>
  </div>
  <div class="related-searches">
    <a><span>related term one</span></a>
    <a><span>related term two</span></a>
  </div>
</body>
</html>`;

describe("parseSearchResults", () => {
  it("extracts top-level search results in order", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({
      t: 0,
      title: "First Result Title",
      url: "https://example.com/one",
    });
    expect(results[1].url).toBe("https://another.example.org/page");
    expect(results[2].url).toBe("https://grouped.example.net/x");
  });

  it("respects the limit param", () => {
    const items = parseSearchResults(FIXTURE, 2);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(2);
  });

  it("emits related searches when present", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const related = items.find((i) => i.t === 1);
    expect(related).toBeDefined();
    if (related && related.t === 1) {
      expect(related.list).toEqual(["related term one", "related term two"]);
    }
  });

  it("returns empty results on markup with no matches", () => {
    const items = parseSearchResults(`<html><body>nothing</body></html>`, 10);
    expect(items.length).toBe(0);
  });
});

describe("scrapeSearchToCanonical", () => {
  it("normalizes into the canonical SearchResponse shape", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const canonical = scrapeSearchToCanonical("hello world", items, {
      impl: "scrape",
      start_ms: Date.now() - 42,
    });
    expect(canonical.query).toBe("hello world");
    expect(canonical.results.length).toBe(3);
    expect(canonical.results[0]).toMatchObject({
      rank: 1,
      source_impl: "scrape",
      source_domain: "example.com",
    });
    expect(canonical.results[1].source_domain).toBe("another.example.org");
    expect(canonical.meta.impl).toBe("scrape");
    expect(canonical.meta.cache_hit).toBe(false);
    expect(canonical.meta.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(canonical.buckets?.related_search).toEqual([
      "related term one",
      "related term two",
    ]);
  });

  it("assigns increasing rank numbers", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const canonical = scrapeSearchToCanonical("q", items, {
      impl: "scrape",
      start_ms: Date.now(),
    });
    for (let i = 0; i < canonical.results.length; i++) {
      expect(canonical.results[i].rank).toBe(i + 1);
    }
  });
});

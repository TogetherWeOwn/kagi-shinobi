import { afterEach, describe, expect, it } from "vitest";
import { fetchSmallWebRss, scrapeSmallWeb } from "../../src/kagi/scrape/smallweb";
import { KagiAuthError, KagiParseError } from "../../src/kagi/errors";
import { restoreFetch, stubFetch } from "../_helpers";

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Kagi Small Web</title>
  <item>
    <title>How I stopped worrying &amp; started blogging</title>
    <link>https://alice.example/post/1</link>
    <pubDate>Fri, 20 Jun 2026 12:00:00 GMT</pubDate>
    <description>A story about writing on the small web.</description>
  </item>
  <item>
    <title><![CDATA[Something with <em>markup</em>]]></title>
    <link>https://bob.example/blog/2</link>
    <pubDate>Thu, 19 Jun 2026 08:00:00 GMT</pubDate>
    <description>Another entry.</description>
  </item>
</channel>
</rss>`;

afterEach(() => restoreFetch());

describe("fetchSmallWebRss", () => {
  it("parses RSS items with title/link/pubDate/description", async () => {
    stubFetch(
      async () =>
        new Response(RSS_FIXTURE, { status: 200, headers: { "Content-Type": "application/xml" } }),
    );
    const feed = await fetchSmallWebRss();
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].title).toBe("How I stopped worrying & started blogging");
    expect(feed.items[0].link).toBe("https://alice.example/post/1");
    expect(feed.items[0].pub_date).toContain("2026");
    expect(feed.items[1].link).toBe("https://bob.example/blog/2");
  });

  it("respects the limit", async () => {
    stubFetch(
      async () =>
        new Response(RSS_FIXTURE, { status: 200, headers: { "Content-Type": "application/xml" } }),
    );
    const feed = await fetchSmallWebRss(1);
    expect(feed.items).toHaveLength(1);
  });

  it("throws KagiParseError on non-RSS response", async () => {
    stubFetch(async () => new Response("<html>not a feed</html>", { status: 200 }));
    await expect(fetchSmallWebRss()).rejects.toBeInstanceOf(KagiParseError);
  });
});

describe("scrapeSmallWeb (no q → RSS)", () => {
  it("returns SearchResponse with source_impl=scrape", async () => {
    stubFetch(async () => new Response(RSS_FIXTURE, { status: 200 }));
    const resp = await scrapeSmallWeb({}, undefined);
    expect(resp.query).toBe("");
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0].source_impl).toBe("scrape");
    expect(resp.results[0].props?.source).toBe("smallweb_rss");
    expect(resp.meta.impl).toBe("scrape");
  });
});

describe("scrapeSmallWeb (q → search)", () => {
  it("requires a session token when q is set", async () => {
    stubFetch(async () => new Response("", { status: 200 }));
    await expect(scrapeSmallWeb({ q: "linux" }, undefined)).rejects.toBeInstanceOf(
      KagiAuthError,
    );
  });
});

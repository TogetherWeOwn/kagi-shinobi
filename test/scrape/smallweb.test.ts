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

// The live feed at https://kagi.com/api/v1/smallweb/feed/ is ATOM, not RSS.
// Shape mirrored from a real response: <entry> children, the URL in a
// self-closing <link href="">, <published>/<updated> instead of <pubDate>,
// and <summary type="html"> carrying escaped markup. The original parser only
// matched <item> and was tested only against a hand-written RSS fixture, so it
// returned zero results against production while the suite stayed green.
const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Kagi Small Web</title>
  <id>https://kagi.com/api/v1/smallweb/feed</id>
  <updated>2026-08-08T03:00:00+00:00</updated>
  <entry xml:base="https://kagi.com/api/v1/smallweb/feed">
    <title type="text">How I stopped worrying &amp; started blogging</title>
    <id>https://alice.example/post/1</id>
    <updated>2026-08-08T03:00:00+00:00</updated>
    <published>2026-08-08T03:00:00+00:00</published>
    <link rel="self" href="https://kagi.com/feed-self" />
    <link href="https://alice.example/post/1" />
    <summary type="html">A story about &lt;em&gt;writing&lt;/em&gt; on the small web.</summary>
  </entry>
  <entry>
    <title type="text">Another entry</title>
    <published>2026-08-07T00:00:00+00:00</published>
    <link rel="alternate" href="https://bob.example/blog/2?a=1&amp;b=2" />
  </entry>
</feed>`;

afterEach(() => restoreFetch());

describe("fetchSmallWebRss (Atom — the live feed dialect)", () => {
  it("parses Atom entries with title/href link/published/summary", async () => {
    stubFetch(
      async () =>
        new Response(ATOM_FIXTURE, {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        }),
    );
    const feed = await fetchSmallWebRss();
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].title).toBe("How I stopped worrying & started blogging");
    expect(feed.items[0].pub_date).toBe("2026-08-08T03:00:00+00:00");
    // <summary type="html"> is escaped markup; snippets must come out as text.
    expect(feed.items[0].description).toBe("A story about writing on the small web.");
  });

  it("takes the href attribute, skipping rel=self", async () => {
    stubFetch(async () => new Response(ATOM_FIXTURE, { status: 200 }));
    const feed = await fetchSmallWebRss();
    expect(feed.items[0].link).toBe("https://alice.example/post/1");
    expect(feed.items[1].link).toBe("https://bob.example/blog/2?a=1&b=2");
  });

  it("throws rather than returning an empty list when a valid feed parses to nothing", async () => {
    // The regression that hid the original bug: a well-formed feed whose entry
    // markup the parser cannot read must fail loudly, not report success.
    stubFetch(
      async () =>
        new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`, {
          status: 200,
        }),
    );
    await expect(fetchSmallWebRss()).rejects.toBeInstanceOf(KagiParseError);
  });
});

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

// Small Web: the differentiating corpus. Two scrape paths:
//   - The public RSS feed (https://kagi.com/api/v0/smallweb/feed) — free, no
//     auth. Great for `q=undefined` "recent" browsing.
//   - Search with `?l=smallweb` on kagi.com/html/search — session-authed.
//
// The v1 Search API surfaces the same corpus as `interesting_finds`; the
// api-side impl uses that path.

import { chromeHeaders } from "../headers.js";
import { KagiAuthError, KagiParseError, KagiUpstreamError } from "../errors.js";
import type { SearchResponse, SearchResult } from "../types.js";
import { buildMeta } from "../../mcp/meta.js";
import { domainFromUrl } from "../../util/url.js";

const RSS_URL = "https://kagi.com/api/v0/smallweb/feed";

export interface SmallWebRssResult {
  items: Array<{
    title: string;
    link: string;
    pub_date?: string;
    description?: string;
  }>;
}

export async function fetchSmallWebRss(limit = 25): Promise<SmallWebRssResult> {
  const res = await fetch(RSS_URL, {
    headers: chromeHeaders({
      kind: "xhr",
      accept: "application/rss+xml, application/xml, text/xml",
    }),
  });
  if (!res.ok) {
    throw new KagiUpstreamError(res.status, res.statusText);
  }
  const xml = await res.text();
  return { items: parseRss(xml, limit) };
}

function parseRss(xml: string, limit: number): SmallWebRssResult["items"] {
  // RSS feeds are simple enough that a regex-based extraction is stable
  // across whitespace variations without dragging in a full XML parser.
  const items: SmallWebRssResult["items"] = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) ?? [];
  for (const raw of matches.slice(0, limit)) {
    const title = extractTag(raw, "title") ?? "";
    const link = extractTag(raw, "link") ?? "";
    if (!link) continue;
    items.push({
      title: unescapeXml(title),
      link,
      pub_date: extractTag(raw, "pubDate") ?? undefined,
      description: extractTag(raw, "description") ?? undefined,
    });
  }
  if (matches.length === 0 && !/<rss\b|<feed\b/i.test(xml)) {
    // The response wasn't a feed at all — bad markup or an auth wall.
    throw new KagiParseError("Small Web feed did not return RSS/Atom");
  }
  return items;
}

function extractTag(raw: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = raw.match(re);
  if (!m) return null;
  const stripped = m[1]
    .replace(/^<!\[CDATA\[/i, "")
    .replace(/\]\]>$/i, "")
    .trim();
  return stripped;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ScrapeSmallWebArgs {
  q?: string;
  limit?: number;
}

export async function scrapeSmallWeb(
  args: ScrapeSmallWebArgs,
  sessionToken: string | undefined,
): Promise<SearchResponse> {
  const start_ms = Date.now();
  const limit = args.limit ?? 25;

  if (!args.q) {
    // Browse-recent path: use the free RSS feed. No session cookie needed.
    const rss = await fetchSmallWebRss(limit);
    const results: SearchResult[] = rss.items.map((it, i) => ({
      rank: i + 1,
      url: it.link,
      title: it.title || "(untitled)",
      snippet: it.description ?? "",
      published_at: it.pub_date,
      source_domain: domainFromUrl(it.link),
      source_impl: "scrape" as const,
      props: { source: "smallweb_rss" },
    }));
    return {
      query: "",
      results,
      meta: buildMeta({ impl: "scrape", start_ms }),
    };
  }

  // Search path: kagi.com/html/search?q=<q>&l=smallweb — needs the session.
  if (!sessionToken) {
    throw new KagiAuthError(
      "Small Web search requires a Kagi session token; browse-recent (no q) works without one.",
    );
  }
  const url = new URL("https://kagi.com/html/search");
  url.searchParams.set("q", args.q);
  url.searchParams.set("l", "smallweb");
  const res = await fetch(url.toString(), {
    headers: chromeHeaders({
      kind: "document",
      cookieHeader: `kagi_session=${sessionToken}`,
    }),
  });
  if (res.status === 401 || res.status === 403) throw new KagiAuthError();
  if (!res.ok) throw new KagiUpstreamError(res.status, res.statusText);
  const html = await res.text();
  // Reuse the general search parser so any markup change is fixed once.
  const { parseSearchResults } = await import("../search.js");
  const items = parseSearchResults(html, limit);
  const results: SearchResult[] = items
    .filter((it) => it.t === 0)
    .map((it, i) => ({
      rank: i + 1,
      url: it.url,
      title: it.title,
      snippet: it.snippet,
      source_domain: domainFromUrl(it.url),
      source_impl: "scrape" as const,
      props: { source: "smallweb_search" },
    }));
  return {
    query: args.q,
    results,
    meta: buildMeta({ impl: "scrape", start_ms }),
  };
}

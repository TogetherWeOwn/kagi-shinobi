// Ported from czottmann/kagi-ken@1.3.0 src/search.js (MIT).
// Changes: TypeScript, Chrome headers instead of Safari, KagiAuthError on 401/403.
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { chromeHeaders } from "./headers.js";
import { KagiAuthError, KagiParseError, KagiUpstreamError } from "./errors.js";

export interface SearchResultItem {
  t: 0;
  url: string;
  title: string;
  snippet: string;
}

export interface RelatedSearches {
  t: 1;
  list: string[];
}

export type SearchDataItem = SearchResultItem | RelatedSearches;

export interface SearchResponse {
  data: SearchDataItem[];
}

export async function search(
  query: string,
  token: string,
  limit = 10,
): Promise<SearchResponse> {
  if (!query || typeof query !== "string") {
    throw new Error("Search query is required and must be a string");
  }
  if (!token || typeof token !== "string") {
    throw new Error("Session token is required and must be a string");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Limit must be a positive integer");
  }

  const response = await fetch(
    `https://kagi.com/html/search?q=${encodeURIComponent(query)}`,
    {
      headers: chromeHeaders({
        kind: "document",
        cookieHeader: `kagi_session=${token}`,
      }),
    },
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new KagiAuthError();
    }
    throw new KagiUpstreamError(response.status, response.statusText);
  }

  const html = await response.text();
  return { data: parseSearchResults(html, limit) };
}

export function parseSearchResults(html: string, limit: number): SearchDataItem[] {
  const $ = cheerio.load(html);
  const results: SearchDataItem[] = [];
  let count = 0;

  try {
    $(".search-result").each((_, el) => {
      if (count >= limit) return false;
      const r = extractSearchResult($, el);
      if (r) {
        results.push(r);
        count++;
      }
    });

    if (count < limit) {
      $(".sr-group .__srgi").each((_, el) => {
        if (count >= limit) return false;
        const r = extractGroupedResult($, el);
        if (r) {
          results.push(r);
          count++;
        }
      });
    }

    const related = extractRelatedSearches($);
    if (related.length > 0) results.push({ t: 1, list: related });

    return results;
  } catch {
    throw new KagiParseError(
      "Failed to parse search results — unexpected HTML structure",
    );
  }
}

function extractSearchResult(
  $: cheerio.CheerioAPI,
  el: AnyNode,
): SearchResultItem | null {
  const $el = $(el);
  const titleLink = $el.find(".__sri_title_link").first();
  const title = titleLink.text().trim();
  const url = titleLink.attr("href");
  const snippet = $el.find(".__sri-desc").text().trim();
  if (!title || !url) return null;
  return { t: 0, url, title, snippet: snippet || "" };
}

function extractGroupedResult(
  $: cheerio.CheerioAPI,
  el: AnyNode,
): SearchResultItem | null {
  const $el = $(el);
  const titleLink = $el.find(".__srgi-title a").first();
  const title = titleLink.text().trim();
  const url = titleLink.attr("href");
  const snippet = $el.find(".__sri-desc").text().trim();
  if (!title || !url) return null;
  return { t: 0, url, title, snippet: snippet || "" };
}

function extractRelatedSearches($: cheerio.CheerioAPI): string[] {
  const list: string[] = [];
  $(".related-searches a span").each((_, el) => {
    const term = $(el).text().trim();
    if (term) list.push(term);
  });
  return list;
}

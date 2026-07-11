// Scrape implementation of the KagiClient interface.
//
// Owns session-cookie management (retry-once-on-401 with Browser Rendering
// refresh) and normalizes raw scraper output into the canonical types.

import type { Env } from "../../env.js";
import { KagiAuthError, KagiError, KagiNotConfiguredError } from "../errors.js";
import { search as rawSearch } from "../search.js";
import { summarize as rawSummarize } from "../summarize.js";
import { loadToken, markStale } from "../../token/store.js";
import { refreshTokenViaBrowser } from "../../token/refresh.js";
import { scrapeSearchToCanonical, scrapeSummarizeToCanonical } from "../normalize.js";
import type { SearchResponse, SummarizeResponse, SummarizerEngine, SummaryStyle } from "../types.js";

export interface ScrapeSearchArgs {
  q: string;
  limit?: number;
}

export interface ScrapeSummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
}

/** High-level scrape client. All methods return canonical types from types.ts. */
export class KagiScrapeClient {
  constructor(private env: Env) {}

  async search(args: ScrapeSearchArgs): Promise<SearchResponse> {
    const start_ms = Date.now();
    const { token, refreshTriggered, stale } = await this.currentToken();
    let raw;
    try {
      raw = await rawSearch(args.q, token, args.limit ?? 10);
    } catch (err) {
      if (!(err instanceof KagiAuthError)) throw err;
      const fresh = await this.refreshOrThrow("search 401/403");
      raw = await rawSearch(args.q, fresh, args.limit ?? 10);
      return scrapeSearchToCanonical(args.q, raw.data, {
        impl: "scrape",
        start_ms,
        refresh_triggered: true,
        session_stale: false,
      });
    }
    return scrapeSearchToCanonical(args.q, raw.data, {
      impl: "scrape",
      start_ms,
      refresh_triggered: refreshTriggered,
      session_stale: stale,
    });
  }

  async summarize(args: ScrapeSummarizeArgs): Promise<SummarizeResponse> {
    if (args.kind === "text") {
      // Scrape cannot POST raw text to the summarizer via the session flow —
      // that path exists only on the official API.
      throw new KagiNotConfiguredError(
        "Scrape mode cannot summarize raw text; use api or hybrid mode",
      );
    }
    const start_ms = Date.now();
    const { token, refreshTriggered, stale } = await this.currentToken();
    const engine: SummarizerEngine = "scrape-default";
    try {
      const raw = await rawSummarize(args.ref, token, {
        type: args.style,
        language: args.language,
        isUrl: true,
      });
      return scrapeSummarizeToCanonical(raw, {
        ref: args.ref,
        kind: "url",
        language: args.language,
        style: args.style,
        engine,
        metaInit: {
          impl: "scrape",
          start_ms,
          refresh_triggered: refreshTriggered,
          session_stale: stale,
        },
      });
    } catch (err) {
      if (!(err instanceof KagiAuthError)) throw err;
      const fresh = await this.refreshOrThrow("summarize 401/403");
      const raw = await rawSummarize(args.ref, fresh, {
        type: args.style,
        language: args.language,
        isUrl: true,
      });
      return scrapeSummarizeToCanonical(raw, {
        ref: args.ref,
        kind: "url",
        language: args.language,
        style: args.style,
        engine,
        metaInit: {
          impl: "scrape",
          start_ms,
          refresh_triggered: true,
          session_stale: false,
        },
      });
    }
  }

  private async currentToken(): Promise<{
    token: string;
    refreshTriggered: boolean;
    stale: boolean;
  }> {
    const envelope = await loadToken(this.env);
    if (envelope && !envelope.stale) {
      return { token: envelope.token, refreshTriggered: false, stale: false };
    }
    // No token or stale — try Browser Rendering bootstrap/refresh.
    const result = await refreshTokenViaBrowser(this.env);
    if (result.ok && result.token) {
      return { token: result.token, refreshTriggered: true, stale: false };
    }
    if (envelope) {
      // Stale is better than nothing — the next 401 will retrigger refresh.
      return { token: envelope.token, refreshTriggered: false, stale: true };
    }
    throw new KagiNotConfiguredError(
      `No Kagi session token available: ${result.reason ?? "unknown"}`,
    );
  }

  private async refreshOrThrow(reason: string): Promise<string> {
    await markStale(this.env, reason);
    const result = await refreshTokenViaBrowser(this.env);
    if (!result.ok || !result.token) {
      throw new KagiAuthError(
        `Kagi token stale and refresh unavailable: ${result.reason ?? "unknown"}`,
      );
    }
    return result.token;
  }
}

// Backwards-compat alias for callers that still hold a reference to
// TokenUnavailableError from the pre-facade world. New code should catch
// KagiNotConfiguredError.
export { KagiNotConfiguredError as TokenUnavailableError } from "../errors.js";
export { KagiError };

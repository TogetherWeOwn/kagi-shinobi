// KagiClient facade — the tri-mode dispatcher.
//
// Every call routes through `pickImpl(tool, mode, override)` in
// capability.ts, so the routing rule is the same for every tool: unless the
// operator forces `KAGI_MODE`, we run in `auto` and pick per the credentials
// present. Hybrid mode obeys the operator's directive: scrape wherever the
// scraper can serve; API for anything only the API can do.
//
// Downstream sprints extend the facade without touching the dispatcher shape.

import type { Env } from "../env.js";
import { pickImpl } from "./capability.js";
import type { KagiMode, ModeResolution } from "./mode.js";
import { resolveMode } from "./mode.js";
import { KagiScrapeClient } from "./scrape/index.js";
import { KagiApiImpl } from "./api/index.js";
import { SearxngClient } from "../searxng/client.js";
import { KagiError } from "./errors.js";
import { addWarning } from "../mcp/meta.js";
import type {
  EnrichResponse,
  ExtractResponse,
  FastGPTResponse,
  KagiImpl,
  PersonalizationRule,
  RankResponse,
  SearchEngine,
  SearchResponse,
  SummarizeResponse,
  SummarizerEngine,
  SummaryStyle,
} from "./types.js";

export interface SearchArgs {
  q: string;
  limit?: number;
  lens_id?: string;
  workflow?: "web" | "news" | "images" | "videos" | "podcasts";
  include_domains?: string[];
  exclude_domains?: string[];
  date_range?: { from?: string; to?: string };
  safe_search?: boolean;
  impl?: KagiImpl;
  /**
   * Which engine serves the query. `kagi` (default) routes through the
   * tri-mode dispatcher exactly as before; `searxng` goes to the SearXNG
   * fallback; `auto` tries Kagi first and serves SearXNG on any Kagi-side
   * failure, annotating `meta.warnings`. `impl` only applies under
   * `engine=kagi` — pairing it with another engine is a 400.
   */
  engine?: SearchEngine;
}

export interface SummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
  engine?: SummarizerEngine;
  confirm_muriel?: boolean;
  impl?: KagiImpl;
}

export interface FastGPTArgs {
  query: string;
  cache?: boolean;
  impl?: KagiImpl;
}

export interface ExtractArgs {
  urls: string[];
  format?: "markdown" | "text";
  timeout_ms?: number;
}

export interface EnrichArgs {
  q: string;
}

export class KagiClient {
  private scrape: KagiScrapeClient;
  private api: KagiApiImpl;
  private searxng: SearxngClient;
  readonly modeInfo: ModeResolution;

  constructor(env: Env) {
    this.modeInfo = resolveMode(env);
    this.scrape = new KagiScrapeClient(env);
    this.api = new KagiApiImpl(env);
    this.searxng = new SearxngClient(env);
  }

  get mode(): KagiMode {
    return this.modeInfo.mode;
  }

  async search(args: SearchArgs): Promise<SearchResponse> {
    const engine = args.engine ?? "kagi";
    if (engine === "searxng") {
      if (args.impl !== undefined) {
        throw new Error("impl only applies under engine='kagi', not engine='searxng'");
      }
      return this.searxng.search({ q: args.q, limit: args.limit });
    }
    if (engine === "auto") {
      if (args.impl !== undefined) {
        throw new Error("impl only applies under engine='kagi', not engine='auto'");
      }
      return this.searchAuto(args);
    }
    const impl = pickImpl("kagi_search_fetch", this.mode, args.impl);
    if (impl === "scrape") {
      return this.scrape.search({ q: args.q, limit: args.limit });
    }
    return this.api.search({
      q: args.q,
      limit: args.limit,
      lens_id: args.lens_id,
      workflow: args.workflow,
      include_domains: args.include_domains,
      exclude_domains: args.exclude_domains,
      date_range: args.date_range,
      safe_search: args.safe_search,
    });
  }

  /**
   * engine=auto: Kagi while it answers, SearXNG otherwise.
   *
   * "Under budget and session healthy" is decided by trying Kagi first: the
   * spend guard (api mode) and the session/token flow (scrape mode) already
   * throw KagiError on exactly those conditions, so a pre-check would only
   * duplicate their judgment and race it. Any KagiError — budget, auth,
   * captcha, upstream, timeout — falls through to the free tier. Programming
   * bugs (non-KagiError) propagate: the fallback must not mask them.
   *
   * When SearXNG is unconfigured, or fails too, the caller gets the original
   * Kagi error — the root cause, not the fallback's shadow.
   */
  private async searchAuto(args: SearchArgs): Promise<SearchResponse> {
    let kagiErr: KagiError;
    try {
      return await this.search({ ...args, engine: "kagi" });
    } catch (err) {
      if (!(err instanceof KagiError)) throw err;
      kagiErr = err;
    }
    try {
      const fallback = await this.searxng.search({ q: args.q, limit: args.limit });
      return {
        ...fallback,
        meta: addWarning(
          fallback.meta,
          `Kagi unavailable (${kagiErr.kind}): ${kagiErr.message}; served by SearXNG fallback`,
        ),
      };
    } catch {
      throw kagiErr;
    }
  }

  async summarize(args: SummarizeArgs): Promise<SummarizeResponse> {
    // kagi_summarize_text is api-only per capability.ts; pickImpl enforces
    // the mode check. For URL summaries in "both"-supporting modes we honor
    // the caller's impl override.
    const tool = args.kind === "text" ? "kagi_summarize_text" : "kagi_summarize_url";
    const impl = pickImpl(tool, this.mode, args.impl);
    if (impl === "scrape") {
      return this.scrape.summarize({
        kind: args.kind,
        ref: args.ref,
        language: args.language,
        style: args.style,
      });
    }
    return this.api.summarize({
      kind: args.kind,
      ref: args.ref,
      language: args.language,
      style: args.style,
      engine: args.engine,
      confirm_muriel: args.confirm_muriel,
    });
  }

  async fastGPT(args: FastGPTArgs): Promise<FastGPTResponse> {
    const impl = pickImpl("kagi_fastgpt", this.mode, args.impl);
    if (impl === "scrape") {
      return this.scrape.fastGPT({ query: args.query });
    }
    return this.api.fastGPT({ query: args.query, cache: args.cache });
  }

  async extract(args: ExtractArgs): Promise<ExtractResponse> {
    pickImpl("kagi_extract", this.mode);
    return this.api.extract(args);
  }

  async enrichWeb(args: EnrichArgs): Promise<EnrichResponse> {
    pickImpl("kagi_enrich_web", this.mode);
    return this.api.enrichWeb(args);
  }

  async enrichNews(args: EnrichArgs): Promise<EnrichResponse> {
    pickImpl("kagi_enrich_news", this.mode);
    return this.api.enrichNews(args);
  }

  async smallWeb(args: { q?: string; limit?: number; impl?: KagiImpl }): Promise<SearchResponse> {
    const impl = pickImpl("kagi_small_web", this.mode, args.impl);
    if (impl === "scrape") {
      return this.scrape.smallWeb({ q: args.q, limit: args.limit });
    }
    return this.api.smallWeb({ q: args.q, limit: args.limit });
  }

  async rank(args: {
    urls: string[];
    q?: string;
    rules?: PersonalizationRule[];
    impl?: KagiImpl;
  }): Promise<RankResponse> {
    const impl = pickImpl("kagi_personalized_rank", this.mode, args.impl);
    if (impl === "scrape") {
      return this.scrape.rank({ urls: args.urls, q: args.q });
    }
    // api mode: q is required (server-side stateless personalization run)
    if (!args.q) {
      throw new Error("api-mode rank requires q");
    }
    return this.api.rank({ urls: args.urls, q: args.q, rules: args.rules });
  }
}

export function createKagiClient(env: Env): KagiClient {
  return new KagiClient(env);
}

// Transition-window re-exports so REST + MCP callers can migrate without a
// giant find-and-replace inside this same PR. Removed once every internal
// caller uses `createKagiClient()` directly.
export { KagiNotConfiguredError as TokenUnavailableError } from "./errors.js";

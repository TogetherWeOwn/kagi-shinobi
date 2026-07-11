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
import type {
  EnrichResponse,
  ExtractResponse,
  FastGPTResponse,
  ImplKind,
  PersonalizationRule,
  RankResponse,
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
  impl?: ImplKind;
}

export interface SummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
  engine?: SummarizerEngine;
  confirm_muriel?: boolean;
  impl?: ImplKind;
}

export interface FastGPTArgs {
  query: string;
  cache?: boolean;
  impl?: ImplKind;
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
  readonly modeInfo: ModeResolution;

  constructor(env: Env) {
    this.modeInfo = resolveMode(env);
    this.scrape = new KagiScrapeClient(env);
    this.api = new KagiApiImpl(env);
  }

  get mode(): KagiMode {
    return this.modeInfo.mode;
  }

  async search(args: SearchArgs): Promise<SearchResponse> {
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
    pickImpl("kagi_fastgpt", this.mode); // enforces mode gate (api-only for now)
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

  async smallWeb(args: { q?: string; limit?: number; impl?: ImplKind }): Promise<SearchResponse> {
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
    impl?: ImplKind;
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

// KagiClient facade — the tri-mode dispatcher.
//
// Every call routes through `pickImpl(tool, mode, override)` in
// capability.ts, so the routing rule is the same for every tool: unless the
// operator forces `KAGI_MODE`, we run in `auto` and pick per the credentials
// present. Hybrid mode obeys the operator's directive: scrape wherever the
// scraper can serve; API for anything only the API can do.
//
// Downstream sprints add more methods here (fastgpt, extract, enrich, ...)
// without touching the dispatcher shape.

import type { Env } from "../env.js";
import { pickImpl } from "./capability.js";
import type { KagiMode, ModeResolution } from "./mode.js";
import { resolveMode } from "./mode.js";
import { KagiScrapeClient } from "./scrape/index.js";
import { KagiApiImpl } from "./api/index.js";
import type { ImplKind, SearchResponse, SummarizeResponse, SummarizerEngine, SummaryStyle } from "./types.js";

export interface SearchArgs {
  q: string;
  limit?: number;
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
    return this.api.search({ q: args.q, limit: args.limit });
  }

  async summarize(args: SummarizeArgs): Promise<SummarizeResponse> {
    const impl = pickImpl("kagi_summarizer", this.mode, args.impl);
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
}

export function createKagiClient(env: Env): KagiClient {
  return new KagiClient(env);
}

// Transition-window re-exports so REST + MCP callers can migrate without a
// giant find-and-replace inside this same PR. Removed once every internal
// caller uses `createKagiClient()` directly.
export { KagiNotConfiguredError as TokenUnavailableError } from "./errors.js";

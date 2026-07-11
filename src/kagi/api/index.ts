// Official API implementation of the KagiClient interface.
//
// S2 stubs every endpoint with `KagiNotConfiguredError` so the dispatcher
// contract (mode-dispatcher.test.ts) is testable end-to-end. S3 fills in
// the real endpoints and cost tracking.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { KagiNotConfiguredError } from "../errors.js";
import type { SearchResponse, SummarizeResponse, SummarizerEngine, SummaryStyle } from "../types.js";

export interface ApiSearchArgs {
  q: string;
  limit?: number;
}

export interface ApiSummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
  engine?: SummarizerEngine;
  confirm_muriel?: boolean;
}

/**
 * High-level API client. In S2 every method throws not_configured — the S3
 * sprint replaces these with real endpoint calls once OpenAPI-typed clients
 * are generated.
 */
export class KagiApiImpl {
  private client: KagiApiClient;

  constructor(env: Env) {
    // env is used by KagiApiClient; not held on this instance to keep the
    // stub honest (real endpoint impls in S3 will store it as needed).
    this.client = new KagiApiClient(env);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  search(_args: ApiSearchArgs): Promise<SearchResponse> {
    return Promise.reject(
      new KagiNotConfiguredError("Official API search not yet implemented (arrives in S3)"),
    );
  }

  summarize(_args: ApiSummarizeArgs): Promise<SummarizeResponse> {
    return Promise.reject(
      new KagiNotConfiguredError("Official API summarize not yet implemented (arrives in S3)"),
    );
  }
}

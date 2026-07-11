// Remote MCP server: exposes tools over Streamable HTTP.
//
// S2 wired the KagiClient facade so the mode dispatcher runs on every call.
// S3 added the official API endpoint impls. S4 registers the differentiated
// tools (small_web, fastgpt, extract, enrich_{web,news}) with mode-gated
// availability — tools whose active-mode support says "unavailable" never
// appear in tools/list.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { createKagiClient, type KagiClient } from "./kagi/client.js";
import { isToolAvailable } from "./kagi/capability.js";
import {
  KagiConfirmRequiredError,
  KagiError,
  KagiNotConfiguredError,
  KagiUnsupportedInModeError,
} from "./kagi/errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./kagi/languages.js";
import type { SearchResponse } from "./kagi/types.js";
import { asStructured, mcpError, mcpResult } from "./mcp/result.js";

const SEARCH_DESCRIPTION =
  "Fetch web results based on one or more queries using the Kagi.com web search engine. " +
  "Use for general search and when the user explicitly tells you to 'fetch' results/information. " +
  "Results are from all queries given. They are numbered continuously, so that a user may be able " +
  "to refer to a result by a specific number. Supports optional limit parameter to control results per query.";

const SUMMARIZE_DESCRIPTION =
  "Summarize content from a URL using the Kagi.com Summarizer API. The Summarizer can summarize " +
  "any document type (text webpage, video, audio, etc.)";

const SMALL_WEB_DESCRIPTION =
  "Search Kagi's Small Web index — an independent corpus of personal blogs, RSS feeds, and " +
  "non-commercial pages that don't appear in mainstream engines. Omit `q` to browse recent " +
  "posts via the free RSS feed.";

const FASTGPT_DESCRIPTION =
  "Ask Kagi's FastGPT for a cited answer to a question. Returns a short answer with " +
  "references. Faster than a full search when you want a direct answer.";

const EXTRACT_DESCRIPTION =
  "Fetch one or more URLs and return their clean-markdown content (up to 10 URLs per call). " +
  "Uses Kagi's /v1/extract endpoint.";

const ENRICH_WEB_DESCRIPTION =
  "Search Kagi's Teclis web enrichment index — an independent (non-Google/Bing) crawl of " +
  "general, non-commercial content. Returns metadata only; chain into kagi_extract for bodies.";

const ENRICH_NEWS_DESCRIPTION =
  "Search Kagi's TinyGem news enrichment index. Returns metadata only for non-mainstream " +
  "news sources.";

const SUMMARIZE_URL_DESCRIPTION =
  "Summarize a URL with Kagi's Universal Summarizer. Optional engine picker: " +
  "cecil (default, $0.03/1k tokens, capped at $0.30), agnes (same tier), daphne (same tier), " +
  "or muriel ($1 flat per summary — requires confirm_muriel=true).";

const SUMMARIZE_TEXT_DESCRIPTION =
  "Summarize raw text with Kagi's Universal Summarizer. Body cap 1MB. Same engine + " +
  "pricing options as kagi_summarize_url. API-only — not available in scrape mode.";

const ENGINE_ENUM = ["cecil", "agnes", "daphne", "muriel"] as const;

export class KagiMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "kagi-shinobi",
    version: "0.2.0-dev",
  });

  async init(): Promise<void> {
    const client = createKagiClient(this.env);
    const mode = client.mode;

    // Always registered — capability matrix marks these "both".
    this.registerSearchFetch(client);
    this.registerSummarizer(client);
    this.registerSmallWeb(client);

    // kagi_summarize_url is "both" — always available.
    this.registerSummarizeUrl(client);

    // Mode-gated tools: only appear when the impl is reachable.
    if (isToolAvailable("kagi_fastgpt", mode)) this.registerFastGPT(client);
    if (isToolAvailable("kagi_extract", mode)) this.registerExtract(client);
    if (isToolAvailable("kagi_enrich_web", mode)) this.registerEnrichWeb(client);
    if (isToolAvailable("kagi_enrich_news", mode)) this.registerEnrichNews(client);
    if (isToolAvailable("kagi_summarize_text", mode)) this.registerSummarizeText(client);
  }

  private registerSummarizeUrl(client: KagiClient): void {
    this.server.tool(
      "kagi_summarize_url",
      SUMMARIZE_URL_DESCRIPTION,
      {
        url: z.string().url(),
        engine: z.enum(ENGINE_ENUM).optional(),
        summary_type: z.enum(["summary", "takeaway"]).default("summary"),
        target_language: z.string().optional(),
        confirm_muriel: z
          .boolean()
          .optional()
          .describe("Required when engine=muriel unless SUMMARIZER_MURIEL_REQUIRES_CONFIRM=false."),
        cache: z.boolean().optional(),
        impl: z.enum(["scrape", "api"]).optional(),
      },
      async ({ url, engine, summary_type, target_language, confirm_muriel, impl }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpError({
              kind: "invalid_language",
              message: `unsupported target_language '${target_language}'`,
              detail: { supported: [...SUPPORTED_LANGUAGES] },
            });
          }
          const canonical = await client.summarize({
            kind: "url",
            ref: url,
            language,
            style: summary_type,
            engine,
            confirm_muriel,
            impl,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSummarizeText(client: KagiClient): void {
    this.server.tool(
      "kagi_summarize_text",
      SUMMARIZE_TEXT_DESCRIPTION,
      {
        text: z.string().min(1).max(1_000_000).describe("Raw text to summarize (max 1MB)."),
        engine: z.enum(ENGINE_ENUM).optional(),
        summary_type: z.enum(["summary", "takeaway"]).default("summary"),
        target_language: z.string().optional(),
        confirm_muriel: z.boolean().optional(),
        cache: z.boolean().optional(),
      },
      async ({ text, engine, summary_type, target_language, confirm_muriel }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpError({
              kind: "invalid_language",
              message: `unsupported target_language '${target_language}'`,
              detail: { supported: [...SUPPORTED_LANGUAGES] },
            });
          }
          const canonical = await client.summarize({
            kind: "text",
            ref: text,
            language,
            style: summary_type,
            engine,
            confirm_muriel,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSearchFetch(client: KagiClient): void {
    this.server.tool(
      "kagi_search_fetch",
      SEARCH_DESCRIPTION,
      {
        queries: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "One or more concise, keyword-focused search queries. Include essential context within each query for standalone use.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of search results per query (default: 10, max: 50)"),
        impl: z
          .enum(["scrape", "api"])
          .optional()
          .describe(
            "Override which implementation handles this call. Ignored in single-impl modes.",
          ),
      },
      async ({ queries, limit, impl }) => {
        const cap = limit ?? 10;
        const settled = await Promise.allSettled(
          queries.map((q) => client.search({ q, limit: cap, impl })),
        );

        const perQuery: (SearchResponse | null)[] = [];
        const errors: Array<{ query: string; error: string }> = [];

        for (let i = 0; i < queries.length; i++) {
          const s = settled[i];
          const q = queries[i];
          if (s.status === "fulfilled") {
            perQuery.push(s.value);
          } else {
            perQuery.push(null);
            errors.push({ query: q, error: describeError(s.reason) });
          }
        }

        let text = formatSearchResults(queries, perQuery);
        if (errors.length > 0) {
          text += `\n\nErrors encountered:\n${errors
            .map((e) => `Query "${e.query}": ${e.error}`)
            .join("\n")}`;
        }

        return mcpResult({
          text,
          structured: {
            queries: perQuery.filter((r): r is SearchResponse => r !== null),
            errors,
            mode: client.mode,
          },
        });
      },
    );
  }

  private registerSummarizer(client: KagiClient): void {
    this.server.tool(
      "kagi_summarizer",
      SUMMARIZE_DESCRIPTION,
      {
        url: z.string().url().describe("A URL to a document to summarize."),
        summary_type: z
          .enum(["summary", "takeaway"])
          .default("summary")
          .describe(
            "Type of summary to produce. 'summary' for prose, 'takeaway' for bulleted key points.",
          ),
        target_language: z
          .string()
          .optional()
          .describe(
            "Desired output language. Two-letter code (e.g. 'EN'). Defaults to the document's original language.",
          ),
        impl: z
          .enum(["scrape", "api"])
          .optional()
          .describe(
            "Override which implementation handles this call. Ignored in single-impl modes.",
          ),
      },
      async ({ url, summary_type, target_language, impl }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpResult({
              text: `Error: unsupported target_language '${target_language}'. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
              structured: {
                error_kind: "invalid_language",
                supported: [...SUPPORTED_LANGUAGES],
              },
              isError: true,
            });
          }
          const canonical = await client.summarize({
            kind: "url",
            ref: url,
            language,
            style: summary_type,
            impl,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSmallWeb(client: KagiClient): void {
    this.server.tool(
      "kagi_small_web",
      SMALL_WEB_DESCRIPTION,
      {
        q: z
          .string()
          .optional()
          .describe("Search query. Omit to browse recent Small Web posts via RSS (free)."),
        limit: z.number().int().min(1).max(50).optional(),
        impl: z.enum(["scrape", "api"]).optional(),
      },
      async ({ q, limit, impl }) => {
        try {
          const canonical = await client.smallWeb({ q, limit, impl });
          return mcpResult({
            text: formatSmallWebText(canonical),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerFastGPT(client: KagiClient): void {
    this.server.tool(
      "kagi_fastgpt",
      FASTGPT_DESCRIPTION,
      {
        query: z.string().min(1).describe("The question to answer."),
        cache: z
          .boolean()
          .optional()
          .describe("Allow a cached answer (default: true; cached responses are free)."),
      },
      async ({ query, cache }) => {
        try {
          const canonical = await client.fastGPT({ query, cache });
          const text =
            canonical.answer +
            (canonical.references.length > 0
              ? "\n\nReferences:\n" +
                canonical.references
                  .map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)
                  .join("\n")
              : "");
          return mcpResult({ text, structured: asStructured(canonical) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerExtract(client: KagiClient): void {
    this.server.tool(
      "kagi_extract",
      EXTRACT_DESCRIPTION,
      {
        urls: z.array(z.string().url()).min(1).max(10).describe("1 to 10 URLs to extract."),
        format: z.enum(["markdown", "text"]).optional(),
        timeout_ms: z.number().int().min(1000).max(120_000).optional(),
      },
      async ({ urls, format, timeout_ms }) => {
        try {
          const canonical = await client.extract({ urls, format, timeout_ms });
          const text = canonical.pages
            .map((p, i) => `--- Page ${i + 1}: ${p.url} ---\n${p.markdown}`)
            .join("\n\n");
          return mcpResult({ text, structured: asStructured(canonical) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerEnrichWeb(client: KagiClient): void {
    this.server.tool(
      "kagi_enrich_web",
      ENRICH_WEB_DESCRIPTION,
      { q: z.string().min(1) },
      async ({ q }) => {
        try {
          const canonical = await client.enrichWeb({ q });
          return mcpResult({
            text: formatEnrichText(canonical.index, canonical.results),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerEnrichNews(client: KagiClient): void {
    this.server.tool(
      "kagi_enrich_news",
      ENRICH_NEWS_DESCRIPTION,
      { q: z.string().min(1) },
      async ({ q }) => {
        try {
          const canonical = await client.enrichNews({ q });
          return mcpResult({
            text: formatEnrichText(canonical.index, canonical.results),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }
}

function kagiErrorMcp(err: unknown) {
  if (err instanceof KagiConfirmRequiredError) {
    return mcpError({ kind: "confirm_required", message: err.message, detail: err.detail });
  }
  if (err instanceof KagiUnsupportedInModeError) {
    return mcpError({ kind: "unsupported_in_mode", message: err.message, detail: err.detail });
  }
  if (err instanceof KagiNotConfiguredError) {
    return mcpError({ kind: "not_configured", message: err.message });
  }
  if (err instanceof KagiError) {
    return mcpError({ kind: err.kind, message: err.message, detail: err.detail });
  }
  return mcpError({
    kind: "internal",
    message: err instanceof Error ? err.message : String(err),
  });
}

function describeError(reason: unknown): string {
  if (reason instanceof KagiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function formatSmallWebText(resp: SearchResponse): string {
  if (resp.results.length === 0) return "(no Small Web results)";
  return resp.results
    .map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n${r.url}\n${r.snippet || ""}`)
    .join("\n\n");
}

function formatEnrichText(
  index: "teclis" | "tinygem",
  results: Array<{ url: string; title: string; snippet: string; published_at?: string }>,
): string {
  if (results.length === 0) return `(no ${index} results — no charge)`;
  return results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n${r.url}${r.published_at ? "\n" + r.published_at : ""}\n${r.snippet}`,
    )
    .join("\n\n");
}

function formatSearchResults(
  queries: string[],
  responses: (SearchResponse | null)[],
): string {
  const chunks: string[] = [];
  let startIndex = 1;
  for (let i = 0; i < queries.length; i++) {
    const resp = responses[i];
    const results = resp?.results ?? [];
    const lines = results.map((r, idx) => {
      const n = startIndex + idx;
      return `${n}: ${r.title || "No Title"}
${r.url}
Published Date: ${r.published_at ?? "Not Available"}
${r.snippet || "No snippet available"}`;
    });
    startIndex += results.length;
    chunks.push(`-----
Results for search query "${queries[i]}":
-----
${lines.join("\n\n")}`);
  }
  return chunks.join("\n\n");
}

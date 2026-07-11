// Remote MCP server: exposes kagi_search_fetch and kagi_summarizer over
// Streamable HTTP. Tool schemas + descriptions mirror czottmann/kagi-ken-mcp
// so any client already configured for that server works with a URL swap.
//
// As of S1 both tools emit `structuredContent` alongside the legacy text
// output. Downstream sprints layer richer tools (search, small_web, fastgpt,
// extract, enrich, personalized_rank, deep_research) on top of the same
// canonical shapes in src/kagi/types.ts.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { searchWithAuth, summarizeWithAuth, TokenUnavailableError } from "./kagi/client.js";
import { KagiAuthError } from "./kagi/errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./kagi/languages.js";
import type { SearchDataItem, SearchResultItem } from "./kagi/search.js";
import type { SearchResponse, SummarizeResponse } from "./kagi/types.js";
import {
  scrapeSearchToCanonical,
  scrapeSummarizeToCanonical,
} from "./kagi/normalize.js";
import { asStructured, mcpResult } from "./mcp/result.js";

const SEARCH_DESCRIPTION =
  "Fetch web results based on one or more queries using the Kagi.com web search engine. " +
  "Use for general search and when the user explicitly tells you to 'fetch' results/information. " +
  "Results are from all queries given. They are numbered continuously, so that a user may be able " +
  "to refer to a result by a specific number. Supports optional limit parameter to control results per query.";

const SUMMARIZE_DESCRIPTION =
  "Summarize content from a URL using the Kagi.com Summarizer API. The Summarizer can summarize " +
  "any document type (text webpage, video, audio, etc.)";

export class KagiMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "kagi-shinobi",
    version: "0.2.0",
  });

  async init(): Promise<void> {
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
      },
      async ({ queries, limit }) => {
        const cap = limit ?? 10;
        const startedAt = Date.now();
        const settled = await Promise.allSettled(
          queries.map((q) => searchWithAuth(this.env, q, cap)),
        );

        const perQuery: SearchResponse[] = [];
        const errors: Array<{ query: string; error: string }> = [];
        const responses: Array<SearchDataItem[] | null> = [];

        for (let i = 0; i < queries.length; i++) {
          const s = settled[i];
          const q = queries[i];
          if (s.status === "fulfilled") {
            responses.push(s.value.data);
            perQuery.push(
              scrapeSearchToCanonical(q, s.value.data, {
                impl: "scrape",
                start_ms: startedAt,
              }),
            );
          } else {
            responses.push(null);
            errors.push({ query: q, error: describeError(s.reason) });
          }
        }

        let text = formatSearchResults(queries, responses);
        if (errors.length > 0) {
          text += `\n\nErrors encountered:\n${errors
            .map((e) => `Query "${e.query}": ${e.error}`)
            .join("\n")}`;
        }

        return mcpResult({
          text,
          structured: { queries: perQuery as unknown[], errors },
        });
      },
    );

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
      },
      async ({ url, summary_type, target_language }) => {
        const startedAt = Date.now();
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpResult({
              text: `Error: unsupported target_language '${target_language}'. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
              structured: {
                error_kind: "invalid_language",
                supported: SUPPORTED_LANGUAGES,
              },
              isError: true,
            });
          }
          const result = await summarizeWithAuth(this.env, url, {
            type: summary_type,
            language,
            isUrl: true,
          });
          const canonical: SummarizeResponse = scrapeSummarizeToCanonical(result, {
            ref: url,
            kind: "url",
            language,
            style: summary_type,
            engine: "scrape-default",
            metaInit: { impl: "scrape", start_ms: startedAt },
          });
          return mcpResult({
            text: result.data.output || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return mcpResult({
            text: `Error: ${describeError(err)}`,
            structured: { error_kind: errorKind(err), message: describeError(err) },
            isError: true,
          });
        }
      },
    );
  }
}

function describeError(reason: unknown): string {
  if (reason instanceof TokenUnavailableError) return "kagi token missing";
  if (reason instanceof KagiAuthError) return "kagi token stale";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function errorKind(reason: unknown): string {
  if (reason instanceof TokenUnavailableError) return "token_missing";
  if (reason instanceof KagiAuthError) return "auth";
  return "internal";
}

// Match the text layout of czottmann/kagi-ken-mcp so clients that grep the
// output for numbered results keep working.
function formatSearchResults(
  queries: string[],
  responses: Array<SearchDataItem[] | null>,
): string {
  const chunks: string[] = [];
  let startIndex = 1;
  for (let i = 0; i < queries.length; i++) {
    const items = (responses[i] ?? []).filter(
      (it): it is SearchResultItem => it.t === 0,
    );
    const lines = items.map((r, idx) => {
      const n = startIndex + idx;
      return `${n}: ${r.title || "No Title"}
${r.url}
Published Date: Not Available
${r.snippet || "No snippet available"}`;
    });
    startIndex += items.length;
    chunks.push(`-----
Results for search query "${queries[i]}":
-----
${lines.join("\n\n")}`);
  }
  return chunks.join("\n\n");
}

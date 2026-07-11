// Remote MCP server: exposes tools over Streamable HTTP.
//
// S2 wires every tool through the KagiClient facade so the mode dispatcher
// (scrape / api / hybrid / auto) runs on every call. `kagi_search_fetch`
// and `kagi_summarizer` keep their original names + text output for
// back-compat; downstream sprints layer richer tools on the same canonical
// shapes in src/kagi/types.ts.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { createKagiClient, type KagiClient } from "./kagi/client.js";
import {
  KagiConfirmRequiredError,
  KagiError,
  KagiNotConfiguredError,
  KagiUnsupportedInModeError,
} from "./kagi/errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./kagi/languages.js";
import type { SearchResponse } from "./kagi/types.js";
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
    version: "0.2.0-dev",
  });

  async init(): Promise<void> {
    const client = createKagiClient(this.env);
    this.registerSearchFetch(client);
    this.registerSummarizer(client);
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
                supported: SUPPORTED_LANGUAGES,
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
  if (reason instanceof KagiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function errorKind(reason: unknown): string {
  if (reason instanceof KagiConfirmRequiredError) return "confirm_required";
  if (reason instanceof KagiUnsupportedInModeError) return "unsupported_in_mode";
  if (reason instanceof KagiNotConfiguredError) return "not_configured";
  if (reason instanceof KagiError) return reason.kind;
  return "internal";
}

// Match the text layout of czottmann/kagi-ken-mcp so clients that grep the
// output for numbered results keep working.
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

// Remote MCP server: exposes kagi_search_fetch and kagi_summarizer over
// Streamable HTTP. Tool schemas + descriptions mirror czottmann/kagi-ken-mcp
// so any client already configured for that server works with a URL swap.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { searchWithAuth, summarizeWithAuth, TokenUnavailableError } from "./kagi/client.js";
import { KagiAuthError } from "./kagi/errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./kagi/languages.js";
import type { SearchDataItem, SearchResultItem } from "./kagi/search.js";

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
    version: "0.1.0",
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
        const settled = await Promise.allSettled(
          queries.map((q) => searchWithAuth(this.env, q, cap)),
        );

        const responses = settled.map((r) =>
          r.status === "fulfilled" ? r.value.data : null,
        );
        const errors = settled
          .map((r, i) =>
            r.status === "rejected"
              ? `Query "${queries[i]}": ${describeError(r.reason)}`
              : null,
          )
          .filter((s): s is string => s !== null);

        let text = formatSearchResults(queries, responses);
        if (errors.length > 0) text += `\n\nErrors encountered:\n${errors.join("\n")}`;

        return { content: [{ type: "text", text }] };
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
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: unsupported target_language '${target_language}'. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
                },
              ],
            };
          }
          const result = await summarizeWithAuth(this.env, url, {
            type: summary_type,
            language,
            isUrl: true,
          });
          return { content: [{ type: "text", text: result.data.output || "" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${describeError(err)}` }] };
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

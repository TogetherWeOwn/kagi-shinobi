// REST handlers for /search and /summarize.
// Mirror the MCP tool surface exactly so a caller can hit either.

import type { Env } from "./env.js";
import { jsonError, jsonOk } from "./util/errors.js";
import { searchWithAuth, summarizeWithAuth, TokenUnavailableError } from "./kagi/client.js";
import { KagiAuthError, KagiParseError, KagiUpstreamError } from "./kagi/errors.js";
import { isSupportedLanguage } from "./kagi/languages.js";
import { logWarn } from "./util/log.js";

interface SearchBody {
  queries?: unknown;
  limit?: unknown;
}

interface SummarizeBody {
  url?: unknown;
  summary_type?: unknown;
  target_language?: unknown;
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { queries, limit } = body;
  if (!Array.isArray(queries) || queries.length === 0) {
    return jsonError(400, "missing-queries", "Body needs { queries: string[] }");
  }
  const normQueries: string[] = [];
  for (const q of queries) {
    if (typeof q !== "string" || q.trim().length === 0) {
      return jsonError(400, "invalid-query", "All queries must be non-empty strings");
    }
    normQueries.push(q.trim());
  }

  let normLimit = 10;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return jsonError(400, "invalid-limit", "limit must be an integer between 1 and 50");
    }
    normLimit = limit;
  }

  const settled = await Promise.allSettled(
    normQueries.map((q) => withTimeout(searchWithAuth(env, q, normLimit), 15_000)),
  );

  const results: Array<{ query: string; ok: boolean; data?: unknown; error?: string }> = [];
  for (let i = 0; i < normQueries.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push({ query: normQueries[i], ok: true, data: s.value.data });
    } else {
      results.push({
        query: normQueries[i],
        ok: false,
        error: reasonToString(s.reason),
      });
    }
  }
  return jsonOk({ results });
}

export async function handleSummarize(request: Request, env: Env): Promise<Response> {
  let body: SummarizeBody;
  try {
    body = (await request.json()) as SummarizeBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { url, summary_type, target_language } = body;
  if (typeof url !== "string" || url.trim().length === 0) {
    return jsonError(400, "missing-url", "Body needs { url: string }");
  }
  const type =
    summary_type === undefined || summary_type === "summary" || summary_type === "takeaway"
      ? (summary_type ?? "summary")
      : null;
  if (type === null) {
    return jsonError(400, "invalid-summary-type", "summary_type must be 'summary' or 'takeaway'");
  }
  let language = "EN";
  if (target_language !== undefined) {
    if (typeof target_language !== "string" || !isSupportedLanguage(target_language)) {
      return jsonError(400, "invalid-language", `target_language not supported`);
    }
    language = target_language;
  }

  try {
    const result = await summarizeWithAuth(env, url, {
      type,
      language,
      isUrl: true,
    });
    return jsonOk({ ok: true, data: result.data });
  } catch (err) {
    return kagiErrorResponse(err);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function reasonToString(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

export function kagiErrorResponse(err: unknown): Response {
  if (err instanceof TokenUnavailableError) {
    return jsonError(503, "kagi-token-missing", err.message);
  }
  if (err instanceof KagiAuthError) {
    return jsonError(401, "kagi-token-stale", err.message);
  }
  if (err instanceof KagiParseError) {
    return jsonError(502, "kagi-parse-failed", err.message);
  }
  if (err instanceof KagiUpstreamError) {
    return jsonError(502, "kagi-upstream", err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  logWarn("unhandled error in REST handler", { msg });
  return jsonError(500, "internal", msg);
}

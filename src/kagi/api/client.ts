// Typed fetch wrapper for the official Kagi API.
//
// Kagi's docs specify `Authorization: Bot $TOKEN` on every request. The
// worker also participates in the tri-mode cost cap (MAX_API_CENTS_PER_MONTH)
// by consulting a KV counter before every billable call — the S3 sprint
// wires this to the api tool implementations.

import type { Env } from "../../env.js";
import { KagiError, KagiNotConfiguredError, KagiUpstreamError } from "../errors.js";

export interface KagiApiRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  timeout_ms?: number;
  headers?: Record<string, string>;
}

export interface KagiApiResponse<T> {
  data: T;
  trace_id?: string;
  http_status: number;
}

/**
 * Low-level fetch wrapper. Handles auth, timeouts, and error taxonomy;
 * intentionally does NOT implement the monthly-cost cap or per-endpoint
 * pricing — that lives in cost.ts (S3) so the wrapper stays testable.
 */
export class KagiApiClient {
  constructor(private env: Env) {}

  isConfigured(): boolean {
    return Boolean(this.env.KAGI_API_KEY && this.env.KAGI_API_KEY.length > 0);
  }

  requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new KagiNotConfiguredError(
        "KAGI_API_KEY is not set — cannot use official API. " +
          "Set the secret via `wrangler secret put KAGI_API_KEY`.",
      );
    }
  }

  async request<T>(req: KagiApiRequest): Promise<KagiApiResponse<T>> {
    this.requireConfigured();
    const controller = new AbortController();
    const timeout_ms = req.timeout_ms ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const init: RequestInit = {
        method: req.method,
        signal: controller.signal,
        headers: {
          Authorization: `Bot ${this.env.KAGI_API_KEY}`,
          "User-Agent": "kagi-shinobi/0.2 (+https://github.com/Rick7C2/kagi-shinobi)",
          ...(req.headers ?? {}),
        },
      };
      if (req.method === "POST" && req.body !== undefined) {
        (init.headers as Record<string, string>)["Content-Type"] ??=
          "application/json";
        init.body =
          typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      const response = await fetch(req.url, init);
      const trace_id =
        response.headers.get("X-Kagi-Trace") ??
        response.headers.get("x-kagi-trace") ??
        undefined;
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new KagiUpstreamError(response.status, text.slice(0, 500));
      }
      const data = (await response.json()) as T;
      return { data, trace_id, http_status: response.status };
    } catch (err) {
      if (err instanceof KagiError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new KagiError("timeout", `Kagi API request timed out after ${timeout_ms}ms`, {
          ms: timeout_ms,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

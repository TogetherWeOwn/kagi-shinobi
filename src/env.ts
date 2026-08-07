// Env binding surface.
//
// wrangler.jsonc bindings + vars are generated into worker-configuration.d.ts
// by `wrangler types`, which populates `Cloudflare.Env`. Secrets don't live in
// wrangler.jsonc (they're set at runtime via `wrangler secret put`), so we
// augment Cloudflare.Env below so the type system knows they exist.
//
// If you add a new binding, edit wrangler.jsonc and re-run `wrangler types`.
// If you add a new secret, add it to this augmentation.

declare global {
  namespace Cloudflare {
    interface Env {
      ADMIN_TOKEN: string;
      // Scrape mode
      KAGI_SESSION_TOKEN?: string;
      KAGI_EMAIL?: string;
      KAGI_PASSWORD?: string;
      // Official API mode (S3+). When absent, api-mode calls throw
      // KagiNotConfiguredError before hitting the network.
      KAGI_API_KEY?: string;
      // Tri-mode dispatcher config (populated from wrangler.jsonc `vars`).
      KAGI_MODE?: string; // "scrape" | "api" | "hybrid" | "auto"
      // Monthly hard cap on API cost, in cents. Default 0 → all billable
      // API calls refuse until the operator raises this.
      MAX_API_CENTS_PER_MONTH?: string;
      // Ops hardening (S7).
      PER_BEARER_RPM?: string;
      SUMMARIZER_MURIEL_REQUIRES_CONFIRM?: string;
      CAPTCHA_WEBHOOK_URL?: string;
    }
  }
}

export type Env = Cloudflare.Env;

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
      KAGI_SESSION_TOKEN?: string;
      KAGI_EMAIL?: string;
      KAGI_PASSWORD?: string;
    }
  }
}

export type Env = Cloudflare.Env;

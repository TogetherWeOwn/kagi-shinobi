// Vitest config — two projects, one report.
//
//   unit    : pure logic (parsers, canonical types, error taxonomy, helpers)
//             runs in plain Node against the stubs in test/_helpers.ts.
//   workers : anything that touches a Workers binding or a runtime global
//             (KV, Durable Objects, caches.default, cloudflare:* imports).
//             Runs in workerd via Miniflare, bindings resolved from
//             wrangler.jsonc.
//
// The split exists because src/index.ts -> src/research/run.ts imports
// `cloudflare:workers`, which the Node ESM loader cannot resolve at all
// ("Only URLs with a scheme in: file, data, and node are supported").
// Anything reachable from that import must live under test/workers/.
//
// Keeping the fast pure suite in Node is deliberate: workerd start-up
// dominates runtime, and most of this codebase is parsing.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workers/**"],
          environment: "node",
          globals: false,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Undoes KV writes between tests. Note it does NOT roll back a
            // Durable Object's SQL storage, so DO-backed suites still have to
            // reset their own state — see the beforeEach in
            // test/workers/cost.test.ts.
            isolatedStorage: true,
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          globals: false,
        },
      },
    ],
    coverage: {
      // istanbul, not v8: workerd does not expose V8's coverage API, so the
      // workers project cannot use the v8 provider. Keeping both projects on
      // istanbul means one merged report.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});

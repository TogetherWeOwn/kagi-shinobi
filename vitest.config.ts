// Vitest config.
//
// S1 covers pure-logic tests (parsers, canonical types, meta helpers, error
// taxonomy) — none of them touch Cloudflare bindings, so they run in a plain
// Node/vite env for now. When later sprints add tests that need KV / DO /
// fetch stubs, we'll wire in `@cloudflare/vitest-pool-workers` via a project
// config so both suites can coexist.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      // istanbul, not v8: workerd does not expose V8's coverage API, so a
      // pool-workers project cannot use the v8 provider. Keeping both suites
      // on istanbul means one merged report.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});

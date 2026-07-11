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
  },
});

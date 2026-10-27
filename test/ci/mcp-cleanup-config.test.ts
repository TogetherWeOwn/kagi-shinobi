// Read the checked-in config through Wrangler's existing JSONC parser; never
// apply a migration. Historical migrations and unrelated DOs must stay intact.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig({
  config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url).href),
});

const HISTORICAL_MIGRATIONS = [
  { tag: "v1", new_sqlite_classes: ["KagiMcpAgent"] },
  { tag: "v2", new_sqlite_classes: ["ResearchRun"] },
  { tag: "v3", new_sqlite_classes: ["Meter"] },
  { tag: "v4", new_sqlite_classes: ["ResultCache"] },
];

describe("orphaned MCP Durable Object cleanup config", () => {
  it("preserves the v1-v4 migration history", () => {
    expect(config.migrations.slice(0, 4)).toEqual(HISTORICAL_MIGRATIONS);
  });

  it("appends only v5 deleting KagiMcpAgent", () => {
    expect(config.migrations.slice(4)).toEqual([
      { tag: "v5", deleted_classes: ["KagiMcpAgent"] },
    ]);
  });

  it("removes only the MCP binding, preserving the research, meter and cache bindings", () => {
    expect(config.durable_objects.bindings).toEqual([
      { name: "RESEARCH_RUN", class_name: "ResearchRun" },
      { name: "METER", class_name: "Meter" },
      { name: "RESULT_CACHE", class_name: "ResultCache" },
    ]);
  });
});

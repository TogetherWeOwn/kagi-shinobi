// Workflow assertions prove the offline adapter is actually wired in. Behavioral
// release decisions belong to calver.test.ts; these are not a second releaser.
// Use the existing no-YAML-dependency convention from deploy-gate.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TOOLING_SHA = "1508f2c10cb83bc0677e8e559ff796a55c66e737";
const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url).href);
const workflows = () => readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => ({
  name, text: readFileSync(`${dir}/${name}`, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"),
}));
const read = (name: string) => workflows().find((w) => w.name === name)!.text;

function calverWorkflow(): string {
  const matches = workflows().filter((w) => /\bnode\b[^\n]*\bci\/calver\.ts\b/.test(w.text));
  expect(matches.map((w) => w.name), "one executable CalVer adapter workflow").toHaveLength(1);
  return matches[0].text;
}

function jobs(text: string): string[] {
  const rest = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  return rest.split(/(?=^ {2}[A-Za-z_][A-Za-z0-9_-]*:\s*$)/m).filter((block) => /^ {2}[A-Za-z_][A-Za-z0-9_-]*:/m.test(block));
}

const standardRunner = (job: string) => {
  const line = job.match(/^ {4}runs-on:\s*(.+)$/m)?.[1];
  expect(line, "new jobs use the standard free public runner, with no overflow fallback").toMatch(/^(?:ubuntu-latest|"ubuntu-latest"|'ubuntu-latest')\s*$/);
};

describe("CalVer workflow safety wiring", () => {
  it("has one adapter writer and no active release-please arithmetic writer", () => {
    calverWorkflow();
    expect(workflows().filter((w) => /uses:\s*googleapis\/release-please-action@/.test(w.text)).map((w) => w.name)).toEqual([]);
  });

  it("routes every new executable release job explicitly to standard ubuntu-latest", () => {
    const blocks = jobs(calverWorkflow());
    expect(blocks.length).toBeGreaterThan(0);
    for (const job of blocks) {
      if (/^ {4}uses:\s*\.\/.github\/workflows\/deploy\.yml/m.test(job)) continue;
      standardRunner(job);
    }
  });

  it("uses the approved shared tooling at its immutable content pin, not caller-local arithmetic", () => {
    const text = calverWorkflow();
    const sharedCheckout = text.split(/\n {6}- /).find((step) => /repository:\s*["']?TogetherWeOwn\/\.github["']?\s*$/m.test(step));
    const sharedAction = text.match(/uses:\s*TogetherWeOwn\/\.github\/[^\s@]+@([0-9a-f]{40})\s*$/m);
    if (sharedCheckout) expect(sharedCheckout).toMatch(new RegExp(`ref:\\s*["']?${TOOLING_SHA}["']?\\s*$`, "m"));
    else expect(sharedAction?.[1], "separate pinned shared-tooling checkout or action").toBe(TOOLING_SHA);
  });

  it("serializes the writer without cancelling an in-flight release", () => {
    const text = calverWorkflow();
    // Accept block or flow YAML and either key order; these are policy checks,
    // not a formatting contract. Cancellation anywhere in this writer is unsafe.
    expect(text).toMatch(/concurrency:\s*(?:\n|\{)/);
    expect(text).toMatch(/\bgroup:\s*\S+/);
    expect(text).toMatch(/\bcancel-in-progress:\s*false\b/);
    expect(text).not.toMatch(/\bcancel-in-progress:\s*true\b/);
  });

  it("grants PR/CI dispatch permissions but no production secrets or production environment", () => {
    const text = calverWorkflow();
    expect(text).toMatch(/contents:\s*write/);
    expect(text).toMatch(/pull-requests:\s*write/);
    expect(text).toMatch(/actions:\s*write/);
    expect(text).not.toMatch(/secrets\.CLOUDFLARE_|secrets:\s*inherit|environment:\s*production/);
    expect(text).not.toMatch(/pull_request_target:|gh\s+pr\s+merge[^\n]*--admin/);
  });

  it("does not depend on GITHUB_TOKEN-created release/tag events to invoke deployment", () => {
    const text = calverWorkflow();
    const events = text.slice(text.indexOf("\non:\n"), text.indexOf("\njobs:\n"));
    expect(events).not.toMatch(/^ {2}(?:release|create):/m);
    // CI dispatch and deploy dispatch are exercised as actual HTTP mutations in
    // calver.test.ts; the production workflow remains the existing guarded one.
    const deploy = read("deploy.yml");
    expect(deploy).toMatch(/^ {2}workflow_dispatch:/m);
    expect(deploy).not.toMatch(/^ {2}release:/m);
    expect(deploy).toContain("run: node ci/deploy-gate.ts");
    expect(deploy).toMatch(/needs:\s*guard/);
    expect(deploy).toMatch(/environment:\s*production/);
    expect(deploy).toContain("ref: ${{ needs.guard.outputs.sha }}");
  });

  it("does not add workflow_run onto the unsupported overflow/self-hosted fallback", () => {
    for (const workflow of workflows()) {
      if (!/^ {2}workflow_run:/m.test(workflow.text)) continue;
      for (const job of jobs(workflow.text)) {
        // Only the pre-existing guarded deploy workflow is exempt here too;
        // an opaque reusable job is not proof of a free standard runner.
        if (/^ {4}uses:\s*\.\/.github\/workflows\/deploy\.yml/m.test(job)) continue;
        standardRunner(job);
      }
    }
  });

  it("keeps dispatch as full required CI with the existing coverage and artifact-boot checks", () => {
    const ci = read("ci.yml");
    expect(ci).toMatch(/^ {2}workflow_dispatch:/m);
    expect(ci).toContain('if [ "$EVENT" != "pull_request" ]; then');
    for (const area of ["code", "deps", "ci"]) expect(ci).toContain(`echo "${area}=true" >> "$GITHUB_OUTPUT"`);
    const test = jobs(ci).find((job) => /^ {2}test:/m.test(job))!;
    const commands = ["npm run cf-typegen", "npm run typecheck", "npm run test:coverage", "npx wrangler deploy --dry-run", "npm run test:e2e"];
    let previous = -1;
    for (const command of commands) {
      const index = test.indexOf(`run: ${command}`);
      expect(index, command).toBeGreaterThan(previous);
      previous = index;
    }
    const required = jobs(ci).find((job) => /^ {2}ci-ok:/m.test(job))!;
    expect(required).toMatch(/needs:\s*\[changes, test\]/);
    expect(required).toMatch(/if:\s*always\(\)/);
    expect(required).toContain('needs.changes.result');
    expect(required).toContain('needs.test.result');
    expect(required).toContain('exit 1');
  });
});

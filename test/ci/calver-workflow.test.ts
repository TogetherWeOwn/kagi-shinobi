// Workflow assertions prove the offline adapter is actually wired in. Behavioral
// release decisions belong to calver.test.ts; these are not a second releaser.
// Use the existing no-YAML-dependency convention from deploy-gate.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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

  it("lets successful main CI callbacks from every full-suite origin reach the writer", () => {
    const text = calverWorkflow();
    expect(text).toMatch(/workflow_run:\s*\n\s+workflows:\s*\[CI\]\s*\n\s+types:\s*\[completed\]/);
    expect(read("ci.yml")).toMatch(/^name:\s*CI\s*$/m);
    const writer = jobs(text).find((job) => /\bnode\s+ci\/calver\.ts\b/.test(job))!;
    const raw = writer.match(/^ {4}if:([\s\S]*?)(?=^ {4}[a-z_-]+:)/m)?.[1] ?? "";
    const expression = raw.trim().replace(/^[>|][-+]?\s*\n/, "").trim()
      .replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
    expect(expression).not.toBe("");
    // Evaluate the existing boolean/JSON-membership expression subset, rather
    // than accepting names that are present in an unsafe OR or push-only AND.
    // Context is serialized data; no host functions, modules or I/O are exposed.
    const allows = (origin: string, change: Record<string, unknown> = {}, eventName = "workflow_run") => {
      const github = {
        repository: "TogetherWeOwn/kagi-shinobi", event_name: eventName,
        event: eventName === "workflow_run" ? { workflow_run: {
          event: origin, name: "CI", path: ".github/workflows/ci.yml", status: "completed",
          head_sha: "a".repeat(40), head_branch: "main", conclusion: "success",
          head_repository: { full_name: "TogetherWeOwn/kagi-shinobi" }, ...change,
        } } : {},
      };
      const program = `
        const github = ${JSON.stringify(github)};
        const fromJSON = JSON.parse;
        const contains = (list, value) => Array.isArray(list) ? list.includes(value) : String(list).includes(String(value));
        Boolean(${expression});
      `;
      return runInNewContext(program, Object.create(null), {
        timeout: 100, contextCodeGeneration: { strings: false, wasm: false },
      }) as boolean;
    };
    for (const origin of ["push", "workflow_dispatch", "schedule"]) {
      expect(allows(origin), `${origin}: successful exact-repository main callback`).toBe(true);
      for (const broken of [
        { head_branch: "feature" }, { conclusion: "failure" },
        { head_repository: { full_name: "outsider/kagi-shinobi" } },
      ]) expect(allows(origin, broken), `${origin}: restrictions are conjunctive`).toBe(false);
    }
    for (const origin of ["pull_request", "workflow_call"]) expect(allows(origin)).toBe(false);
    for (const event of ["push", "workflow_dispatch"]) expect(allows("", {}, event)).toBe(true);
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

  it("makes the existing required title job dispatchable with explicit PR and head inputs", () => {
    const lint = read("pr-lint.yml");
    expect(lint).toMatch(/^ {2}workflow_dispatch:/m);
    const dispatch = lint.slice(lint.indexOf("\n  workflow_dispatch:"), lint.indexOf("\njobs:\n"));
    for (const input of ["pr_number", "head_sha"]) {
      expect(dispatch).toMatch(new RegExp(`^ {6}${input}:`, "m"));
    }
    const title = jobs(lint).find((job) => /^ {2}title:/m.test(job));
    expect(title, "preserve the required title context, not a parallel optional job").toBeDefined();
    const checkName = title?.match(/^ {4}name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
    expect(checkName === undefined || checkName === "title", "required check remains named title").toBe(true);
    expect(title).toMatch(/\bnode\s+ci\/pr-lint\.ts\b/);
    expect(title).toMatch(/PR_NUMBER:\s*\$\{\{\s*inputs\.pr_number\s*\}\}/);
    expect(title).toMatch(/EXPECTED_HEAD_SHA:\s*\$\{\{\s*inputs\.head_sha\s*\}\}/);
    expect(title).toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    const checkout = title!.split(/\n {6}- /).find((step) => /uses:\s*actions\/checkout@/.test(step))!;
    const sparse = checkout.match(/sparse-checkout:\s*([^\n]+)/)?.[1]?.trim();
    // The dispatch helper is in ci/, unlike the old .github-only sparse tree.
    expect(sparse === undefined || sparse === "|" || sparse.includes("ci"), "checkout must include the executable lint helper").toBe(true);
    if (sparse === "|") expect(checkout).toMatch(/^\s+ci\s*$/m);
    expect(title).not.toMatch(/continue-on-error:\s*true|\|\|\s*true|gh\s+api[^\n]*(?:statuses|check-runs)/);
  });

  it("selects a TypeScript-capable Node runtime on the dispatch path before any .ts invocation", () => {
    const title = jobs(read("pr-lint.yml")).find((job) => /^ {2}title:/m.test(job))!;
    const steps = title.split(/\n {6}- /).slice(1).map((step) => `        ${step}`);
    const onDispatch = (step: string) => {
      const raw = `${step}\n        __end__:`.match(/^ {8}if:([\s\S]*?)(?=^ {8}[a-z_-]+:)/m)?.[1];
      if (raw === undefined) return true;
      const expression = raw.trim().replace(/^[>|][-+]?\s*\n/, "").trim()
        .replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
      return runInNewContext(`
        const github = { event_name: "workflow_dispatch" };
        const success = () => true;
        const always = () => true;
        Boolean(${expression});
      `, Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } }) as boolean;
    };
    const invocations = steps.flatMap((step, index) => /\bnode\s+(?:--[^\s]+\s+)*[^\s"']+\.ts\b/.test(step) && onDispatch(step) ? [index] : []);
    expect(invocations.length, "the dispatched lint helper must actually execute").toBeGreaterThan(0);
    const setupIndex = steps.findIndex((step) => /^ {8}uses:\s*actions\/setup-node@/m.test(step) && onDispatch(step));
    expect(setupIndex, "dispatch must explicitly set up Node, not inherit an unknown runner default").toBeGreaterThanOrEqual(0);
    const major = Number(steps[setupIndex].match(/node-version:\s*["']?(\d+)/)?.[1]);
    expect(major, "the selected Node must support direct TypeScript execution").toBeGreaterThanOrEqual(22);
    for (const index of invocations) expect(index, "Node setup must precede every executed .ts step").toBeGreaterThan(setupIndex);
  });

  it("keeps the real required lint and pinned full-history secret scan instead of a success shortcut", () => {
    const lint = read("pr-lint.yml");
    const title = jobs(lint).find((job) => /^ {2}title:/m.test(job))!;
    expect(title).toContain("python3 -m unittest discover -s .github/scripts");
    expect(title).toContain("python3 .github/scripts/pr_standards.py");
    expect(lint).toMatch(/^ {2}pull_request:/m);
    const scan = read("secret-scan.yml");
    const gitleaks = jobs(scan).find((job) => /^ {2}gitleaks:/m.test(job))!;
    expect(gitleaks, "preserve the required gitleaks job identity").toBeDefined();
    const checkName = gitleaks.match(/^ {4}name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
    expect(checkName === undefined || checkName === "gitleaks", "required check remains named gitleaks").toBe(true);
    expect(gitleaks).toMatch(/fetch-depth:\s*0/);
    expect(gitleaks).toMatch(/GITLEAKS_VERSION:\s*["']?\d+\.\d+\.\d+["']?/);
    expect(gitleaks).toContain("set -euo pipefail");
    expect(gitleaks).toMatch(/gitleaks["']?\s+detect\s+--source\s+\.\s+--config\s+\.gitleaks\.toml/);
    expect(gitleaks).not.toMatch(/continue-on-error:\s*true|\|\|\s*true|--exit-code(?:[= ]+)0|gh\s+api[^\n]*(?:statuses|check-runs)/);
    expect(gitleaks).not.toMatch(/ref:\s*(?:["']?main["']?|refs\/heads\/main)\s*$/m);
    expect(scan).toMatch(/^ {2}pull_request:/m);
  });

  it("routes the new required-check dispatch event without self-hosted overflow defaults", () => {
    for (const filename of ["ci.yml", "pr-lint.yml", "secret-scan.yml"]) {
      const text = read(filename);
      expect(text, filename).toMatch(/^ {2}workflow_dispatch:/m);
      for (const job of jobs(text)) {
        const runner = job.match(/^ {4}runs-on:\s*(.+)$/m)?.[1];
        if (/^(?:ubuntu-latest|"ubuntu-latest"|'ubuntu-latest')\s*$/.test(runner ?? "")) continue;
        // Existing PR/push/schedule routing need not migrate in this slice.
        // This explicit first branch proves dispatch uses ubuntu-latest even
        // with every overflow variable absent; a truthy runner cannot fall back.
        expect(runner, `${filename}: dispatch must select the free runner before legacy routing`).toMatch(
          /^\$\{\{\s*github\.event_name\s*==\s*["']workflow_dispatch["']\s*&&\s*["']ubuntu-latest["']\s*\|\|/,
        );
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

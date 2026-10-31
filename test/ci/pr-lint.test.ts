// Dispatch acceptance seam, implemented independently in future ci/pr-lint.ts:
//   runPrLint(env: Record<string, string | undefined>, deps: {
//     fetch: typeof fetch; log: (line: string) => void;
//     lint: (input: Record<string, string | undefined>) => Promise<void>;
//   }): Promise<{ number: number; headSha: string }>
//
// PR_NUMBER and EXPECTED_HEAD_SHA come from workflow_dispatch string inputs.
// GITHUB_SHA is the dispatch's actual head. Validate all three before linting;
// GET /repos/{GITHUB_REPOSITORY}/pulls/{PR_NUMBER} must independently bind the
// selected number/repository/head to the checkout. Run the real Conventional
// Commit title and existing PR-body rules against that response's title/body.
// Neither empty commits, webhook defaults nor caller-provided PR_TITLE/PR_BODY
// are metadata. Only a successful actual lint may return evidence. No GitHub
// status/check SUCCESS writes: the required title job itself runs this helper.
//
// lint receives EVENT=pull_request, TITLE, BODY, AUTHOR, HEAD_REF, REPO_PRIVATE
// from verified metadata and preserves PR_STANDARDS_MODE / REQUIRE_CARD_REF.
// Its real default runs the existing Python gate, not copied validation rules.
// This test's injected lint callback ALSO executes that real Python script; it
// is not a passing stub. Only GitHub HTTP is fake. Missing-module red is allowed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const REPO = "TogetherWeOwn/kagi-shinobi";
const HEAD_SHA = "d".repeat(40);
const OTHER_SHA = "a".repeat(40);
const TITLE = "chore: release 2026.1030.0";
const BODY = `## Thinking Path

> - Generated release proposals do not start token-created workflow events
> - Required title and secret checks must run alongside full CI on the branch
> - Explicit workflow dispatch binds actual checks to the proposal head

## Linked Issues or Issue Description

Routine release bookkeeping uses the existing reviewed version proposal.

## What Changed

- Update package version and release notes without changing production gates

## Verification

- Offline acceptance fixtures exercise workflow selection and exact head binding

## Risks

- A failed required check must prevent approval, not manufacture a success

## Model Used

- OpenAI gpt-6.1-sol
`;
const LINT_SCRIPT = fileURLToPath(new URL("../../.github/scripts/pr_standards.py", import.meta.url).href);

type Env = Record<string, string | undefined>;
interface Deps {
  fetch: typeof fetch;
  log: (line: string) => void;
  lint: (input: Env) => Promise<void>;
}
type RunPrLint = (env: Env, deps: Deps) => Promise<{ number: number; headSha: string }>;
let runPrLint: RunPrLint;
beforeEach(async () => {
  ({ runPrLint } = await import("../../ci/pr-lint"));
});

const metadata = () => ({
  number: 42, state: "open", draft: false, title: TITLE, body: BODY,
  user: { login: "github-actions[bot]", type: "Bot" },
  head: { ref: "release/calver", sha: HEAD_SHA, repo: { full_name: REPO, private: false } },
  base: { ref: "main", repo: { full_name: REPO, private: false } },
});
interface Call { method: string; path: string }
function harness(options: { env?: Env; metadata?: unknown; status?: number; malformedJson?: boolean; networkError?: Error; lintError?: Error } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const lintInputs: Env[] = [];
  const env: Env = {
    GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "lint-offline-fixture", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/release/calver", GITHUB_SHA: HEAD_SHA,
    PR_NUMBER: "42", EXPECTED_HEAD_SHA: HEAD_SHA, PR_STANDARDS_MODE: "warn", REQUIRE_CARD_REF: "false", ...options.env,
  };
  const http: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname });
    if (request.method !== "GET" || url.origin !== "https://api.github.com" || url.pathname !== `/repos/${REPO}/pulls/42`) {
      throw new Error(`unexpected lint request: ${request.method} ${url.pathname}`);
    }
    if (options.networkError) throw options.networkError;
    if (options.status) return new Response(JSON.stringify({ message: "provider-body-never-disclose" }), { status: options.status });
    if (options.malformedJson) return new Response("provider-body-never-disclose", { status: 200 });
    return new Response(JSON.stringify(options.metadata === undefined ? metadata() : options.metadata), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const lint = async (input: Env) => {
    lintInputs.push({ ...input });
    if (options.lintError) throw options.lintError;
    const result = spawnSync("python3", [LINT_SCRIPT], {
      env: { ...process.env, ...input }, encoding: "utf8", timeout: 5_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PR lint failed:\n${result.stdout}\n${result.stderr}`);
  };
  return { calls, logs, lintInputs, run: () => runPrLint(env, { fetch: http, lint, log: (line) => logs.push(line) }) };
}

describe("dispatched PR lint binds actual PR metadata and the intended exact head", () => {
  it("lints the selected live PR on the release branch, without synthetic success API writes", async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ number: 42, headSha: HEAD_SHA });
    expect(h.calls).toEqual([{ method: "GET", path: `/repos/${REPO}/pulls/42` }]);
    expect(h.lintInputs).toHaveLength(1);
    expect(h.lintInputs[0]).toMatchObject({
      EVENT: "pull_request", TITLE, BODY, AUTHOR: "github-actions[bot]", HEAD_REF: "release/calver",
      REPO_PRIVATE: "false", PR_STANDARDS_MODE: "warn", REQUIRE_CARD_REF: "false",
    });
  });

  it("uses actual metadata, not missing/default event title and body", async () => {
    const h = harness({ env: { PR_TITLE: "", PR_BODY: "", COMMITS: "[]" } });
    expect(await h.run()).toMatchObject({ number: 42, headSha: HEAD_SHA });
    expect(h.calls).toHaveLength(1);
  });

  it("rejects the actual nonconventional title even if caller defaults claim a valid one", async () => {
    const h = harness({ metadata: { ...metadata(), title: "Release package update" }, env: {
      PR_TITLE: TITLE, PR_BODY: BODY, AUTHOR: "dependabot[bot]", GITHUB_ACTOR: "dependabot[bot]", COMMITS: "[]",
    } });
    await expect(h.run()).rejects.toThrow(/title|conventional|semantic/i);
  });

  it("rejects an invalid actual body even if caller defaults claim a valid one", async () => {
    const h = harness({ metadata: { ...metadata(), body: "" }, env: { PR_TITLE: TITLE, PR_BODY: BODY, COMMITS: "[]" } });
    await expect(h.run()).rejects.toThrow(/body|section|model|standards/i);
    expect(h.lintInputs[0]).toMatchObject({ EVENT: "pull_request", BODY: "" });
  });

  it.each(["warn", "error"])("preserves the existing structured-body %s policy rather than silently changing it", async (mode) => {
    const h = harness({
      metadata: { ...metadata(), body: "This genuine proposal body is long enough but intentionally lacks structured sections." },
      env: { PR_STANDARDS_MODE: mode },
    });
    if (mode === "warn") expect(await h.run()).toMatchObject({ number: 42, headSha: HEAD_SHA });
    else await expect(h.run()).rejects.toThrow(/lint failed/);
    expect(h.lintInputs[0]).toMatchObject({ EVENT: "pull_request", PR_STANDARDS_MODE: mode });
  });

  it("propagates a real lint invocation failure instead of returning head evidence", async () => {
    const h = harness({ lintError: new Error("lint command exited 2") });
    await expect(h.run()).rejects.toThrow(/lint command exited 2/);
    expect(h.lintInputs).toHaveLength(1);
  });

  it.each([undefined, "", "0", "-1", "42.5", "42/commits", " 42", "42\n"])(
    "refuses missing or malformed PR selection %j before HTTP or lint success",
    async (number) => {
      const h = harness({ env: { PR_NUMBER: number } });
      await expect(h.run()).rejects.toThrow(/PR_NUMBER|number|selection/i);
      expect(h.calls).toEqual([]);
      expect(h.lintInputs).toEqual([]);
    },
  );

  it.each([undefined, "", "main", "abc123", "D".repeat(40), `${HEAD_SHA}\n`])(
    "refuses a non-exact expected head %j before HTTP",
    async (sha) => {
      const h = harness({ env: { EXPECTED_HEAD_SHA: sha } });
      await expect(h.run()).rejects.toThrow(/SHA|head/i);
      expect(h.calls).toEqual([]);
    },
  );

  it("refuses when the dispatch checkout differs from the requested exact head", async () => {
    const h = harness({ env: { GITHUB_SHA: OTHER_SHA } });
    await expect(h.run()).rejects.toThrow(/SHA|head|checkout/i);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["another PR number", { ...metadata(), number: 43 }],
    ["a moved head", { ...metadata(), head: { ...metadata().head, sha: OTHER_SHA } }],
    ["a fork's head", { ...metadata(), head: { ...metadata().head, repo: { ...metadata().head.repo, full_name: "outsider/kagi-shinobi" } } }],
    ["another base repository", { ...metadata(), base: { ...metadata().base, repo: { ...metadata().base.repo, full_name: "outsider/kagi-shinobi" } } }],
    ["no head", { ...metadata(), head: null }],
    ["missing title", { ...metadata(), title: null }],
    ["no PR object", null],
  ] as const)("rejects successful metadata HTTP with %s", async (_name, actual) => {
    const h = harness({ metadata: actual });
    await expect(h.run()).rejects.toThrow();
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
    expect(h.lintInputs).toEqual([]);
  });

  it.each([403, 404, 500])("fails closed on PR metadata HTTP %i and does not disclose the provider body", async (status) => {
    const h = harness({ status });
    let failure: unknown;
    try { await h.run(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`HTTP ${status}`);
    expect(`${(failure as Error).message}\n${h.logs.join("\n")}`).not.toMatch(/provider-body-never-disclose|lint-offline-fixture/);
  });

  it("fails closed on malformed metadata JSON without treating empty input as valid lint", async () => {
    const h = harness({ malformedJson: true });
    await expect(h.run()).rejects.toThrow();
  });

  it("propagates network failure, never replacing it with an empty title/body success", async () => {
    const h = harness({ networkError: new Error("offline metadata transport failed") });
    await expect(h.run()).rejects.toThrow(/transport failed/);
  });
});

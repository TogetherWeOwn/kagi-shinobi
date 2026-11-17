// CalVer remains a numeric triple accepted by the EXISTING production gate.
// These supplement, never replace, the SemVer/annotated-tag/CI/mode assertions
// in deploy-gate.test.ts. No second or weaker CalVer gate is introduced.
import { describe, expect, it } from "vitest";
import { runGate, type Env, type EnvironmentInfo } from "../../ci/deploy-gate";

const REPO = "TogetherWeOwn/kagi-shinobi";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TAG = "v2026.1030.0";

interface World {
  version: string;
  release: { id: number; tag_name: string; draft: boolean } | null;
  ciSha: string;
  conclusion: string;
  branch: string;
}
const world = (over: Partial<World> = {}): World => ({
  version: "2026.1030.0", release: { id: 42, tag_name: TAG, draft: false },
  ciSha: SHA, conclusion: "success", branch: "main", ...over,
});

function gate(w: World, auto: boolean, over: Env = {}) {
  let time = 0;
  const environment: EnvironmentInfo = {
    name: "production", protection_rules: [
      { type: "branch_policy" },
      ...(auto ? [] : [{ type: "required_reviewers", reviewers: [{ type: "User" }] }]),
    ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const http: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(`/repos/${REPO}`, "");
    if (path === `/git/ref/tags/${TAG}`) return json({ object: { type: "commit", sha: SHA } });
    if (path === `/compare/main...${SHA}`) return json({ status: "identical" });
    if (path === `/releases/tags/${TAG}`) return w.release ? json(w.release) : json({}, 404);
    if (path === "/contents/package.json") return json({ encoding: "base64", content: Buffer.from(JSON.stringify({ version: w.version })).toString("base64") });
    if (path === "/environments/production") return json(environment);
    if (path === "/environments/production/deployment-branch-policies") return json({ branch_policies: [{ name: w.branch, type: "branch" }] });
    if (path === "/actions/workflows/ci.yml/runs") return json({ total_count: 1, workflow_runs: [{
      id: 7, event: "push", status: "completed", conclusion: w.conclusion,
      head_sha: w.ciSha, head_repository: { full_name: REPO },
    }] });
    throw new Error(`unexpected gate request: ${path}`);
  };
  return runGate({
    GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "offline-token", GITHUB_REF: "refs/heads/main",
    TAG, PRODUCTION_AUTO_APPROVE: auto ? "true" : "false", ...over,
  }, { fetch: http, now: () => time, sleep: async (ms) => { time += ms; }, log: () => {} });
}

describe.each([true, false])("the existing gate for CalVer, auto=%j", (auto) => {
  it("accepts exact package/tag, published Release, exact-SHA green CI and main-only production", async () => {
    expect(await gate(world(), auto)).toMatchObject({ tag: TAG, sha: SHA, releaseId: 42, ciRunId: 7 });
  });
  it("refuses package/tag mismatch", async () => {
    await expect(gate(world({ version: "2026.1030.1" }), auto)).rejects.toThrow(/not 2026\.1030\.0/);
  });
  it("refuses a missing Release", async () => {
    await expect(gate(world({ release: null }), auto)).rejects.toThrow(/no GitHub release/);
  });
  it("refuses a draft Release", async () => {
    await expect(gate(world({ release: { id: 42, tag_name: TAG, draft: true } }), auto)).rejects.toThrow(/draft/);
  });
  it("refuses green CI belonging to a different SHA", async () => {
    await expect(gate(world({ ciSha: OTHER_SHA }), auto)).rejects.toThrow(/no full-suite/);
  });
  it("refuses unsuccessful exact-SHA CI", async () => {
    await expect(gate(world({ conclusion: "failure" }), auto)).rejects.toThrow(/concluded failure/);
  });
  it("refuses a widened production environment branch policy", async () => {
    await expect(gate(world({ branch: "*" }), auto)).rejects.toThrow(/main only/);
  });
  it("refuses dispatching the production workflow from a non-main ref", async () => {
    await expect(gate(world(), auto, { GITHUB_REF: "refs/heads/release/calver" })).rejects.toThrow(/main only/);
  });
});

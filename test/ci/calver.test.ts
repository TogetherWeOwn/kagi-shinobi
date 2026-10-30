// Blind caller acceptance tests; the shared engine owns allocation/publication.
//
// Implement this import-safe seam in ci/calver.ts, following runGate(env, deps):
//   runCalver(env: Record<string, string | undefined>, deps: Deps): Promise<Result>
// Deps: { event: unknown, fetch: typeof fetch, now: () => Date, log(line): void,
//         releaser: { plan(input), notes(plan), publish(plan, options?) } }.
// The releaser wraps the pinned shared Releaser, using the same UTC clock. Its
// plan is opaque: forward it unchanged to notes/publish; never allocate locally.
// Result.status is "ignored", "version-pr", or "published" (NOT "deployed").
// A version-pr result includes number/version/headSha; a published result includes
// version/tag/sha/releaseUrl/deploymentDispatched. Dispatch is not rollout proof.
//
// Selection convention: ready PR, github-actions[bot], label calver:release,
// same-repository release/calver -> main, independently fetched merged PR whose
// merge_commit_sha is this invocation's exact main SHA. No event/body/package
// string alone authorizes publication. Verify commit-associated PRs through
// /commits/{sha}/pulls, /pulls/{number} and /pulls/{number}/files. Operation
// identity survives a new run ID.
//
// Version PRs atomically commit package.json, package-lock.json and CHANGELOG.md
// with Git Data tree/commit/ref APIs, create/update a normal reviewed PR, then
// explicitly dispatch ci.yml on its updated release/calver branch. Publication
// explicitly dispatches deploy.yml on main with inputs.tag, only AFTER the shared
// publisher resolves. No tag/Release writes belong to the caller itself.
//
// All GitHub traffic below is an offline HTTP fake. Planner answers are literal
// fixtures, not a second allocator. Initial missing-module red is intentional;
// load in beforeEach so every acceptance case remains visible in the red run.
import { beforeEach, describe, expect, it } from "vitest";

const REPO = "TogetherWeOwn/kagi-shinobi";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PR_SHA = "c".repeat(40);
const UPDATED_SHA = "d".repeat(40);
const TREE_SHA = "e".repeat(40);
const TAG_OBJECT_SHA = "f".repeat(40);
const BRANCH = "release/calver";
const LABEL = "calver:release";
const VERSION = "2026.1030.0";
const TAG = "v2026.1030.0";
const NOTES = "### Features\n\n* Add offline release selection\n";
const RELEASE_URL = `https://github.com/${REPO}/releases/tag/${TAG}`;

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
interface PlanInput {
  channel: "stable";
  sha: string;
  operation: string;
  policy: "direct-release";
  namespace?: string;
  latest?: string;
}
interface Plan extends PlanInput {
  schema: string;
  repository: string;
  version: string;
  tag: string;
  date: string;
  namespace: string;
  latest: string;
  repairDate: null;
  sourceCanary: null;
  source: null;
  evidence: null;
  previousStableTag: string | null;
  id: string;
}
interface Publication extends Plan {
  created: boolean;
  releaseUrl: string;
  dryRun: boolean;
}
interface Deps {
  event: unknown;
  fetch: typeof fetch;
  now: () => Date;
  log: (line: string) => void;
  releaser: {
    plan: (input: PlanInput) => Promise<Plan>;
    notes: (plan: Plan) => Promise<string>;
    publish: (plan: Plan, options?: Json) => Promise<Publication>;
  };
}
interface Result {
  status: "ignored" | "version-pr" | "published";
  number?: number;
  version?: string;
  tag?: string;
  sha?: string;
  headSha?: string;
  releaseUrl?: string;
  deploymentDispatched?: boolean;
}
type RunCalver = (env: Env, deps: Deps) => Promise<Result>;
let runCalver: RunCalver;
beforeEach(async () => {
  ({ runCalver } = await import("../../ci/calver"));
});

const repo = () => ({ full_name: REPO, default_branch: "main", private: false });
const selectedPull = () => ({
  number: 42,
  state: "closed",
  merged: true,
  merged_at: "2026-10-30T06:00:00Z",
  merge_commit_sha: SHA,
  draft: false,
  user: { login: "github-actions[bot]", type: "Bot" },
  labels: [{ name: LABEL }],
  head: { ref: BRANCH, sha: PR_SHA, repo: repo() },
  base: { ref: "main", sha: OTHER_SHA, repo: repo() },
  title: `chore: release ${VERSION}`,
  body: `Release ${VERSION}`,
});
type Pull = ReturnType<typeof selectedPull>;

function manifests(version = VERSION): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "kagi-shinobi", version, private: true,
      scripts: { test: "vitest run" }, dependencies: { example: "1.2.3" },
    }),
    "package-lock.json": JSON.stringify({
      name: "kagi-shinobi", version, lockfileVersion: 3, requires: true,
      packages: {
        "": { name: "kagi-shinobi", version, dependencies: { example: "1.2.3" } },
        "node_modules/example": { version: "1.2.3", integrity: "fixture-integrity" },
      },
    }),
    "CHANGELOG.md": `# Changelog\n\n## ${version}\n\n${NOTES}\n## 1.0.0\n\nPrevious notes stay.\n`,
  };
}

interface World {
  pull: Pull | null;
  openPull: Pull | null;
  associated: Pull[] | null;
  files: Record<string, string>;
  changedFiles: string[];
  mainSha: string;
  plans: Array<Partial<Plan>>;
  time: string;
  afterPlan?: () => void;
  publishError?: Error;
  publication?: Partial<Publication>;
  existingPlan?: Plan;
  existingTagSha?: string;
  status: Record<string, number>;
}
const world = (over: Partial<World> = {}): World => ({
  pull: selectedPull(), openPull: null, associated: null,
  files: manifests(), changedFiles: ["package.json", "package-lock.json", "CHANGELOG.md"],
  mainSha: SHA, plans: [{}], time: "2026-10-30T06:01:00Z", status: {}, ...over,
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Json;
  branchSha: string | null;
}
function harness(w = world(), envOver: Env = {}, eventOver?: unknown) {
  const env: Env = {
    GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "offline-token", GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: SHA, GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1",
    ...envOver,
  };
  const calls: Call[] = [];
  const effects: string[] = [];
  const logs: string[] = [];
  const planned: Plan[] = [];
  const planInputs: PlanInput[] = [];
  const published: Array<{ plan: Plan; options?: Json }> = [];
  let branchSha = w.openPull?.head.sha ?? null;
  let openPull = w.openPull;
  let candidate: Record<string, string> = {};
  const blobs = new Map<string, string>();
  const updatedTree = "8".repeat(40);
  let publicationFinished = false;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const noContent = () => new Response(null, { status: 204 });
  const http: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected origin: ${url.origin}`);
    const path = decodeURIComponent(url.pathname.replace(`/repos/${REPO}`, ""));
    const method = request.method;
    const body = request.body ? await request.json() as Json : {};
    calls.push({ method, path, query: url.searchParams, body, branchSha });
    const forced = w.status[`${method} ${path}`];
    if (forced) return json({ message: "provider-body-do-not-log" }, forced);
    if (method === "GET") {
      if (path === "") return json(repo());
      if (path === `/commits/${SHA}/pulls`) return json(w.associated ?? (w.pull ? [w.pull] : []));
      const pulls = [
        ...(w.associated ?? []), ...(w.pull ? [w.pull] : []), ...(openPull ? [openPull] : []),
      ];
      const pullRoute = path.match(/^\/pulls\/(\d+)(?:\/(files|reviews))?$/);
      if (pullRoute) {
        const pull = pulls.find((p) => p.number === Number(pullRoute[1]));
        if (!pull) return json({}, 404);
        if (pullRoute[2] === "files") return json(w.changedFiles.map((filename) => ({ filename, status: "modified" })));
        if (pullRoute[2] === "reviews") return json([{ id: 1, state: "APPROVED", commit_id: pull.head.sha, user: { login: "reviewer", type: "User" } }]);
        return json(pull);
      }
      if (path === "/pulls") {
        const state = url.searchParams.get("state") ?? "open";
        const unique = Array.from(new Map(pulls.map((pull) => [pull.number, pull])).values());
        return json(unique.filter((pull) => state === "all" || pull.state === state));
      }
      if (path === "/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { type: "commit", sha: w.mainSha } });
      if (path === `/git/ref/heads/${BRANCH}`) return branchSha
        ? json({ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: branchSha } }) : json({}, 404);
      if (path === `/git/commits/${SHA}` || path === `/git/commits/${w.mainSha}`) return json({ sha: path.split("/").at(-1), tree: { sha: TREE_SHA } });
      if (path.startsWith("/contents/")) {
        const name = path.slice("/contents/".length);
        const ref = url.searchParams.get("ref");
        const files = ref === UPDATED_SHA || ref === BRANCH ? candidate : w.files;
        const content = files[name];
        return content === undefined ? json({}, 404) : json({ type: "file", encoding: "base64", sha: TREE_SHA, content: Buffer.from(content).toString("base64") });
      }
      if (path === `/compare/${SHA}...main`) return json({ status: "ahead" });
      if (path === `/compare/main...${SHA}`) return json({ status: "behind" });
      if (path === `/releases/tags/${TAG}`) return w.existingPlan ? json({
        id: 17, tag_name: TAG, draft: false, prerelease: false, html_url: RELEASE_URL,
        body: `<!-- calver-plan:${w.existingPlan.id} -->`,
      }) : json({}, 404);
      if (path === `/git/ref/tags/${TAG}`) return w.existingPlan
        ? json({ ref: `refs/tags/${TAG}`, object: { type: "tag", sha: TAG_OBJECT_SHA } }) : json({}, 404);
      if (path === `/git/tags/${TAG_OBJECT_SHA}` && w.existingPlan) return json({
        sha: TAG_OBJECT_SHA, tag: TAG,
        message: `calver-plan-v1\n${JSON.stringify({ ...w.existingPlan, publicationEvidence: null })}`,
        object: { type: "commit", sha: w.existingTagSha ?? SHA },
      });
      if (path === "/actions/workflows/ci.yml/runs") return json({ total_count: 1, workflow_runs: [{
        id: 8, event: "push", status: "completed", conclusion: "success", head_sha: SHA,
        head_branch: "main", head_repository: repo(), path: ".github/workflows/ci.yml",
      }] });
    }
    if (method === "POST" && path === "/git/blobs") {
      const content = body.encoding === "base64" ? Buffer.from(String(body.content), "base64").toString("utf8") : String(body.content);
      const sha = String(blobs.size + 1).padStart(40, "0");
      blobs.set(sha, content);
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/git/trees") {
      candidate = { ...w.files };
      for (const entry of body.tree as Array<{ path: string; content?: string; sha?: string }>) {
        const content = entry.content ?? blobs.get(entry.sha ?? "");
        if (content === undefined) throw new Error(`tree refers to an unknown blob for ${entry.path}`);
        candidate[entry.path] = content;
      }
      return json({ sha: updatedTree }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      if (body.tree !== updatedTree) throw new Error("version commit did not bind the updated tree");
      return json({ sha: UPDATED_SHA, tree: { sha: updatedTree } }, 201);
    }
    if (method === "POST" && path === "/git/refs" && body.ref === `refs/heads/${BRANCH}`) {
      branchSha = String(body.sha);
      effects.push("version-commit");
      return json({ ref: body.ref, object: { type: "commit", sha: branchSha } }, 201);
    }
    if (method === "PATCH" && path === `/git/refs/heads/${BRANCH}`) {
      branchSha = String(body.sha);
      effects.push("version-commit");
      return json({ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: branchSha } });
    }
    if (method === "POST" && path === "/pulls") {
      openPull = { ...selectedPull(), number: w.pull ? 43 : 42, state: "open", merged: false, merged_at: "", draft: body.draft === true,
        head: { ref: BRANCH, sha: branchSha ?? UPDATED_SHA, repo: repo() },
        title: String(body.title), body: String(body.body ?? ""), labels: [] };
      return json(openPull, 201);
    }
    if (method === "PATCH" && path === `/pulls/${openPull?.number}` && openPull) {
      openPull = { ...openPull, ...body } as Pull;
      return json(openPull);
    }
    if (method === "POST" && path === `/issues/${openPull?.number}/labels`) {
      const labels = body.labels as string[];
      if (openPull) openPull.labels = labels.map((name) => ({ name }));
      return json(labels.map((name) => ({ name })));
    }
    if (method === "POST" && path === "/actions/workflows/ci.yml/dispatches") {
      effects.push("dispatch-ci");
      return noContent();
    }
    if (method === "POST" && path === "/actions/workflows/deploy.yml/dispatches") {
      if (!publicationFinished) throw new Error("deployment invoked before publication completed");
      effects.push("dispatch-deploy");
      return noContent();
    }
    throw new Error(`unexpected GitHub request: ${method} ${path}${url.search}`);
  };
  const deps: Deps = {
    fetch: http, event: eventOver ?? { ref: "refs/heads/main", after: SHA, repository: repo() },
    now: () => new Date(w.time), log: (line) => logs.push(line),
    releaser: {
      plan: async (input) => {
        planInputs.push(structuredClone(input));
        const answer = w.plans[Math.min(planned.length, w.plans.length - 1)];
        const plan: Plan = {
          schema: "calver-plan-v1", repository: REPO, channel: "stable", namespace: "", latest: "auto",
          sha: input.sha, operation: input.operation, policy: "direct-release", date: "2026-10-30",
          version: VERSION, tag: TAG, repairDate: null, sourceCanary: null, source: null, evidence: null,
          previousStableTag: "v1.0.1", id: "1".repeat(64), ...answer,
        };
        planned.push(plan);
        w.afterPlan?.();
        return plan;
      },
      notes: async () => NOTES,
      publish: async (plan, options) => {
        published.push({ plan: structuredClone(plan), options });
        if (w.publishError) throw w.publishError;
        // A caller that fires and forgets publication must not dispatch deploy.
        await Promise.resolve();
        publicationFinished = true;
        effects.push("publish");
        return { ...plan, created: true, releaseUrl: RELEASE_URL, dryRun: false, ...w.publication };
      },
    },
  };
  return {
    env, deps, calls, effects, logs, planned, planInputs, published,
    candidate: () => candidate, pull: () => openPull,
    run: () => runCalver(env, deps),
    dispatches: (workflow: string) => calls.filter((c) => c.method === "POST" && c.path === `/actions/workflows/${workflow}/dispatches`),
  };
}

function expectNoPublication(h: ReturnType<typeof harness>): void {
  expect(h.published).toEqual([]);
  expect(h.dispatches("deploy.yml")).toEqual([]);
  expect(h.calls.filter((c) => c.method !== "GET" && (/\/git\/tags|\/releases|refs\/tags/.test(c.path) || String(c.body.ref ?? "").startsWith("refs/tags/")))).toEqual([]);
}

function expectVersionCommit(h: ReturnType<typeof harness>, version: string): void {
  const files = h.candidate();
  const pkg = JSON.parse(files["package.json"]);
  const lock = JSON.parse(files["package-lock.json"]);
  expect(pkg).toEqual({ name: "kagi-shinobi", version, private: true, scripts: { test: "vitest run" }, dependencies: { example: "1.2.3" } });
  expect(lock.version).toBe(version);
  expect(lock.packages[""].version).toBe(version);
  expect(lock.packages[""]).toMatchObject({ name: "kagi-shinobi", dependencies: { example: "1.2.3" } });
  expect(lock.packages["node_modules/example"]).toEqual({ version: "1.2.3", integrity: "fixture-integrity" });
  expect(files["CHANGELOG.md"]).toContain(version);
  expect(files["CHANGELOG.md"]).toContain(NOTES);
  expect(files["CHANGELOG.md"]).toContain("Previous notes stay.");
  const tree = h.calls.find((c) => c.method === "POST" && c.path === "/git/trees");
  expect((tree?.body.tree as Array<{ path: string }>).map((entry) => entry.path).sort()).toEqual(["CHANGELOG.md", "package-lock.json", "package.json"]);
  expect(h.calls.find((c) => c.method === "POST" && c.path === "/git/commits")?.body.parents).toEqual([SHA]);
}

describe("CalVer version PRs, not main-merge releases", () => {
  it("creates one consistent version commit, a normal reviewable PR and explicit full CI", async () => {
    const h = harness(world({ pull: null, files: manifests("1.0.1") }));
    expect(await h.run()).toMatchObject({ status: "version-pr", number: 42, version: VERSION, headSha: UPDATED_SHA });
    expectVersionCommit(h, VERSION);
    expect(h.pull()).toMatchObject({ draft: false, head: { ref: BRANCH }, labels: [{ name: LABEL }] });
    const create = h.calls.find((c) => c.method === "POST" && c.path === "/pulls");
    expect(create?.body).toMatchObject({ base: "main", head: BRANCH });
    expect(h.dispatches("ci.yml")).toHaveLength(1);
    expect(h.dispatches("ci.yml")[0]).toMatchObject({ body: { ref: BRANCH }, branchSha: UPDATED_SHA });
    expect(h.effects).toEqual(["version-commit", "dispatch-ci"]);
    expect(h.calls.some((c) => c.path.endsWith("/merge") || c.path.endsWith("/reviews") && c.method !== "GET")).toBe(false);
    expectNoPublication(h);
  });

  it("refreshes the existing version PR rather than creating a competing PR", async () => {
    const openPull = { ...selectedPull(), state: "open", merged: false, merged_at: "" };
    const h = harness(world({ pull: null, openPull, files: manifests("1.0.1") }));
    expect(await h.run()).toMatchObject({ status: "version-pr", number: 42, headSha: UPDATED_SHA });
    expect(h.calls.some((c) => c.method === "POST" && c.path === "/pulls")).toBe(false);
    expectVersionCommit(h, VERSION);
    expect(h.dispatches("ci.yml")[0]).toMatchObject({ body: { ref: BRANCH }, branchSha: UPDATED_SHA });
    expectNoPublication(h);
  });

  it("does not treat ordinary-main CI success as release selection", async () => {
    const h = harness(world({ pull: null }), { GITHUB_EVENT_NAME: "workflow_run" }, {
      action: "completed", repository: repo(), workflow_run: {
        id: 8, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
        head_sha: SHA, head_repository: repo(), status: "completed", conclusion: "success",
      },
    });
    expect((await h.run()).status).not.toBe("published");
    expectNoPublication(h);
  });

  it("does not trust a package bump or a webhook's forged PR instead of GitHub selection", async () => {
    const h = harness(world({ pull: null }), {}, { ref: "refs/heads/main", after: SHA, repository: repo(), pull_request: selectedPull() });
    expect((await h.run()).status).not.toBe("published");
    expectNoPublication(h);
  });

  it.each([
    ["unmerged", (p: Pull) => ({ ...p, merged: false, merged_at: "" })],
    ["another merge SHA", (p: Pull) => ({ ...p, merge_commit_sha: OTHER_SHA })],
    ["missing selection label", (p: Pull) => ({ ...p, labels: [] })],
    ["human package edit", (p: Pull) => ({ ...p, user: { login: "contributor", type: "User" } })],
    ["unrelated head branch", (p: Pull) => ({ ...p, head: { ...p.head, ref: "fix/package-edit" } })],
    ["non-main target", (p: Pull) => ({ ...p, base: { ...p.base, ref: "release" } })],
    ["fork head", (p: Pull) => ({ ...p, head: { ...p.head, repo: { ...repo(), full_name: "outsider/kagi-shinobi" } } })],
  ] as const)("does not publish a PR with %s", async (_name, change) => {
    const h = harness(world({ pull: change(selectedPull()) }));
    expect((await h.run()).status).not.toBe("published");
    expectNoPublication(h);
  });

  it("refuses ambiguous release selection instead of picking the first PR", async () => {
    const h = harness(world({ associated: [selectedPull(), { ...selectedPull(), number: 43 }] }));
    await expect(h.run()).rejects.toThrow(/ambiguous|multiple|selection/i);
    expectNoPublication(h);
  });
});

describe("selected exact-SHA publication", () => {
  it("asks the shared direct-release stable planner and publishes its unchanged plan before dispatch", async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: "published", version: VERSION, tag: TAG, sha: SHA, releaseUrl: RELEASE_URL, deploymentDispatched: true });
    expect(h.planInputs[0]).toMatchObject({ policy: "direct-release", channel: "stable", sha: SHA });
    expect(h.planInputs[0].operation).toMatch(/\S/);
    expect(h.planInputs[0]).not.toHaveProperty("repairDate");
    expect(h.planInputs[0]).not.toHaveProperty("version");
    expect(h.published).toHaveLength(1);
    expect(h.published[0].plan).toEqual(h.planned[0]);
    expect(h.effects).toEqual(["publish", "dispatch-deploy"]);
    expect(h.dispatches("deploy.yml")).toHaveLength(1);
    expect(h.dispatches("deploy.yml")[0].body).toEqual({ ref: "main", inputs: { tag: TAG } });
    expect(h.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/dispatches"))).toEqual([]);
    for (const path of ["package.json", "package-lock.json"]) {
      const reads = h.calls.filter((c) => c.path === `/contents/${path}`);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((c) => c.query.get("ref") === SHA)).toBe(true);
    }
  });

  it("keeps publishing the selected merge SHA even when main has advanced", async () => {
    const h = harness(world({ mainSha: OTHER_SHA }));
    expect(await h.run()).toMatchObject({ status: "published", sha: SHA });
    expect(h.published[0].plan.sha).toBe(SHA);
    expect(h.planInputs.every((input) => input.sha === SHA)).toBe(true);
  });

  it.each(["root lock", "root package entry"])("refuses a selected PR with inconsistent %s version", async (part) => {
    const files = manifests();
    const lock = JSON.parse(files["package-lock.json"]);
    if (part === "root lock") lock.version = "2026.1030.1";
    else lock.packages[""].version = "2026.1030.1";
    files["package-lock.json"] = JSON.stringify(lock);
    const h = harness(world({ files }));
    await expect(h.run()).rejects.toThrow(/version|manifest|lock/i);
    expectNoPublication(h);
  });

  it("refuses source changes smuggled into a generated version PR", async () => {
    const h = harness(world({ changedFiles: ["package.json", "package-lock.json", "CHANGELOG.md", "src/index.ts"] }));
    await expect(h.run()).rejects.toThrow(/file|scope|selection/i);
    expectNoPublication(h);
  });

  it("refuses a selected version without matching release notes", async () => {
    const files = manifests();
    files["CHANGELOG.md"] = "# Changelog\n\n## 1.0.1\n\nOld release only.\n";
    const h = harness(world({ files }));
    await expect(h.run()).rejects.toThrow(/notes|changelog|version/i);
    expectNoPublication(h);
  });

  it.each(["refs/heads/feature", "refs/tags/v2026.1030.0", "refs/pull/42/merge"])("refuses invocation from %s before side effects", async (ref) => {
    const h = harness(world(), { GITHUB_REF: ref });
    await expect(h.run()).rejects.toThrow(/main|ref/i);
    expect(h.calls).toEqual([]);
    expectNoPublication(h);
  });
});

describe("date/slot revalidation refreshes, never substitutes a tag", () => {
  it.each([
    ["yesterday's committed version", "2026.1029.0", { version: VERSION, tag: TAG, date: "2026-10-30" }],
    ["an occupied slot", VERSION, { version: "2026.1030.1", tag: "v2026.1030.1", date: "2026-10-30" }],
  ] as const)("refreshes %s instead of publishing a different version on the selected SHA", async (_name, committed, answer) => {
    const pull = { ...selectedPull(), title: `chore: release ${committed}`, body: `Release ${committed}` };
    const h = harness(world({ pull, files: manifests(committed), plans: [answer] }));
    expect(await h.run()).toMatchObject({ status: "version-pr", version: answer.version, headSha: UPDATED_SHA });
    expectVersionCommit(h, answer.version);
    expect(h.dispatches("ci.yml")[0]).toMatchObject({ body: { ref: BRANCH }, branchSha: UPDATED_SHA });
    expectNoPublication(h);
  });

  it("rechecks UTC when midnight passes after planning, before any publication", async () => {
    const w = world({ plans: [{}, { version: "2026.1031.0", tag: "v2026.1031.0", date: "2026-10-31" }] });
    w.afterPlan = () => { w.time = "2026-10-31T00:00:01Z"; };
    const h = harness(w);
    expect(await h.run()).toMatchObject({ status: "version-pr", version: "2026.1031.0" });
    expectVersionCommit(h, "2026.1031.0");
    expectNoPublication(h);
  });

  it("uses the planner's numeric slot rather than locally incrementing the manifest", async () => {
    const h = harness(world({ pull: null, files: manifests("1.0.1"), plans: [{ version: "2026.1030.12", tag: "v2026.1030.12" }] }));
    expect(await h.run()).toMatchObject({ status: "version-pr", version: "2026.1030.12" });
    expectVersionCommit(h, "2026.1030.12");
    expectNoPublication(h);
  });

  it("propagates a collision discovered by shared publication, without retagging or deployment", async () => {
    const h = harness(world({ publishError: Object.assign(new Error("planned tag collision: never reallocate"), { status: 422 }) }));
    await expect(h.run()).rejects.toThrow(/collision/);
    expect(h.published).toHaveLength(1);
    expect(h.published[0].plan.version).toBe(VERSION);
    expect(h.dispatches("deploy.yml")).toEqual([]);
    expect(h.calls.filter((c) => ["PATCH", "DELETE"].includes(c.method) && c.path.includes("tags"))).toEqual([]);
  });
});

describe("failure and replay boundaries", () => {
  it.each([
    [`GET /commits/${SHA}/pulls`, 403],
    ["GET /pulls/42", 500],
    ["GET /pulls/42/files", 503],
    ["GET /contents/package.json", 500],
    ["GET /contents/package-lock.json", 404],
  ] as const)("fails closed on %s HTTP %i, without leaking provider response bodies", async (request, status) => {
    const h = harness(world({ status: { [request]: status } }));
    let error: unknown;
    try { await h.run(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`HTTP ${status}`));
    expect(`${(error as Error).message}\n${h.logs.join("\n")}`).not.toMatch(/provider-body-do-not-log|offline-token/);
    expectNoPublication(h);
  });

  it("propagates shared planning failure instead of treating unknown tags as an empty registry", async () => {
    const h = harness();
    h.deps.releaser.plan = async () => { throw Object.assign(new Error("tag lookup HTTP 503"), { status: 503 }); };
    await expect(h.run()).rejects.toThrow(/503/);
    expectNoPublication(h);
  });

  it("does not claim the version PR is ready if its explicit CI dispatch fails", async () => {
    const h = harness(world({ pull: null, files: manifests("1.0.1"), status: { "POST /actions/workflows/ci.yml/dispatches": 403 } }));
    await expect(h.run()).rejects.toThrow(/HTTP 403/);
    expectNoPublication(h);
  });

  it("never invokes deploy after a rejected publication", async () => {
    const h = harness(world({ publishError: new Error("release creation HTTP 502") }));
    await expect(h.run()).rejects.toThrow(/502/);
    expect(h.dispatches("deploy.yml")).toEqual([]);
  });

  it("does not confuse a dry-run or missing Release URL with a published stable Release", async () => {
    for (const publication of [{ dryRun: true }, { releaseUrl: "" }]) {
      const h = harness(world({ publication }));
      await expect(h.run()).rejects.toThrow(/publish|release|dry.run/i);
      expect(h.dispatches("deploy.yml")).toEqual([]);
    }
  });

  it("leaves a published Release intact but reports failed deploy dispatch as failure", async () => {
    const h = harness(world({ status: { "POST /actions/workflows/deploy.yml/dispatches": 503 } }));
    await expect(h.run()).rejects.toThrow(/HTTP 503/);
    expect(h.effects).toEqual(["publish"]);
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("uses stable operation identity across new run IDs and accepts only the shared exact replay", async () => {
    const h = harness();
    await h.run();
    const original = h.planned[0];
    const retry = harness(world({
      plans: [original], existingPlan: original, publication: { created: false },
    }), { GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "2" });
    expect(await retry.run()).toMatchObject({ status: "published", tag: TAG, sha: SHA });
    expect(retry.planInputs[0].operation).toBe(h.planInputs[0].operation);
    expect(retry.published[0].plan).toEqual(original);
    expect(retry.published[0].options?.repair).not.toBe(true);
    expect(retry.effects).toEqual(["publish", "dispatch-deploy"]);
  });

  it("an exact published replay is safe across midnight, not a fresh backdated release", async () => {
    const first = harness();
    await first.run();
    const original = first.planned[0];
    const retry = harness(world({
      time: "2026-10-31T00:01:00Z", plans: [original], existingPlan: original,
      publication: { created: false },
    }), { GITHUB_RUN_ID: "101" });
    expect(await retry.run()).toMatchObject({ status: "published", version: VERSION });
    expect(retry.published[0].plan).toEqual(original);
    expect(retry.calls.some((c) => c.method === "DELETE" || c.method === "PATCH" && c.path.includes("tags"))).toBe(false);
  });

  it.each(["other SHA", "other operation"])("does not turn shared 422 rejection for %s into successful replay", async (different) => {
    const first = harness();
    await first.run();
    const original = first.planned[0];
    const h = harness(world({
      existingPlan: different === "other operation" ? { ...original, operation: "unrelated-operation" } : original,
      existingTagSha: different === "other SHA" ? OTHER_SHA : SHA,
      publishError: Object.assign(new Error(`published tag collision: ${different}`), { status: 422 }),
    }));
    await expect(h.run()).rejects.toThrow(/collision|provenance|operation|SHA/i);
    expect(h.dispatches("deploy.yml")).toEqual([]);
    expect(h.calls.some((c) => c.method === "DELETE" || c.method === "PATCH" && c.path.includes("tags"))).toBe(false);
  });
});

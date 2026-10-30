// Kagi's version-PR boundary. The pinned shared engine owns all version/tag
// arithmetic and publication; this adapter never writes tags or Releases.
// Import-safe for offline tests. The CLI executes only trusted main code.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { evaluateCi } from "./deploy-gate.ts";

export type Env = Record<string, string | undefined>;
export interface PlanInput {
  channel: "stable";
  sha: string;
  operation: string;
  policy: "direct-release";
  namespace?: string;
  latest?: string;
}
export interface Plan extends PlanInput {
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
export interface Deps {
  event: unknown;
  fetch: typeof fetch;
  now: () => Date;
  log: (line: string) => void;
  releaser: {
    plan: (input: PlanInput) => Promise<Plan>;
    notes: (plan: Plan) => Promise<string>;
    publish: (plan: Plan, options?: Record<string, unknown>) => Promise<Publication>;
  };
}
export interface Result {
  status: "ignored" | "version-pr" | "published";
  number?: number;
  version?: string;
  tag?: string;
  sha?: string;
  headSha?: string;
  releaseUrl?: string;
  deploymentDispatched?: boolean;
}
interface Repository { full_name: string }
interface Pull {
  number: number;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  draft: boolean;
  user: { login: string; type: string };
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string; repo: Repository | null };
  base: { ref: string; repo: Repository | null };
}
interface Ref { object: { type: string; sha: string } }
interface Manifest { version: string; [key: string]: unknown }
interface Lock extends Manifest { packages: Record<string, Manifest> }
interface Files { pkg: Manifest; lock: Lock; notes: string }
interface CiRun {
  id: number;
  head_sha: string;
  head_repository: Repository;
  event: string;
  status: string;
  conclusion: string | null;
}

const REPOSITORY = "TogetherWeOwn/kagi-shinobi";
const BRANCH = "release/calver";
const LABEL = "calver:release";
const SHA = /^[0-9a-f]{40}$/;
const PATHS = ["package.json", "package-lock.json", "CHANGELOG.md"];
const TOOLING_SHA = "1508f2c10cb83bc0677e8e559ff796a55c66e737";

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "invalid object");
  return value as Record<string, unknown>;
}
function selected(pull: Pull, repository: string): boolean {
  return Number.isSafeInteger(pull.number) && pull.user?.login === "github-actions[bot]" &&
    pull.user.type === "Bot" && pull.labels?.some((l) => l.name === LABEL) &&
    pull.head?.ref === BRANCH && pull.head.repo?.full_name === repository &&
    pull.base?.ref === "main" && pull.base.repo?.full_name === repository;
}

// A single authenticated HTTP client, with bounded complete pagination. Never
// print a provider body: it may contain private data or a credential-bearing URL.
function github(token: string, fetchImpl: typeof fetch) {
  const root = `https://api.github.com/repos/${REPOSITORY}`;
  async function request<T>(method: string, path: string, body?: unknown, optional = false): Promise<T | null> {
    const response = await fetchImpl(`${root}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (optional && response.status === 404) return null;
    requireValue(response.ok, `GitHub ${method} ${path.split("?")[0]} HTTP ${response.status}`);
    if (response.status === 204) return null;
    return await response.json() as T;
  }
  async function get<T>(path: string): Promise<T> {
    const result = await request<T>("GET", path);
    requireValue(result !== null, "empty GitHub response");
    return result;
  }
  async function list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const values = await get<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      requireValue(Array.isArray(values), "invalid GitHub list");
      all.push(...values);
      if (values.length < 100) return all;
    }
    throw new Error("GitHub list exceeded complete pagination bound");
  }
  return { request, get, list };
}

type Api = ReturnType<typeof github>;
async function filesAt(api: Api, sha: string): Promise<Files> {
  const text = async (path: string): Promise<string> => {
    const file = await api.get<{ type: string; encoding: string; content: string }>(`/contents/${path}?ref=${sha}`);
    requireValue(file.type === "file" && file.encoding === "base64" && typeof file.content === "string", `unreadable ${path}`);
    requireValue(file.content.length < 12_000_000, `${path} exceeds size bound`);
    return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  };
  const pkg = object(JSON.parse(await text("package.json"))) as Manifest;
  const lock = object(JSON.parse(await text("package-lock.json"))) as Lock;
  requireValue(typeof pkg.version === "string" && typeof lock.version === "string", "missing manifest version");
  requireValue(lock.packages && lock.packages[""] && typeof lock.packages[""].version === "string", "missing root lock package version");
  requireValue(pkg.version === lock.version && pkg.version === lock.packages[""].version, "inconsistent manifest/lock versions");
  return { pkg, lock, notes: await text("CHANGELOG.md") };
}

async function requireCi(api: Api, sha: string): Promise<boolean> {
  const list = await api.get<{ total_count: number; workflow_runs: CiRun[] }>(`/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  requireValue(Array.isArray(list.workflow_runs) && Number.isSafeInteger(list.total_count) && list.total_count === list.workflow_runs.length, "incomplete exact-SHA CI evidence");
  const verdict = evaluateCi(list.workflow_runs, sha, REPOSITORY);
  if (verdict.state === "failed") throw new Error(verdict.detail);
  return verdict.state === "success";
}

async function exactPublishedReplay(api: Api, plan: Plan): Promise<boolean> {
  const release = await api.request<{ tag_name: string; draft: boolean; prerelease: boolean; body: string }>("GET", `/releases/tags/${plan.tag}`, undefined, true);
  if (!release) return false;
  requireValue(release.tag_name === plan.tag && release.draft === false && release.prerelease === false && release.body?.includes(`<!-- calver-plan:${plan.id} -->`), "release provenance mismatch");
  const ref = await api.get<Ref>(`/git/ref/tags/${plan.tag}`);
  requireValue(ref.object?.type === "tag" && SHA.test(ref.object.sha), "release lacks operation provenance");
  const tag = await api.get<Ref & { message: string }>(`/git/tags/${ref.object.sha}`);
  requireValue(tag.object?.type === "commit" && tag.object.sha === plan.sha && tag.message?.startsWith("calver-plan-v1\n"), "release SHA/provenance mismatch");
  const prior = object(JSON.parse(tag.message.slice("calver-plan-v1\n".length)));
  requireValue(prior.id === plan.id && prior.operation === plan.operation && prior.sha === plan.sha && prior.version === plan.version, "release operation provenance mismatch");
  // The shared publisher still independently verifies the complete annotation.
  return true;
}

async function versionPr(api: Api, deps: Deps, sha: string, plan: Plan, source: Files): Promise<Result> {
  const pulls = await api.list<Pull>("/pulls?state=open");
  requireValue(!pulls.some((p) => p.head?.ref.startsWith("release-please--")), "legacy release PR still owns manifests/CHANGELOG; resolve it before CalVer cutover");
  const candidates = pulls.filter((p) => selected(p, REPOSITORY));
  requireValue(candidates.length <= 1, "multiple open version PRs");
  const open = candidates[0];
  const branch = await api.request<Ref>("GET", `/git/ref/heads/${BRANCH}`, undefined, true);
  if (branch) {
    // A closed, merged version PR may leave its disposable generated ref behind.
    const owners = open ? [open] : await api.list<Pull>(`/pulls?state=closed&head=TogetherWeOwn:${BRANCH}`);
    requireValue(branch.object?.type === "commit" && owners.some((p) => selected(p, REPOSITORY) && p.head.sha === branch.object.sha), "version branch has an unknown owner or changed head");
  }
  const notes = await deps.releaser.notes(plan);
  const contents: Record<string, string> = {
    "package.json": `${JSON.stringify({ ...source.pkg, version: plan.version }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ ...source.lock, version: plan.version, packages: { ...source.lock.packages, "": { ...source.lock.packages[""], version: plan.version } } }, null, 2)}\n`,
    "CHANGELOG.md": `# Changelog\n\n## ${plan.version}\n\n${notes}\n${source.notes.replace(/^# Changelog\s*/, "")}`,
  };
  const commit = await api.get<{ tree: { sha: string } }>(`/git/commits/${sha}`);
  requireValue(SHA.test(commit.tree?.sha), "invalid main commit tree");
  const tree = await api.request<{ sha: string }>("POST", "/git/trees", { base_tree: commit.tree.sha, tree: PATHS.map((path) => ({ path, mode: "100644", type: "blob", content: contents[path] })) });
  requireValue(tree && SHA.test(tree.sha), "invalid version tree");
  const updated = await api.request<{ sha: string }>("POST", "/git/commits", { message: `chore: release ${plan.version}`, tree: tree.sha, parents: [sha] });
  requireValue(updated && SHA.test(updated.sha), "invalid version commit");
  // Only the generated branch is replaceable. Tags/default branch are never
  // moved. Old version commits remain reachable through their PR history.
  if (branch) {
    const current = await api.get<Ref>(`/git/ref/heads/${BRANCH}`);
    requireValue(current.object.sha === branch.object.sha, "version branch changed during refresh");
    await api.request("PATCH", `/git/refs/heads/${BRANCH}`, { sha: updated.sha, force: true });
  } else {
    await api.request("POST", "/git/refs", { ref: `refs/heads/${BRANCH}`, sha: updated.sha });
  }
  const body = {
    title: `chore: release ${plan.version}`,
    body: `## Release ${plan.version}\n\n${notes}\nThis generated version PR requires normal review and full CI. Merging selects this exact committed version; publication is not proof of production deployment.`,
  };
  const pull = open
    ? await api.request<Pull>("PATCH", `/pulls/${open.number}`, body)
    : await api.request<Pull>("POST", "/pulls", { ...body, base: "main", head: BRANCH, draft: false });
  requireValue(pull && Number.isSafeInteger(pull.number), "version PR creation failed");
  await api.request("POST", `/issues/${pull.number}/labels`, { labels: [LABEL] });
  const head = await api.get<Ref>(`/git/ref/heads/${BRANCH}`);
  requireValue(head.object.sha === updated.sha, "version branch changed before required-check dispatch");
  // GITHUB_TOKEN-created PRs start no workflows, so every required context has
  // to be dispatched explicitly on the updated head. A green full CI alone
  // would still leave the ruleset's title/gitleaks contexts unreported.
  await api.request("POST", "/actions/workflows/ci.yml/dispatches", { ref: BRANCH });
  await api.request("POST", "/actions/workflows/pr-lint.yml/dispatches", {
    ref: BRANCH, inputs: { pr_number: String(pull.number), head_sha: updated.sha },
  });
  await api.request("POST", "/actions/workflows/secret-scan.yml/dispatches", { ref: BRANCH });
  deps.log(`version PR #${pull.number}: ${plan.version}; full CI and required checks dispatched on ${updated.sha}`);
  return { status: "version-pr", number: pull.number, version: plan.version, headSha: updated.sha };
}

export async function runCalver(env: Env, deps: Deps): Promise<Result> {
  requireValue(env.GITHUB_REF === "refs/heads/main", "CalVer runs from main ref only");
  requireValue(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_TOKEN, "wrong repository or missing GitHub token");
  const event = object(deps.event);
  const repository = object(event.repository);
  requireValue(repository.full_name === REPOSITORY, "wrong event repository");
  let sha = env.GITHUB_SHA ?? "";
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    const run = object(event.workflow_run);
    if (run.event !== "push" || run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success" || run.path !== ".github/workflows/ci.yml" || object(run.head_repository).full_name !== REPOSITORY) return { status: "ignored" };
    sha = String(run.head_sha);
  } else {
    requireValue(env.GITHUB_EVENT_NAME === "push" || env.GITHUB_EVENT_NAME === "workflow_dispatch", "unsupported release event");
    if (env.GITHUB_EVENT_NAME === "push") requireValue(event.ref === "refs/heads/main" && event.after === sha, "main push SHA mismatch");
  }
  requireValue(SHA.test(sha), "invalid exact release SHA");
  const api = github(env.GITHUB_TOKEN, deps.fetch);
  const associated = await api.list<Pull>(`/commits/${sha}/pulls`);
  const eligible: Pull[] = [];
  for (const summary of associated) {
    requireValue(Number.isSafeInteger(summary.number), "invalid associated PR number");
    const pull = await api.get<Pull>(`/pulls/${summary.number}`);
    if (selected(pull, REPOSITORY) && pull.state === "closed" && pull.merged === true && pull.merged_at && !pull.draft && pull.merge_commit_sha === sha) eligible.push(pull);
  }
  requireValue(eligible.length <= 1, "ambiguous release selection: multiple merged version PRs");
  const pull = eligible[0];
  if (pull) {
    const changed = await api.list<{ filename: string; status: string; previous_filename?: string }>(`/pulls/${pull.number}/files`);
    requireValue(changed.length === PATHS.length && PATHS.every((path) => changed.some((f) => f.filename === path && f.status === "modified" && !f.previous_filename)), "version PR file scope is not exactly manifests and notes");
  }
  if (!await requireCi(api, sha)) {
    deps.log(`waiting for exact-SHA full CI on ${sha}; CI completion will resume the release writer`);
    return { status: "ignored" };
  }
  const source = await filesAt(api, sha);
  if (pull) requireValue(source.notes.includes(`## ${source.pkg.version}\n`), "selected version lacks matching CHANGELOG notes");
  const input: PlanInput = { channel: "stable", sha, policy: "direct-release", operation: `kagi/release/${sha}` };
  let plan = await deps.releaser.plan(input);
  const checkPlan = (p: Plan): void => {
    requireValue(p.schema === "calver-plan-v1" && p.repository === REPOSITORY && p.sha === sha && p.operation === input.operation && p.policy === "direct-release" && p.channel === "stable" && p.namespace === "" && p.tag === `v${p.version}` && /^\d{4}\.\d{3,4}\.\d+$/.test(p.version), "shared plan identity mismatch");
  };
  checkPlan(plan);
  if (plan.date !== deps.now().toISOString().slice(0, 10)) {
    // A past plan is valid only for an exact already-published retry. A fresh
    // version PR that crossed midnight must get a fresh date, not a backdate.
    const replay = pull && plan.version === source.pkg.version && await exactPublishedReplay(api, plan);
    if (!replay) {
      plan = await deps.releaser.plan(input);
      checkPlan(plan);
      requireValue(plan.date === deps.now().toISOString().slice(0, 10), "UTC date changed repeatedly; retry before stamping");
    }
  }
  if (!pull || source.pkg.version !== plan.version) {
    // Never refresh from an old main snapshot after newer merges: publishing
    // remains exact-SHA, but new version PRs must start from current main.
    const main = await api.get<Ref>("/git/ref/heads/main");
    requireValue(main.object?.type === "commit" && main.object.sha === sha, "main advanced before version PR refresh; use the current main CI run");
    return await versionPr(api, deps, sha, plan, source);
  }
  const publication = await deps.releaser.publish(plan);
  requireValue(publication.dryRun === false && publication.releaseUrl && publication.sha === sha && publication.tag === plan.tag && publication.version === source.pkg.version, "publisher did not confirm the exact stable Release");
  await api.request("POST", "/actions/workflows/deploy.yml/dispatches", { ref: "main", inputs: { tag: plan.tag } });
  deps.log(`published ${plan.tag} at ${sha}; guarded deployment dispatched, NOT verified deployed`);
  return { status: "published", version: plan.version, tag: plan.tag, sha, releaseUrl: publication.releaseUrl, deploymentDispatched: true };
}

async function main(): Promise<void> {
  try {
    // This separate checkout is pinned by the trusted main workflow. Never load
    // tooling from the commit whose release is being evaluated.
    const root = resolve(process.env.CALVER_TOOLING_ROOT ?? ".calver-tooling/actions/calver");
    const { execFileSync } = await import("node:child_process");
    requireValue(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === TOOLING_SHA, "shared tooling pin mismatch");
    const { Releaser } = await import(pathToFileURL(resolve(root, "calver.mjs")).href);
    const { GitHub } = await import(pathToFileURL(resolve(root, "github.mjs")).href);
    const releaser = new Releaser({ api: new GitHub({ token: process.env.GITHUB_TOKEN }), repository: REPOSITORY, now: () => new Date() });
    const result = await runCalver(process.env, {
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")),
      fetch, now: () => new Date(), log: (line) => process.stdout.write(`${line}\n`), releaser,
    });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${JSON.stringify(result)}\n\nPublication/dispatch is not production rollout evidence.\n`);
  } catch (error) {
    // Unexpected provider bodies are not printable. Known adapter/engine errors
    // carry no token; the fixed prefix keeps this out of Actions command syntax.
    process.stderr.write(`CalVer refused: ${error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 500) : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

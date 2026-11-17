// Kagi's version-PR boundary. The pinned shared engine owns all version/tag
// arithmetic and publication; this adapter never writes tags or Releases.
// Import-safe for offline tests. The CLI executes only trusted main code.
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { evaluateCi, type CiVerdict } from "./deploy-gate.ts";

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
  checkAdmission?: {
    state: "awaiting_pr_event" | "approval_required" | "admitted";
    headSha: string;
    runIds: number[];
  };
}
interface Repository { full_name: string }
interface Pull {
  number: number;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  draft: boolean;
  title?: string;
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
function proposalPull(pull: Pull, repository: string): boolean {
  return Number.isSafeInteger(pull.number) && pull.user?.login === "github-actions[bot]" &&
    pull.user.type === "Bot" && pull.head?.ref === BRANCH && pull.head.repo?.full_name === repository &&
    pull.base?.ref === "main" && pull.base.repo?.full_name === repository;
}
function selected(pull: Pull, repository: string): boolean {
  return proposalPull(pull, repository) && pull.labels?.some((l) => l.name === LABEL);
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
  // Native GraphQL is the only documented way to make a ref update conditional
  // on its expected prior OID. A REST PATCH has no such predicate: its force
  // flag silently discards whatever another writer pushed in between.
  // https://docs.github.com/en/graphql/reference/input-objects#refupdate
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    requireValue(response.ok, `GitHub GraphQL HTTP ${response.status}`);
    // GraphQL reports a refused mutation as HTTP 200 plus an errors array, so a
    // missing data payload is a refusal, never a silent success.
    const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
    requireValue(!Array.isArray(payload.errors) || payload.errors.length === 0, "GitHub GraphQL rejected the mutation");
    requireValue(payload.data !== null && typeof payload.data === "object", "empty GitHub GraphQL response");
    return payload.data;
  }
  return { request, get, list, graphql };
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

async function readCi(api: Api, sha: string): Promise<CiVerdict> {
  const list = await api.get<{ total_count: number; workflow_runs: CiRun[] }>(`/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  requireValue(Array.isArray(list.workflow_runs) && Number.isSafeInteger(list.total_count) && list.total_count === list.workflow_runs.length, "incomplete exact-SHA CI evidence");
  return evaluateCi(list.workflow_runs, sha, REPOSITORY);
}

function checkPlanIdentity(plan: Plan, sha: string): void {
  requireValue(plan.schema === "calver-plan-v1" && plan.repository === REPOSITORY && plan.sha === sha &&
    plan.operation === `kagi/release/${sha}` && plan.policy === "direct-release" && plan.channel === "stable" &&
    plan.namespace === "" && plan.latest === "auto" && plan.source === null && plan.sourceCanary === null &&
    plan.evidence === null && plan.repairDate === null && plan.tag === `v${plan.version}` &&
    /^\d{4}\.\d{3,4}\.\d+$/.test(plan.version), "shared plan identity/provenance mismatch");
}

// Verify the frozen contract's canonical integrity digest, not version arithmetic.
// Settlement uses direct tag/Release reads rather than N shared registry scans.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Settlement asks one question: is THIS exact operation already published at
// this SHA? A tag whose frozen record is coherent but names a different SHA is
// not evidence about this one — another release legitimately owns the slot, so
// the shared planner must allocate afresh rather than be told this SHA settled.
// A lightweight tag carries no provenance at all: at another SHA it is foreign
// inventory the shared allocator already counts, but at THIS SHA the occupied
// name is ambiguous (it cannot prove it is not this operation's own stripped
// marker), so it refuses. A tag whose own record is internally inconsistent,
// or that claims this SHA under a different operation, is unprovenanced and
// refuses. Lookup errors propagate; a slot is never assumed empty.
async function settledRelease(api: Api, sha: string, version: string): Promise<Result | undefined> {
  const name = `v${version}`;
  const path = encodeURIComponent(name);
  const ref = await api.request<Ref>("GET", `/git/ref/tags/${path}`, undefined, true);
  if (!ref) {
    // A Release without its annotated tag proves nothing about its source SHA.
    const orphan = await api.request("GET", `/releases/tags/${path}`, undefined, true);
    requireValue(!orphan, "release lacks operation provenance");
    return undefined;
  }
  if (ref.object?.type === "commit") {
    requireValue(SHA.test(ref.object.sha) && ref.object.sha !== sha,
      "lightweight tag at this SHA lacks operation provenance; explicit repair required");
    return undefined;
  }
  requireValue(ref.object?.type === "tag" && SHA.test(ref.object.sha), "release lacks operation provenance");
  const tag = await api.get<Ref & { message: string }>(`/git/tags/${ref.object.sha}`);
  requireValue(tag.message?.startsWith("calver-plan-v1\n") && tag.object?.type === "commit" && SHA.test(tag.object.sha), "release SHA/provenance mismatch");
  const { publicationEvidence, ...record } = object(JSON.parse(tag.message.slice("calver-plan-v1\n".length)));
  const { id, ...payload } = record;
  requireValue(id === createHash("sha256").update(canonical(payload)).digest("hex"), "release plan integrity mismatch");
  const plan = record as unknown as Plan;
  requireValue(plan.schema === "calver-plan-v1" && plan.repository === REPOSITORY && plan.version === version &&
    plan.tag === name && /^\d{4}\.\d{3,4}\.\d+$/.test(plan.version) &&
    (publicationEvidence === null || publicationEvidence === undefined), "release version binding/provenance mismatch");
  requireValue(tag.object.sha === plan.sha, "release target/annotation SHA mismatch");
  if (plan.sha !== sha) return undefined;
  requireValue(plan.operation === `kagi/release/${sha}` && plan.policy === "direct-release" && plan.channel === "stable" &&
    plan.namespace === "" && plan.latest === "auto" && plan.source === null && plan.sourceCanary === null &&
    plan.evidence === null && plan.repairDate === null, "release operation provenance mismatch");
  const release = await api.request<{ tag_name: string; draft: boolean; prerelease: boolean; body: string; html_url: string }>("GET", `/releases/tags/${path}`, undefined, true);
  requireValue(release, "tag exists without Release: explicit repair required");
  requireValue(release.tag_name === name && release.draft === false && release.prerelease === false &&
    release.body?.includes(`<!-- calver-plan:${plan.id} -->`) &&
    release.html_url === `https://github.com/${REPOSITORY}/releases/tag/${name}`, "release provenance mismatch");
  return { status: "published", version, tag: name, sha, releaseUrl: release.html_url, deploymentDispatched: false };
}

interface PrRun extends CiRun {
  repository: Repository;
  path: string;
  head_branch: string;
  pull_requests: Array<{ number: number; head: { sha: string; ref: string }; base: { ref: string } }>;
}

async function checkAdmission(api: Api, number: number, sha: string): Promise<NonNullable<Result["checkAdmission"]>> {
  const paths = ["ci.yml", "pr-lint.yml", "secret-scan.yml"].map((name) => `.github/workflows/${name}`);
  const runs = async (filter = ""): Promise<PrRun[]> => {
    const result = await api.get<{ total_count: number; workflow_runs: PrRun[] }>(`/actions/runs?event=pull_request&head_sha=${sha}&per_page=100${filter}`);
    requireValue(Array.isArray(result.workflow_runs) && Number.isSafeInteger(result.total_count) &&
      result.total_count === result.workflow_runs.length, "incomplete native PR admission evidence");
    return result.workflow_runs.filter((run) => Number.isSafeInteger(run.id) && run.id > 0 && run.event === "pull_request" &&
      run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
      run.head_sha === sha && run.head_branch === BRANCH && paths.includes(run.path) &&
      run.pull_requests?.some((pull) => pull.number === number && pull.head?.sha === sha && pull.head.ref === BRANCH && pull.base?.ref === "main"));
  };
  const latest = new Map<string, PrRun>();
  for (const run of await runs()) if (run.id > (latest.get(run.path)?.id ?? 0)) latest.set(run.path, run);
  // Membership in this documented filter, not a guessed raw status/conclusion
  // field, establishes pending native approval. The writer cannot self-approve.
  const pending = await runs("&status=action_required");
  const runIds = [...latest.values()].map((run) => run.id);
  const approval = pending.some((run) => latest.get(run.path)?.id === run.id);
  const admitted = latest.size === paths.length && [...latest.values()].every((run) =>
    ["queued", "in_progress", "completed"].includes(run.status));
  return { state: approval ? "approval_required" : admitted ? "admitted" : "awaiting_pr_event", headSha: sha, runIds };
}

const PROPOSAL_MARKER = "\n\ncalver-proposal-v1\n";
// Both halves are fetched before either is judged: the durable marker text is
// copyable, and PR metadata survives a contributor replacing the head. Only
// the commit's own marker plus its provider-linked author/committer accounts
// prove the generator owns this head. Returns the marker's frozen version.
async function generatedHeadVersion(api: Api, sha: string): Promise<string> {
  const commit = await api.request<{ sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }> }>(
    "GET", `/git/commits/${sha}`, undefined, true);
  const identity = await api.request<{ author: { login: string; type: string } | null; committer: { login: string; type: string } | null }>(
    "GET", `/commits/${sha}`, undefined, true);
  requireValue(commit, "selected head is not a known generated commit");
  const marker = commit.message?.split(PROPOSAL_MARKER);
  requireValue(marker?.length === 2, "version branch lacks generated proposal provenance");
  const proof = object(JSON.parse(marker[1]));
  requireValue(commit.sha === sha && proof.repository === REPOSITORY && typeof proof.baseSha === "string" && SHA.test(proof.baseSha) &&
    commit.parents?.length === 1 && commit.parents[0].sha === proof.baseSha && proof.treeSha === commit.tree?.sha && SHA.test(commit.tree.sha) &&
    typeof proof.version === "string" && marker[0] === `chore: release ${proof.version}`, "version branch generated provenance mismatch");
  requireValue(identity && identity.author?.login === "github-actions[bot]" && identity.author.type === "Bot" &&
    identity.committer?.login === "github-actions[bot]" && identity.committer.type === "Bot", "version branch has an unknown generated owner");
  return proof.version;
}

async function requireGeneratedProposal(api: Api, sha: string): Promise<void> {
  const version = await generatedHeadVersion(api, sha);
  const source = await filesAt(api, sha);
  requireValue(source.pkg.version === version && source.notes.includes(`## ${version}\n`), "generated proposal contents mismatch");
}

async function versionPr(api: Api, deps: Deps, sha: string, plan: Plan, source: Files): Promise<Result> {
  const pulls = await api.list<Pull>("/pulls?state=open");
  requireValue(!pulls.some((p) => p.head?.ref.startsWith("release-please--")), "legacy release PR still owns manifests/CHANGELOG; resolve it before CalVer cutover");
  // A missing label can be the result of a failed prior POST. It is never release
  // selection; only generated commit provenance permits repairing that proposal.
  const candidates = pulls.filter((p) => proposalPull(p, REPOSITORY));
  requireValue(candidates.length <= 1, "multiple open version PRs");
  let open = candidates[0];
  if (open) {
    open = await api.get<Pull>(`/pulls/${open.number}`);
    requireValue(proposalPull(open, REPOSITORY) && open.state === "open", "version PR owner changed");
  }
  const branch = await api.request<Ref>("GET", `/git/ref/heads/${BRANCH}`, undefined, true);
  if (branch) {
    // A closed, merged version PR may leave its disposable generated ref behind.
    requireValue(branch.object?.type === "commit" && SHA.test(branch.object.sha), "invalid version branch");
    if (open) requireValue(open.head.sha === branch.object.sha, "version branch changed head");
    // PR authorship and labels survive contributor pushes. Only the live commit
    // proves that this head belongs to the generator and can be replaced.
    await requireGeneratedProposal(api, branch.object.sha);
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
  const provenance = { repository: REPOSITORY, baseSha: sha, treeSha: tree.sha, version: plan.version };
  const updated = await api.request<{ sha: string }>("POST", "/git/commits", {
    message: `chore: release ${plan.version}${PROPOSAL_MARKER}${JSON.stringify(provenance)}`,
    tree: tree.sha, parents: [sha],
  });
  requireValue(updated && SHA.test(updated.sha), "invalid version commit");
  // Only the generated branch is replaceable. Tags/default branch are never
  // moved. Old version commits remain reachable through their PR history.
  if (branch) {
    // The replacement is based on current main, so it is deliberately not a
    // fast-forward — but it must still be conditional on the verified G. A
    // final GET then a force PATCH would silently discard a contributor push
    // that lands between the two; only the native expected-before OID is atomic.
    const repository = await api.get<{ node_id: string }>("");
    requireValue(typeof repository.node_id === "string" && /^[A-Za-z0-9_+/=-]{4,200}$/.test(repository.node_id), "invalid repository node id");
    await api.graphql<{ updateRefs: { clientMutationId: string | null } | null }>(
      "mutation GuardedReplacement($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
      { input: {
        repositoryId: repository.node_id,
        refUpdates: [{ name: `refs/heads/${BRANCH}`, beforeOid: branch.object.sha, afterOid: updated.sha, force: true }],
      } },
    );
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
  const labels = await api.request<Array<{ name: string }>>("POST", `/issues/${pull.number}/labels`, { labels: [LABEL] });
  requireValue(Array.isArray(labels) && labels.some((label) => label.name === LABEL), "version PR label marker was not applied");
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
  const admission = await checkAdmission(api, pull.number, updated.sha);
  deps.log(`version PR #${pull.number}: ${plan.version}; full CI dispatched on ${updated.sha}; native PR checks ${admission.state} (not a pass or merge authorization)`);
  return { status: "version-pr", number: pull.number, version: plan.version, headSha: updated.sha, checkAdmission: admission };
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
    if (!["push", "workflow_dispatch", "schedule"].includes(String(run.event)) || run.name !== "CI" ||
      run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success" ||
      run.path !== ".github/workflows/ci.yml" || object(run.head_repository).full_name !== REPOSITORY ||
      !SHA.test(String(run.head_sha))) return { status: "ignored" };
    sha = String(run.head_sha);
  } else {
    requireValue(env.GITHUB_EVENT_NAME === "push" || env.GITHUB_EVENT_NAME === "workflow_dispatch", "unsupported release event");
    if (env.GITHUB_EVENT_NAME === "push") requireValue(event.ref === "refs/heads/main" && event.after === sha, "main push SHA mismatch");
  }
  requireValue(SHA.test(sha), "invalid exact release SHA");
  const api = github(env.GITHUB_TOKEN, deps.fetch);
  // GitHub concurrency replaces pending entries. The closed PRs, not callback
  // delivery or process memory, are the durable release-selection backlog.
  const closed = await api.list<Pull>("/pulls?state=closed&base=main");
  // List summaries omit `merged`; releaseCommit independently checks the detail.
  const backlog = closed.filter((p) => selected(p, REPOSITORY) && p.state === "closed" && p.merged_at &&
    !p.draft && p.merge_commit_sha !== sha && SHA.test(p.merge_commit_sha ?? ""));
  backlog.sort((a, b) => a.merged_at!.localeCompare(b.merged_at!) || a.number - b.number);
  let reconciled: Result | undefined;
  for (const pull of backlog) {
    // Inexpensive direct exact settlement first: the annotated tag plus its
    // Release record answers "is this exact operation already published?" in a
    // few reads, before the heavier association/file/manifest verification a
    // live or unsettled selection still gets. Retained settled history must
    // leave most of the repository-token read allowance for current work.
    const titleVersion = /^chore: release (\d{4}\.\d{3,4}\.\d+)$/.exec(pull.title ?? "")?.[1];
    if (titleVersion && await settledRelease(api, pull.merge_commit_sha!, titleVersion)) {
      deps.log(`backlog selection #${pull.number} already published at ${pull.merge_commit_sha}; skipping reconciliation`);
      continue;
    }
    const result = await releaseCommit(api, deps, pull.merge_commit_sha!, pull.number);
    if (result.status === "published") reconciled = result;
  }
  // Always evaluate a selected current merge, even after recovering a release.
  // Only suppress an unrelated ordinary merge's proposal in that case.
  const current = await releaseCommit(api, deps, sha, undefined, reconciled === undefined);
  return current.status === "ignored" ? reconciled ?? current : current;
}

async function releaseCommit(api: Api, deps: Deps, sha: string, backlogNumber?: number, proposeUnselected = true): Promise<Result> {
  const associated = await api.list<Pull>(`/commits/${sha}/pulls`);
  const eligible: Pull[] = [];
  for (const summary of associated) {
    requireValue(Number.isSafeInteger(summary.number), "invalid associated PR number");
    const pull = await api.get<Pull>(`/pulls/${summary.number}`);
    if (selected(pull, REPOSITORY) && pull.state === "closed" && pull.merged === true && pull.merged_at && !pull.draft && pull.merge_commit_sha === sha) eligible.push(pull);
  }
  requireValue(eligible.length <= 1, "ambiguous release selection: multiple merged version PRs");
  const pull = eligible[0];
  if (backlogNumber !== undefined && pull?.number !== backlogNumber) return { status: "ignored" };
  if (!pull && !proposeUnselected) return { status: "ignored" };
  if (pull) {
    const changed = await api.list<{ filename: string; status: string; previous_filename?: string }>(`/pulls/${pull.number}/files`);
    requireValue(changed.length === PATHS.length && PATHS.every((path) => changed.some((f) => f.filename === path && f.status === "modified" && !f.previous_filename)), "version PR file scope is not exactly manifests and notes");
  }
  const source = await filesAt(api, sha);
  if (pull) {
    requireValue(source.notes.includes(`## ${source.pkg.version}\n`), "selected version lacks matching CHANGELOG notes");
    const settled = await settledRelease(api, sha, source.pkg.version);
    if (settled) {
      deps.log(`selected release #${pull.number} already published at ${sha}; no publication or deploy replay`);
      return backlogNumber === undefined ? settled : { status: "ignored" };
    }
    // Bot PR metadata (author, labels, merged file scope) survives a
    // contributor replacing the proposal head, so it cannot attest that head.
    // Only the durable commit marker plus provider-linked identities prove the
    // merged selection was generated. A squash merge SHA normally differs from
    // that head — bind the version, never head === merge_commit_sha.
    requireValue(SHA.test(pull.head.sha), "selected version PR head is not an exact generated commit");
    const headVersion = await generatedHeadVersion(api, pull.head.sha);
    requireValue(headVersion === source.pkg.version, "selected version PR generated head does not bind the merged version");
  }
  const ci = await readCi(api, sha);
  if (ci.state === "failed") {
    // A failed historical selection stays unauthorized, but cannot poison every
    // later callback. Provider errors and incomplete evidence still throw above.
    if (backlogNumber === undefined) throw new Error(ci.detail);
    deps.log(`skipping selected release #${backlogNumber}: ${ci.detail}`);
    return { status: "ignored" };
  }
  if (ci.state === "pending") {
    deps.log(`waiting for exact-SHA full CI on ${sha}; CI completion will resume the release writer`);
    return { status: "ignored" };
  }
  const input: PlanInput = { channel: "stable", sha, policy: "direct-release", operation: `kagi/release/${sha}` };
  let plan = await deps.releaser.plan(input);
  checkPlanIdentity(plan, sha);
  if (plan.date !== deps.now().toISOString().slice(0, 10)) {
    // Published retries were settled above. A fresh proposal crossing midnight
    // must get a fresh shared plan, never a backdated publication.
    plan = await deps.releaser.plan(input);
    checkPlanIdentity(plan, sha);
    requireValue(plan.date === deps.now().toISOString().slice(0, 10), "UTC date changed repeatedly; retry before stamping");
  }
  if (!pull || source.pkg.version !== plan.version) {
    // A stale historical selection cannot seed a proposal. The current main
    // invocation below owns refresh, and still requires its own exact-SHA CI.
    if (backlogNumber !== undefined) return { status: "ignored" };
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

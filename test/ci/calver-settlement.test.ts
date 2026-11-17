// Caller settlement tests use the actual immutable shared planner, publisher and
// HTTP transport (see shared-calver.ts), not a fake allocator replay shortcut.
// Every provider request below is offline. Fixture seeding is excluded from read
// counts; no elapsed-time assertion or real GitHub mutation is involved.
import { afterAll, describe, expect, it } from "vitest";
import { runCalver } from "../../ci/calver";
import { disposePinnedCalver, pinnedCalver, proposalCommitFixture, type SharedPlan, type SharedPublication, type SharedReleaser } from "./shared-calver";

afterAll(disposePinnedCalver);
const REPO = "TogetherWeOwn/kagi-shinobi";
const NOW = "2026-10-30T12:00:00Z";
const TREE = "e".repeat(40);
type Json = Record<string, unknown>;
interface Call { method: string; path: string; query: URLSearchParams; body: Json; at: string }
interface Selection {
  sha: string;
  number: number;
  version: string;
  tag: string;
  plan?: SharedPlan;
}

function files(version: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "kagi-shinobi", version, private: true }),
    "package-lock.json": JSON.stringify({ name: "kagi-shinobi", version, lockfileVersion: 3, packages: { "": { name: "kagi-shinobi", version } } }),
    "CHANGELOG.md": `# Changelog\n\n## ${version}\n\nOffline shared publication fixture.\n`,
  };
}

class Repository {
  selections: Selection[] = [];
  listed: Selection[] | undefined;
  contents = new Map<string, Record<string, string>>();
  refs = new Map<string, { ref: string; object: { type: string; sha: string } }>();
  objects = new Map<string, Json>();
  releases = new Map<string, Json>();
  conclusions = new Map<string, string>();
  newerHistoricalConclusions = new Map<string, string>();
  forced = new Map<string, number>();
  calls: Call[] = [];
  publications: SharedPublication[] = [];
  planned: SharedPlan[] = [];
  planCalls = 0;
  publishCalls = 0;
  getLimit = Number.POSITIVE_INFINITY;
  currentSha = "0".repeat(39) + "1";
  time = NOW;
  onRead?: (call: Call) => Promise<void>;
  afterTagObject?: () => void;
  proposal: { headSha: string; pull: Json; files: Record<string, string> } | undefined;
  private proposalFiles: Record<string, string> = {};
  private nextObject = 50_000;
  readonly actual: SharedReleaser;
  readonly releaser: SharedReleaser;

  constructor() {
    const { Releaser, GitHub } = pinnedCalver();
    const api = new GitHub({ token: "offline-shared-fixture", fetchImpl: this.fetch });
    this.actual = new Releaser({ api, repository: REPO, now: () => new Date(this.time) });
    this.releaser = {
      plan: async (input) => {
        this.planCalls++;
        const plan = await this.actual.plan(input);
        this.planned.push(plan);
        return plan;
      },
      notes: (plan) => this.actual.notes(plan),
      publish: async (plan, options) => {
        this.publishCalls++;
        const result = await this.actual.publish(plan, options);
        this.publications.push(result);
        return result;
      },
      validatePlan: (plan) => this.actual.validatePlan(plan),
      provenance: (ref) => this.actual.provenance(ref),
      ref: (tag) => this.actual.ref(tag),
      tags: () => this.actual.tags(),
    };
  }

  private pull(selection: Selection, summary = false): Json {
    const index = this.selections.indexOf(selection);
    const detail: Json = {
      number: selection.number, state: "closed", merged: true,
      merged_at: new Date(Date.parse("2026-10-30T06:00:00Z") + index * 1_000).toISOString(),
      merge_commit_sha: selection.sha, draft: false,
      user: { login: "github-actions[bot]", type: "Bot" }, labels: [{ name: "calver:release" }],
      head: { ref: "release/calver", sha: (80_000 + index).toString(16).padStart(40, "0"), repo: { full_name: REPO } },
      base: { ref: "main", sha: index ? this.selections[index - 1].sha : "c".repeat(40), repo: { full_name: REPO } },
      title: `chore: release ${selection.version}`, body: `Release ${selection.version}`,
    };
    if (summary) delete detail.merged;
    return detail;
  }

  add(): Selection {
    const index = this.selections.length;
    const selection = { sha: (index + 1).toString(16).padStart(40, "0"), number: index + 100, version: "1.0.1", tag: "v1.0.1" };
    this.selections.push(selection);
    this.currentSha = selection.sha;
    this.contents.set(selection.sha, files(selection.version));
    this.conclusions.set(selection.sha, "success");
    return selection;
  }

  async plan(selection: Selection, operation = `kagi/release/${selection.sha}`): Promise<SharedPlan> {
    const plan = await this.actual.plan({ channel: "stable", policy: "direct-release", sha: selection.sha, operation });
    selection.plan = plan;
    selection.version = plan.version;
    selection.tag = plan.tag;
    this.contents.set(selection.sha, files(plan.version));
    return plan;
  }

  async seed(count: number, filler = 0, alternateOperation = false): Promise<void> {
    for (let index = 0; index < count; index++) {
      const selection = this.add();
      const plan = await this.plan(selection, alternateOperation ? `other-operation/${selection.sha}` : undefined);
      await this.actual.publish(plan);
    }
    for (let index = 0; index < filler; index++) {
      const name = `unrelated-history-${index}`;
      this.refs.set(name, { ref: `refs/tags/${name}`, object: { type: "commit", sha: this.selections[0].sha } });
    }
  }

  resetCounts(): void {
    this.calls = [];
    this.publications = [];
    this.planned = [];
    this.planCalls = 0;
    this.publishCalls = 0;
  }

  get gets(): number { return this.calls.filter((call) => call.method === "GET").length; }
  get writes(): Call[] { return this.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/dispatches")); }
  get deploys(): Call[] { return this.calls.filter((call) => call.path === "/actions/workflows/deploy.yml/dispatches"); }
  ciReads(sha: string): Call[] { return this.calls.filter((call) => call.path === "/actions/workflows/ci.yml/runs" && call.query.get("head_sha") === sha); }

  async invoke(sha = this.currentSha) {
    return runCalver({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "offline-shared-fixture", GITHUB_REF: "refs/heads/main", GITHUB_SHA: this.currentSha, GITHUB_EVENT_NAME: "workflow_run" }, {
      event: { action: "completed", repository: { full_name: REPO }, workflow_run: {
        id: 10_000 + this.selections.findIndex((entry) => entry.sha === sha), name: "CI", path: ".github/workflows/ci.yml",
        event: "push", head_sha: sha, head_branch: "main", head_repository: { full_name: REPO }, status: "completed", conclusion: "success",
      } }, fetch: this.fetch, now: () => new Date(this.time), log: () => {}, releaser: this.releaser,
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/repos/${REPO}`)) throw new Error("unexpected offline provider origin/repository");
    const path = decodeURIComponent(url.pathname.slice(`/repos/${REPO}`.length));
    const body = request.body ? await request.json() as Json : {};
    const call = { method: request.method, path, query: url.searchParams, body, at: this.time };
    this.calls.push(call);
    if (request.method === "GET") await this.onRead?.(call);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const paginate = (values: unknown[]) => {
      const size = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const last = Math.max(1, Math.ceil(values.length / size));
      const response = json(values.slice((page - 1) * size, page * size));
      const links: string[] = [];
      for (const [relation, target] of [["next", page < last ? page + 1 : 0], ["last", page < last ? last : 0], ["prev", page > 1 ? page - 1 : 0], ["first", page > 1 ? 1 : 0]] as const) {
        if (!target) continue;
        const next = new URL(url);
        next.searchParams.set("page", String(target));
        links.push(`<${next}>; rel="${relation}"`);
      }
      if (links.length) response.headers.set("link", links.join(", "));
      return response;
    };
    const forced = this.forced.get(`${request.method} ${path}`);
    if (forced) return json({ message: "provider-detail-not-for-logs" }, forced);
    let match: RegExpMatchArray | null;
    if (request.method === "GET") {
      if (Number.isFinite(this.getLimit) && this.gets > this.getLimit) return json({ message: "API rate limit exceeded for offline repository token" }, 403);
      if (path === "/tags") return paginate(Array.from(this.refs, ([name, ref]) => {
        let target = ref.object;
        if (target.type === "tag") target = this.objects.get(target.sha)!.object as typeof target;
        return { name, commit: { sha: target.sha } };
      }));
      if ((match = path.match(/^\/git\/ref\/tags\/(.+)$/))) return this.refs.has(match[1]) ? json(this.refs.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/git\/tags\/([0-9a-f]{40})$/))) return this.objects.has(match[1]) ? json(this.objects.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/releases\/tags\/(.+)$/))) return this.releases.has(match[1]) ? json(this.releases.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/(git\/)?commits\/([0-9a-f]{40})$/))) {
        const index = this.selections.findIndex((_entry, number) => (80_000 + number).toString(16).padStart(40, "0") === match![2]);
        if (index >= 0) {
          const selection = this.selections[index];
          const date = new Date(Date.parse("2026-10-30T06:00:00Z") + index * 1_000 - 500).toISOString();
          const commit = proposalCommitFixture(match[2], index ? this.selections[index - 1].sha : "c".repeat(40), TREE, selection.version, date);
          return match[1] ? json(commit) : json({ sha: commit.sha, commit, author: { login: "github-actions[bot]", type: "Bot" }, committer: { login: "github-actions[bot]", type: "Bot" } });
        }
        return this.contents.has(match[2]) || match[2] === "c".repeat(40) ? json({ sha: match[2], tree: { sha: TREE } }) : json({}, 404);
      }
      if ((match = path.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
        const resolve = (value: string) => {
          if (value === "main") return this.currentSha;
          const ref = this.refs.get(value);
          if (!ref) return value;
          return ref.object.type === "tag" ? (this.objects.get(ref.object.sha)!.object as { sha: string }).sha : ref.object.sha;
        };
        const from = resolve(match[1]); const to = resolve(match[2]);
        const fromIndex = this.selections.findIndex((entry) => entry.sha === from);
        const toIndex = this.selections.findIndex((entry) => entry.sha === to);
        if (fromIndex < 0 || toIndex < 0) return json({}, 404);
        return json({ status: from === to ? "identical" : fromIndex < toIndex ? "ahead" : "behind", total_commits: 1,
          commits: [{ sha: to, commit: { message: "chore: record an offline selected release" } }] });
      }
      if (path === "/commits") {
        const sha = url.searchParams.get("sha");
        return json([{ sha, commit: { message: "chore: record an offline selected release" } }]);
      }
      if (path === "/pulls") {
        if (url.searchParams.get("state") === "open") return paginate(this.proposal ? [this.proposal.pull] : []);
        const selections = [...(this.listed ?? this.selections)];
        if (url.searchParams.get("direction") !== "asc") selections.reverse();
        return paginate(selections.map((entry) => this.pull(entry, true)));
      }
      if ((match = path.match(/^\/commits\/([0-9a-f]{40})\/pulls$/))) return paginate(this.selections.filter((entry) => entry.sha === match![1]).map((entry) => this.pull(entry, true)));
      if ((match = path.match(/^\/pulls\/(\d+)(?:\/(files))?$/))) {
        const selection = this.selections.find((entry) => entry.number === Number(match![1]));
        const pull = selection ? this.pull(selection) : this.proposal?.pull.number === Number(match[1]) ? this.proposal.pull : undefined;
        if (!pull) return json({}, 404);
        return match[2] ? json(["package.json", "package-lock.json", "CHANGELOG.md"].map((filename) => ({ filename, status: "modified" }))) : json(pull);
      }
      if (path.startsWith("/contents/")) {
        const ref = url.searchParams.get("ref") ?? this.currentSha;
        const head = this.selections.find((_entry, index) => (80_000 + index).toString(16).padStart(40, "0") === ref);
        const source = this.proposal && ["release/calver", this.proposal.headSha].includes(ref) ? this.proposal.files : this.contents.get(head?.sha ?? ref);
        const content = source?.[path.slice("/contents/".length)];
        return content === undefined ? json({}, 404) : json({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
      }
      if (path === "/actions/workflows/ci.yml/runs") {
        const sha = url.searchParams.get("head_sha") ?? this.currentSha;
        const index = this.selections.findIndex((entry) => entry.sha === sha);
        const original = { id: 10_000 + index, name: "CI", event: "push", status: "completed", conclusion: this.conclusions.get(sha),
          head_sha: sha, head_branch: "main", path: ".github/workflows/ci.yml", head_repository: { full_name: REPO }, repository: { full_name: REPO } };
        const later = this.newerHistoricalConclusions.get(sha);
        const runs = later ? [{ ...original, id: 20_000 + index, conclusion: later }, original] : [original];
        return json({ total_count: runs.length, workflow_runs: runs });
      }
      if (path === "/actions/runs") return json({ total_count: 0, workflow_runs: [] });
      if (path === "/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { type: "commit", sha: this.currentSha } });
      if (path === "/git/ref/heads/release/calver") return this.proposal
        ? json({ ref: "refs/heads/release/calver", object: { type: "commit", sha: this.proposal.headSha } }) : json({}, 404);
    }
    if (request.method === "POST" && path === "/git/trees") {
      this.proposalFiles = { ...this.contents.get(this.currentSha) };
      for (const entry of body.tree as Array<{ path: string; content: string }>) this.proposalFiles[entry.path] = entry.content;
      return json({ sha: TREE }, 201);
    }
    if (request.method === "POST" && path === "/git/commits") return json({ sha: "d".repeat(40), tree: { sha: body.tree }, parents: body.parents }, 201);
    if (request.method === "POST" && path === "/git/refs" && body.ref === "refs/heads/release/calver") {
      this.proposal = { headSha: String(body.sha), pull: {}, files: this.proposalFiles };
      return json({ ref: body.ref, object: { type: "commit", sha: body.sha } }, 201);
    }
    if (request.method === "POST" && path === "/pulls") {
      if (!this.proposal) throw new Error("proposal PR created before its version commit");
      this.proposal.pull = {
        number: 200, state: "open", merged: false, merged_at: null, draft: body.draft === true,
        title: body.title, body: body.body, labels: [], user: { login: "github-actions[bot]", type: "Bot" },
        head: { ref: body.head, sha: this.proposal.headSha, repo: { full_name: REPO } },
        base: { ref: body.base, sha: this.currentSha, repo: { full_name: REPO } },
      };
      return json(this.proposal.pull, 201);
    }
    if (request.method === "POST" && path === "/issues/200/labels" && this.proposal) {
      const labels = (body.labels as string[]).map((name) => ({ name }));
      this.proposal.pull.labels = labels;
      return json(labels);
    }
    if (request.method === "POST" && /^\/actions\/workflows\/(ci|pr-lint|secret-scan)\.yml\/dispatches$/.test(path)) return new Response(null, { status: 204 });
    if (request.method === "POST" && path === "/git/tags") {
      const sha = (this.nextObject++).toString(16).padStart(40, "0");
      const tag = { sha, tag: body.tag, message: body.message, object: { type: body.type, sha: body.object } };
      this.objects.set(sha, tag);
      this.afterTagObject?.();
      return json(tag, 201);
    }
    if (request.method === "POST" && path === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/tags\//, "");
      if (!String(body.ref).startsWith("refs/tags/") || this.refs.has(name)) return json({}, 422);
      const ref = { ref: String(body.ref), object: { type: "tag", sha: String(body.sha) } };
      this.refs.set(name, ref);
      return json(ref, 201);
    }
    if (request.method === "POST" && path === "/releases") {
      const tag = String(body.tag_name);
      if (this.releases.has(tag)) return json({}, 422);
      const release = { ...body, id: this.releases.size + 1, html_url: `https://github.com/${REPO}/releases/tag/${tag}` };
      this.releases.set(tag, release);
      return json(release, 201);
    }
    if (request.method === "POST" && path === "/actions/workflows/deploy.yml/dispatches") {
      const tag = (body.inputs as Json).tag as string;
      if (!this.releases.has(tag)) throw new Error("deploy dispatched before an actual stable Release existed");
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected offline request: ${request.method} ${path}${url.search}`);
  };
}

function publicationMutations(repo: Repository): Call[] {
  return repo.writes.filter((call) => call.path === "/git/tags" || call.path === "/releases" || String(call.body.ref ?? "").startsWith("refs/tags/"));
}

// The counterexample is a coherent publication of A, not a tag whose target
// disagrees with its frozen annotation. It must leave B free to ask the actual
// shared planner for a reviewed refresh instead of accepting A as B's replay.
async function occupiedSelection() {
  const repo = new Repository();
  await repo.seed(1);
  const published = repo.selections[0];
  const selected = repo.add();
  selected.version = "2026.1030.0";
  selected.tag = "v2026.1030.0";
  repo.contents.set(selected.sha, files(selected.version));
  const ref = await repo.actual.ref(published.tag);
  if (!ref || !published.plan) throw new Error("real-engine publication fixture is absent");
  repo.actual.validatePlan(published.plan);
  expect(repo.actual.provenance(ref)).toMatchObject({ sha: published.sha, id: published.plan.id, version: "2026.1030.0" });
  expect(ref.sha).toBe(published.sha);
  expect(repo.releases.get(published.tag)).toMatchObject({ draft: false, prerelease: false });
  expect(String(repo.releases.get(published.tag)!.body)).toContain(`<!-- calver-plan:${published.plan.id} -->`);
  return { repo, published, selected };
}

// These cases were authored from the release requirements before applying the
// unpublished caller patch. Both the baseline and that exact opaque candidate
// must be reported: settlement's collision refusal can be new in the candidate.
describe("occupied-slot progress and pinned UTC publication boundary", () => {
  it("refreshes selected B when coherent published A legitimately occupies B's committed slot", async () => {
    const { repo, published, selected } = await occupiedSelection();
    repo.listed = [];
    repo.resetCounts();
    let result: Awaited<ReturnType<Repository["invoke"]>> | undefined;
    let refusal: unknown;
    try { result = await repo.invoke(selected.sha); } catch (error) { refusal = error; }
    expect.soft(refusal, `A's coherent different-SHA publication must reach allocation/refresh; plannerCalls=${repo.planCalls}`).toBeUndefined();
    expect.soft(repo.planned.map((plan) => ({ sha: plan.sha, version: plan.version }))).toContainEqual({ sha: selected.sha, version: "2026.1030.1" });
    expect.soft(result).toMatchObject({ status: "version-pr", version: "2026.1030.1", number: 200, headSha: "d".repeat(40) });
    expect.soft(repo.proposal?.pull).toMatchObject({ state: "open", draft: false, labels: [{ name: "calver:release" }], head: { ref: "release/calver" }, base: { ref: "main" } });
    expect.soft(JSON.parse(repo.proposal?.files["package.json"] ?? "{}").version).toBe("2026.1030.1");
    const lock = JSON.parse(repo.proposal?.files["package-lock.json"] ?? "{}");
    expect.soft(lock.version).toBe("2026.1030.1");
    expect.soft(lock.packages?.[""].version).toBe("2026.1030.1");
    for (const workflow of ["ci.yml", "pr-lint.yml", "secret-scan.yml"]) {
      expect.soft(repo.calls.filter((call) => call.method === "POST" && call.path === `/actions/workflows/${workflow}/dispatches`)).toHaveLength(1);
    }
    expect(publicationMutations(repo)).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.releases.size).toBe(1);
    expect((await repo.actual.ref(published.tag))?.sha).toBe(published.sha);
  });

  it("does not let a legitimate occupied-slot backlog B poison a later selected current C", async () => {
    const { repo, selected: collision } = await occupiedSelection();
    const current = repo.add();
    await repo.plan(current);
    expect(current.version).toBe("2026.1030.1");
    repo.listed = [collision];
    repo.resetCounts();
    let refusal: unknown;
    try { await repo.invoke(current.sha); } catch (error) { refusal = error; }
    expect.soft(refusal, "an older collision must neither settle B nor abort the surviving C callback").toBeUndefined();
    expect.soft(repo.publications.filter((entry) => entry.created).map((entry) => ({ sha: entry.sha, tag: entry.tag }))).toEqual([
      { sha: current.sha, tag: "v2026.1030.1" },
    ]);
    expect.soft(repo.deploys.map((call) => call.body)).toEqual([{ ref: "main", inputs: { tag: "v2026.1030.1" } }]);
    expect(repo.publications.some((entry) => entry.sha === collision.sha)).toBe(false);
    expect(repo.calls.some((call) => call.path === `/pulls/${collision.number}`)).toBe(true);
    expect(repo.calls.some((call) => call.path === `/pulls/${current.number}`)).toBe(true);
  });

  // The immutable shared contract freezes the date inside publish(), including
  // awaited preparation across midnight. Stale selections must refresh before
  // that boundary; the caller cannot add an ignored first-write admission hook.
  it("honors the frozen plan date when awaited publisher preparation crosses midnight before its first mutation", async () => {
    const repo = new Repository();
    repo.time = "2026-10-30T23:59:58Z";
    const current = repo.add();
    await repo.plan(current);
    repo.listed = [];
    repo.resetCounts();
    let crossedAt: Call | undefined;
    repo.onRead = async (call) => {
      if (repo.publishCalls && call.path === "/tags" && !crossedAt && publicationMutations(repo).length === 0) {
        crossedAt = call;
        // Advance while the real publisher is suspended on a provider read,
        // not in plan(), the caller date check or a made-up publish option.
        await Promise.resolve();
        repo.time = "2026-10-31T00:00:01Z";
      }
    };
    expect(await repo.invoke()).toMatchObject({ status: "published", sha: current.sha, version: "2026.1030.0", tag: "v2026.1030.0", deploymentDispatched: true });
    expect(crossedAt, "exercise the awaited real publisher preparation, not a missing endpoint").toMatchObject({ method: "GET", path: "/tags", at: "2026-10-30T23:59:58Z" });
    expect(repo.planned).toHaveLength(1);
    expect(repo.planned[0]).toMatchObject({ sha: current.sha, date: "2026-10-30", version: "2026.1030.0", tag: "v2026.1030.0" });
    expect(repo.publications).toHaveLength(1);
    expect(repo.publications[0]).toMatchObject({ created: true, sha: current.sha, date: "2026-10-30", version: "2026.1030.0", tag: "v2026.1030.0" });
    expect(publicationMutations(repo)[0]).toMatchObject({ method: "POST", path: "/git/tags", at: "2026-10-31T00:00:01Z", body: { tag: "v2026.1030.0", object: current.sha } });
    expect([...repo.refs.keys()]).toEqual(["v2026.1030.0"]);
    expect([...repo.releases.keys()]).toEqual(["v2026.1030.0"]);
    expect(repo.releases.get("v2026.1030.0")).toMatchObject({ tag_name: "v2026.1030.0", target_commitish: current.sha, draft: false, prerelease: false });
    const ref = await repo.actual.ref("v2026.1030.0");
    expect(ref?.sha).toBe(current.sha);
    expect(repo.actual.provenance(ref!)).toMatchObject({ id: repo.planned[0].id, sha: current.sha, date: "2026-10-30", version: "2026.1030.0" });
    expect(repo.proposal).toBeUndefined();
    expect(repo.deploys.map((call) => call.body)).toEqual([{ ref: "main", inputs: { tag: "v2026.1030.0" } }]);
  });

  it("refreshes a stale committed date before publication using a fresh next-day shared plan", async () => {
    const repo = new Repository();
    repo.time = "2026-10-30T23:59:58Z";
    const current = repo.add();
    await repo.plan(current);
    expect(current.version).toBe("2026.1030.0");
    repo.listed = [];
    repo.time = "2026-10-31T00:00:01Z";
    repo.resetCounts();
    expect(await repo.invoke()).toMatchObject({ status: "version-pr", version: "2026.1031.0", number: 200, headSha: "d".repeat(40) });
    expect(repo.planned).toHaveLength(1);
    expect(repo.planned[0]).toMatchObject({ sha: current.sha, date: "2026-10-31", version: "2026.1031.0", tag: "v2026.1031.0" });
    expect(repo.proposal?.pull).toMatchObject({ state: "open", draft: false, labels: [{ name: "calver:release" }], head: { ref: "release/calver" }, base: { ref: "main" } });
    expect(JSON.parse(repo.proposal?.files["package.json"] ?? "{}").version).toBe("2026.1031.0");
    const lock = JSON.parse(repo.proposal?.files["package-lock.json"] ?? "{}");
    expect(lock.version).toBe("2026.1031.0");
    expect(lock.packages?.[""].version).toBe("2026.1031.0");
    expect(repo.proposal?.files["CHANGELOG.md"]).toContain("## 2026.1031.0");
    for (const workflow of ["ci.yml", "pr-lint.yml", "secret-scan.yml"]) {
      expect(repo.calls.filter((call) => call.method === "POST" && call.path === `/actions/workflows/${workflow}/dispatches`).map((call) => call.body.ref)).toEqual(["release/calver"]);
    }
    expect(JSON.parse(repo.contents.get(current.sha)!["package.json"]).version).toBe("2026.1030.0");
    expect(repo.publishCalls).toBe(0);
    expect(publicationMutations(repo)).toEqual([]);
    expect(repo.refs.size).toBe(0);
    expect(repo.releases.size).toBe(0);
    expect(repo.deploys).toEqual([]);
  });

  it("allows an admitted publication to finish after midnight when its first tag mutation was before midnight", async () => {
    const repo = new Repository();
    repo.time = "2026-10-30T23:59:58Z";
    const current = repo.add();
    await repo.plan(current);
    repo.listed = [];
    repo.resetCounts();
    repo.afterTagObject = () => { repo.time = "2026-10-31T00:00:01Z"; };
    expect(await repo.invoke()).toMatchObject({ status: "published", sha: current.sha, tag: "v2026.1030.0" });
    expect(publicationMutations(repo)[0]).toMatchObject({ method: "POST", path: "/git/tags", at: "2026-10-30T23:59:58Z" });
    expect(publicationMutations(repo).some((call) => call.path === "/releases" && call.at === "2026-10-31T00:00:01Z")).toBe(true);
    expect(repo.deploys).toHaveLength(1);
  });

  it("keeps an exact already-published replay settled across midnight without a new proposal or redeploy", async () => {
    const repo = new Repository();
    repo.time = "2026-10-30T23:59:58Z";
    await repo.seed(1);
    const current = repo.selections[0];
    repo.listed = [];
    repo.time = "2026-10-31T00:00:01Z";
    repo.resetCounts();
    await repo.invoke(current.sha);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.publications.every((entry) => entry.created === false)).toBe(true);
    expect(repo.releases.size).toBe(1);
    expect((await repo.actual.ref(current.tag))?.sha).toBe(current.sha);
  });
});

async function lightweightSelection() {
  const repo = new Repository();
  const owner = repo.add();
  const tag = "v2026.1030.0";
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: owner.sha } };
  repo.refs.set(tag, ref);
  const selected = repo.add();
  selected.version = "2026.1030.0";
  selected.tag = tag;
  repo.contents.set(selected.sha, files(selected.version));
  expect(await repo.actual.ref(tag)).toMatchObject({ sha: owner.sha, annotation: null });
  const available = await repo.actual.plan({ channel: "stable", policy: "direct-release", sha: selected.sha, operation: `kagi/release/${selected.sha}` });
  expect(available.version).toBe("2026.1030.1");
  return { repo, owner, selected, ref: structuredClone(ref) };
}

// A lightweight tag reserves a slot but proves no operation identity. It must
// neither settle a different selection nor poison later reconciliation. The
// same-SHA ambiguous case and coherent operation/SHA conflicts still refuse.
describe("lightweight occupied slots are inventory, not settlement", () => {
  it("refreshes selected current B around an unrelated lightweight slot without replacing A's tag", async () => {
    const { repo, selected, ref } = await lightweightSelection();
    repo.listed = [];
    repo.resetCounts();
    let result: Awaited<ReturnType<Repository["invoke"]>> | undefined;
    let refusal: unknown;
    try { result = await repo.invoke(selected.sha); } catch (error) { refusal = error; }
    expect.soft(refusal, `unrelated lightweight inventory must reach shared allocation; plans=${repo.planCalls}, GETs=${repo.gets}`).toBeUndefined();
    expect.soft(repo.planned.map((plan) => ({ sha: plan.sha, version: plan.version }))).toEqual([{ sha: selected.sha, version: "2026.1030.1" }]);
    expect.soft(result).toMatchObject({ status: "version-pr", version: "2026.1030.1", number: 200, headSha: "d".repeat(40) });
    expect.soft(repo.proposal?.pull).toMatchObject({ state: "open", draft: false, labels: [{ name: "calver:release" }], head: { ref: "release/calver" }, base: { ref: "main" } });
    expect.soft(JSON.parse(repo.proposal?.files["package.json"] ?? "{}").version).toBe("2026.1030.1");
    const lock = JSON.parse(repo.proposal?.files["package-lock.json"] ?? "{}");
    expect.soft(lock.version).toBe("2026.1030.1");
    expect.soft(lock.packages?.[""].version).toBe("2026.1030.1");
    expect.soft(repo.proposal?.files["CHANGELOG.md"]).toContain("## 2026.1030.1");
    for (const workflow of ["ci.yml", "pr-lint.yml", "secret-scan.yml"]) {
      expect.soft(repo.calls.filter((call) => call.method === "POST" && call.path === `/actions/workflows/${workflow}/dispatches`).map((call) => call.body.ref)).toEqual(["release/calver"]);
    }
    expect(repo.publishCalls).toBe(0);
    expect(publicationMutations(repo)).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.refs.get("v2026.1030.0")).toEqual(ref);
    expect(repo.releases.size).toBe(0);
  });

  it("does not let older lightweight-slot B block the eligible selected current C", async () => {
    const { repo, selected: collision, ref } = await lightweightSelection();
    const current = repo.add();
    await repo.plan(current);
    expect(current.version).toBe("2026.1030.1");
    repo.listed = [collision];
    repo.resetCounts();
    let refusal: unknown;
    try { await repo.invoke(current.sha); } catch (error) { refusal = error; }
    expect.soft(refusal, "lightweight history is neither B's settlement nor a reason to lose C's callback").toBeUndefined();
    expect.soft(repo.publications.filter((entry) => entry.created).map((entry) => ({ sha: entry.sha, tag: entry.tag }))).toEqual([{ sha: current.sha, tag: "v2026.1030.1" }]);
    expect.soft(repo.deploys.map((call) => call.body)).toEqual([{ ref: "main", inputs: { tag: "v2026.1030.1" } }]);
    expect(repo.publications.some((entry) => entry.sha === collision.sha)).toBe(false);
    expect(repo.refs.get("v2026.1030.0")).toEqual(ref);
    expect(repo.calls.some((call) => call.path === `/pulls/${collision.number}`)).toBe(true);
  });

  it("refuses same-SHA lightweight identity instead of treating an occupied name as an exact replay", async () => {
    const repo = new Repository();
    const current = repo.add();
    await repo.plan(current);
    const ref = { ref: `refs/tags/${current.tag}`, object: { type: "commit", sha: current.sha } };
    repo.refs.set(current.tag, ref);
    repo.listed = [];
    repo.resetCounts();
    await expect(repo.invoke()).rejects.toThrow(/provenance|operation|identity|lightweight|annotat|repair|collision/i);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.refs.get(current.tag)).toEqual(ref);
  });

  it("refuses coherent same-operation/wrong-SHA evidence rather than refreshing away the conflict", async () => {
    const repo = new Repository();
    const owner = repo.add();
    const selected = repo.add();
    const plan = await repo.plan(owner, `kagi/release/${selected.sha}`);
    await repo.actual.publish(plan);
    selected.version = plan.version;
    selected.tag = plan.tag;
    repo.contents.set(selected.sha, files(selected.version));
    repo.listed = [];
    repo.resetCounts();
    await expect(repo.invoke(selected.sha)).rejects.toThrow(/SHA|operation|provenance|collision/i);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect((await repo.actual.ref(plan.tag))?.sha).toBe(owner.sha);
  });

  it("propagates a lightweight tag lookup error instead of assuming an empty slot", async () => {
    const { repo, ref } = await lightweightSelection();
    repo.listed = [];
    repo.forced.set("GET /git/ref/tags/v2026.1030.0", 503);
    repo.resetCounts();
    await expect(repo.invoke()).rejects.toThrow(/HTTP 503/);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.refs.get("v2026.1030.0")).toEqual(ref);
  });
});

async function measured(settled: number, filler: number) {
  const repo = new Repository();
  await repo.seed(settled, filler);
  const current = repo.add();
  await repo.plan(current);
  repo.resetCounts();
  await repo.invoke();
  return { repo, current, gets: repo.gets, plans: repo.planCalls, publishes: repo.publishCalls };
}

// Default GITHUB_TOKEN: 1,000 REST requests/repository/hour, without assuming
// the Enterprise exception. Count all invocation GETs, including shared reads;
// seeding is actual-engine setup, not a hidden production checkpoint.
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions
// Paginated provider lists include terminal prev/first Links without a next Link.
describe("retained history fits the default repository-token read allowance", () => {
  it.each([
    ["counted without a provider cutoff", Number.POSITIVE_INFINITY],
    ["with the default 1,000-read provider cutoff", 1_000],
  ] as const)("reconciles 112 settled selections and publishes current below 950 GETs: %s", async (_mode, limit) => {
    const repo = new Repository();
    await repo.seed(112);
    expect(repo.releases.size).toBe(112);
    const current = repo.add();
    await repo.plan(current);
    expect(current.version).toBe("2026.1030.112");
    repo.resetCounts();
    repo.getLimit = limit;
    let result: Awaited<ReturnType<Repository["invoke"]>> | undefined;
    let refusal: unknown;
    try { result = await repo.invoke(); } catch (error) { refusal = error; }
    const diagnostic = `GETs=${repo.gets}, plans=${repo.planCalls}, publishes=${repo.publishCalls}, currentDetailFetched=${repo.calls.some((call) => call.path === `/pulls/${current.number}`)}, refusal=${refusal instanceof Error ? refusal.message : String(refusal)}`;
    expect.soft(refusal, `retained history must leave room for current work; ${diagnostic}`).toBeUndefined();
    expect.soft(repo.gets, `the total includes caller and real shared-engine requests; ${diagnostic}`).toBeLessThan(950);
    expect.soft(result).toMatchObject({ status: "published", sha: current.sha, tag: "v2026.1030.112", deploymentDispatched: true });
    expect.soft(repo.publications.filter((entry) => entry.created).map((entry) => entry.sha)).toEqual([current.sha]);
    expect.soft(repo.deploys.map((call) => call.body)).toEqual([{ ref: "main", inputs: { tag: "v2026.1030.112" } }]);
    expect.soft(repo.releases.size).toBe(113);
    expect(repo.planCalls).toBeLessThanOrEqual(1);
    expect(repo.publishCalls).toBe(1);
    expect(repo.calls.some((call) => call.path === "/pulls" && call.query.get("state") === "closed" && Number(call.query.get("page") ?? 1) > 1)).toBe(true);
    expect(repo.calls.some((call) => call.path === "/tags" && Number(call.query.get("page") ?? 1) > 1)).toBe(true);
  }, 30_000);

  it("does not drop an oldest repair-required selection beyond the first 100 recent closed-PR rows", async () => {
    const repo = new Repository();
    await repo.seed(112);
    const oldest = repo.selections[0];
    repo.releases.delete(oldest.tag);
    const current = repo.add();
    await repo.plan(current);
    repo.resetCounts();
    await expect(repo.invoke()).rejects.toThrow(/repair|Release/i);
    expect(repo.calls.some((call) => call.path === "/pulls" && Number(call.query.get("page") ?? 1) > 1)).toBe(true);
    expect(repo.calls.some((call) => call.path === `/releases/tags/${oldest.tag}`)).toBe(true);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
    expect(repo.releases.has(oldest.tag)).toBe(false);
  }, 30_000);
});

describe("provenance-bound settlement with the real pinned shared engine", () => {
  it("does not republish or redeploy A after B when A's automatic CI callback arrives late", async () => {
    const repo = new Repository();
    await repo.seed(2);
    const earlier = repo.selections[0];
    repo.listed = [];
    repo.resetCounts();
    await repo.invoke(earlier.sha);
    expect(repo.publications.every((result) => result.created === false)).toBe(true);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys, "a delayed automatic callback must not roll production back to an older tag").toEqual([]);
    expect(repo.calls.some((call) => call.path === `/releases/tags/${earlier.tag}`)).toBe(true);
    expect(repo.calls.some((call) => call.path === `/git/ref/tags/${earlier.tag}`)).toBe(true);
  });

  it("settles retained history in bounded linear reads without replanning every settled SHA", async () => {
    const small = await measured(3, 3);
    const large = await measured(30, 30);
    expect(large.gets, `small=${small.gets}, large=${large.gets}, plans=${large.plans}, publishes=${large.publishes}; bound read growth, not elapsed time`).toBeLessThanOrEqual(small.gets * 14 + 40);
    expect(large.gets).toBeLessThanOrEqual(8 * (30 + 60) + 80);
    expect(large.plans, "only the independent unpublished current release needs planning").toBeLessThanOrEqual(1);
    expect(large.publishes).toBeLessThanOrEqual(1);
    expect(large.repo.publications.filter((result) => result.created).map((result) => result.sha)).toEqual([large.current.sha]);
  }, 30_000);

  it.each(["failure", "cancelled"])("settles verified published history before a newer historical CI conclusion of %s", async (conclusion) => {
    const repo = new Repository();
    await repo.seed(4, 4);
    const historical = repo.selections[0];
    const current = repo.add();
    await repo.plan(current);
    repo.newerHistoricalConclusions.set(historical.sha, conclusion);
    repo.resetCounts();
    await repo.invoke();
    expect(repo.ciReads(historical.sha), "settled provenance is independent of mutable later CI history").toEqual([]);
    expect(repo.publications.filter((result) => result.created).map((result) => result.sha)).toEqual([current.sha]);
    expect(repo.deploys.map((call) => (call.body.inputs as Json).tag)).toEqual([current.tag]);
  });

  it.each(["other operation", "wrong annotated SHA", "invalid version", "tag only", "draft Release", "missing Release marker", "Release API failure"])(
    "does not settle unverified publication evidence: %s", async (broken) => {
      const repo = new Repository();
      await repo.seed(1, 0, broken === "other operation");
      const selection = repo.selections[0];
      const ref = repo.refs.get(selection.tag)!;
      const object = repo.objects.get(ref.object.sha)!;
      if (broken === "wrong annotated SHA") object.object = { type: "commit", sha: repo.add().sha };
      if (broken === "invalid version") {
        const annotation = JSON.parse(String(object.message).split("\n").slice(1).join("\n"));
        annotation.version = "2026.1030.99";
        object.message = `calver-plan-v1\n${JSON.stringify(annotation)}`;
      }
      if (broken === "tag only") repo.releases.delete(selection.tag);
      if (broken === "draft Release") repo.releases.get(selection.tag)!.draft = true;
      if (broken === "missing Release marker") repo.releases.get(selection.tag)!.body = "No provenance marker";
      if (broken === "Release API failure") repo.forced.set(`GET /releases/tags/${selection.tag}`, 503);
      repo.listed = [];
      repo.resetCounts();
      let refusal: unknown;
      try { await repo.invoke(selection.sha); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).not.toMatch(/unexpected offline request|unexpected offline provider/);
      const reasons: Record<string, RegExp> = {
        "other operation": /operation|provenance/i,
        "wrong annotated SHA": /target|SHA|provenance/i,
        "invalid version": /integrity|version|binding|provenance/i,
        "tag only": /repair|Release/i,
        "draft Release": /draft|Release|provenance/i,
        "missing Release marker": /Release|provenance/i,
        "Release API failure": /HTTP 503/,
      };
      expect((refusal as Error).message).toMatch(reasons[broken]);
      expect(repo.writes).toEqual([]);
      expect(repo.deploys).toEqual([]);
    },
  );

  it("does not treat an unpublished failed-CI selection as settled", async () => {
    const repo = new Repository();
    const current = repo.add();
    await repo.plan(current);
    repo.conclusions.set(current.sha, "failure");
    repo.resetCounts();
    await expect(repo.invoke()).rejects.toThrow(/concluded failure/);
    expect(repo.writes).toEqual([]);
    expect(repo.deploys).toEqual([]);
  });
});

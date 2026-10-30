// Caller settlement tests use the actual immutable shared planner, publisher and
// HTTP transport (see shared-calver.ts), not a fake allocator replay shortcut.
// Every provider request below is offline. Fixture seeding is excluded from read
// counts; no elapsed-time assertion or real GitHub mutation is involved.
import { afterAll, describe, expect, it } from "vitest";
import { runCalver } from "../../ci/calver";
import { disposePinnedCalver, pinnedCalver, type SharedPlan, type SharedPublication, type SharedReleaser } from "./shared-calver";

afterAll(disposePinnedCalver);
const REPO = "TogetherWeOwn/kagi-shinobi";
const NOW = "2026-10-30T12:00:00Z";
const TREE = "e".repeat(40);
type Json = Record<string, unknown>;
interface Call { method: string; path: string; query: URLSearchParams; body: Json }
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
  planCalls = 0;
  publishCalls = 0;
  currentSha = "0".repeat(39) + "1";
  private nextObject = 50_000;
  readonly actual: SharedReleaser;
  readonly releaser: SharedReleaser;

  constructor() {
    const { Releaser, GitHub } = pinnedCalver();
    const api = new GitHub({ token: "offline-shared-fixture", fetchImpl: this.fetch });
    this.actual = new Releaser({ api, repository: REPO, now: () => new Date(NOW) });
    this.releaser = {
      plan: async (input) => { this.planCalls++; return this.actual.plan(input); },
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
      base: { ref: "main", sha: this.currentSha, repo: { full_name: REPO } },
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
      } }, fetch: this.fetch, now: () => new Date(NOW), log: () => {}, releaser: this.releaser,
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/repos/${REPO}`)) throw new Error("unexpected offline provider origin/repository");
    const path = decodeURIComponent(url.pathname.slice(`/repos/${REPO}`.length));
    const body = request.body ? await request.json() as Json : {};
    const call = { method: request.method, path, query: url.searchParams, body };
    this.calls.push(call);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const forced = this.forced.get(`${request.method} ${path}`);
    if (forced) return json({ message: "provider-detail-not-for-logs" }, forced);
    let match: RegExpMatchArray | null;
    if (request.method === "GET") {
      if (path === "/tags") return json(Array.from(this.refs, ([name, ref]) => {
        let target = ref.object;
        if (target.type === "tag") target = this.objects.get(target.sha)!.object as typeof target;
        return { name, commit: { sha: target.sha } };
      }));
      if ((match = path.match(/^\/git\/ref\/tags\/(.+)$/))) return this.refs.has(match[1]) ? json(this.refs.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/git\/tags\/([0-9a-f]{40})$/))) return this.objects.has(match[1]) ? json(this.objects.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/releases\/tags\/(.+)$/))) return this.releases.has(match[1]) ? json(this.releases.get(match[1])) : json({}, 404);
      if ((match = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) return this.contents.has(match[1]) ? json({ sha: match[1], tree: { sha: TREE } }) : json({}, 404);
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
        if (url.searchParams.get("state") === "open") return json([]);
        return json((this.listed ?? this.selections).map((entry) => this.pull(entry, true)));
      }
      if ((match = path.match(/^\/commits\/([0-9a-f]{40})\/pulls$/))) return json(this.selections.filter((entry) => entry.sha === match![1]).map((entry) => this.pull(entry, true)));
      if ((match = path.match(/^\/pulls\/(\d+)(?:\/(files))?$/))) {
        const selection = this.selections.find((entry) => entry.number === Number(match![1]));
        if (!selection) return json({}, 404);
        return match[2] ? json(["package.json", "package-lock.json", "CHANGELOG.md"].map((filename) => ({ filename, status: "modified" }))) : json(this.pull(selection));
      }
      if (path.startsWith("/contents/")) {
        const content = this.contents.get(url.searchParams.get("ref") ?? this.currentSha)?.[path.slice("/contents/".length)];
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
      if (path === "/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { type: "commit", sha: this.currentSha } });
      if (path === "/git/ref/heads/release/calver") return json({}, 404);
    }
    if (request.method === "POST" && path === "/git/tags") {
      const sha = (this.nextObject++).toString(16).padStart(40, "0");
      const tag = { sha, tag: body.tag, message: body.message, object: { type: body.type, sha: body.object } };
      this.objects.set(sha, tag);
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

async function measured(settled: number, filler: number) {
  const repo = new Repository();
  await repo.seed(settled, filler);
  const current = repo.add();
  await repo.plan(current);
  repo.resetCounts();
  await repo.invoke();
  return { repo, current, gets: repo.gets, plans: repo.planCalls, publishes: repo.publishCalls };
}

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

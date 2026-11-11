// Exact test-only copies of TogetherWeOwn/.github at this immutable pin. The
// fixtures are text, never a caller-local allocator or modified implementation.
// Load them with native Node ESM interop outside the synced tree so settlement
// tests exercise the actual planner, publisher, provenance and HTTP transport.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED_PIN = "1508f2c10cb83bc0677e8e559ff796a55c66e737";
const FILES = {
  "calver.mjs": "303c86ba9475cc9fd7b3ca42d48dde78f97c501086bd14d2b694d455e1574cfd",
  "github.mjs": "e457a3a94b4a1dec8229d2f30374247a05984d78dfbec57dbed3a8fb52ed23f2",
};

export interface SharedInput {
  channel: "stable";
  sha: string;
  operation: string;
  policy: "direct-release";
  namespace?: string;
  latest?: string;
}
export interface SharedPlan extends SharedInput {
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
export interface SharedPublication extends SharedPlan {
  created: boolean;
  releaseUrl: string;
  dryRun: boolean;
}
export interface SharedRef { name: string; sha: string; annotation: string | null }
export interface SharedApi {
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  paginate: (path: string, key?: string) => Promise<unknown[]>;
}
export interface SharedReleaser {
  plan: (input: SharedInput) => Promise<SharedPlan>;
  notes: (plan: SharedPlan) => Promise<string>;
  publish: (plan: SharedPlan, options?: { dryRun?: boolean; repair?: boolean }) => Promise<SharedPublication>;
  validatePlan: (plan: SharedPlan) => void;
  provenance: (ref: SharedRef) => SharedPlan & { publicationEvidence: null };
  ref: (tag: string) => Promise<SharedRef | null>;
  tags: () => Promise<SharedRef[]>;
}
interface EngineModule {
  Releaser: new (input: { api: SharedApi; repository: string; now: () => Date }) => SharedReleaser;
}
interface TransportModule {
  GitHub: new (input: { token: string; fetchImpl: typeof fetch; readOnly?: boolean }) => SharedApi;
}
let directory: string | undefined;
let loaded: (EngineModule & TransportModule) | undefined;

export function pinnedCalver(): EngineModule & TransportModule {
  if (loaded) return loaded;
  directory = mkdtempSync(join(tmpdir(), "calver-shared-fixture-"));
  for (const [name, expected] of Object.entries(FILES)) {
    const fixture = fileURLToPath(new URL(`../fixtures/calver/${name}.txt`, import.meta.url).href);
    const bytes = readFileSync(fixture);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`immutable shared fixture changed: ${name}`);
    writeFileSync(join(directory, name), bytes);
  }
  const require = createRequire(import.meta.url);
  const engine = require(join(directory, "calver.mjs")) as EngineModule;
  const transport = require(join(directory, "github.mjs")) as TransportModule;
  loaded = { ...engine, ...transport };
  return loaded;
}

export function validatePlanFixture(plan: SharedPlan): void {
  const { Releaser } = pinnedCalver();
  const api: SharedApi = {
    request: async () => { throw new Error("fixture validation must not make HTTP requests"); },
    paginate: async () => { throw new Error("fixture validation must not enumerate tags"); },
  };
  new Releaser({ api, repository: plan.repository, now: () => new Date("2026-10-30T12:00:00Z") }).validatePlan(plan);
}

// Caller-generated commit fixture, separate from the immutable shared engine.
// Its durable marker is checked against an actual offline generator invocation;
// it supplies input evidence, never an allocator or an always-successful gate.
export interface GeneratedProposalCommit {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  author: { name: string; email: string; date?: string };
  committer: { name: string; email: string; date?: string };
}
export function proposalCommitFixture(sha: string, baseSha: string, treeSha: string, version: string, date = "2026-10-30T06:01:00Z"): GeneratedProposalCommit {
  const author = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", date };
  return {
    sha,
    message: `chore: release ${version}\n\ncalver-proposal-v1\n${JSON.stringify({ repository: "TogetherWeOwn/kagi-shinobi", baseSha, treeSha, version })}`,
    tree: { sha: treeSha }, parents: [{ sha: baseSha }], author, committer: { ...author },
  };
}

export function disposePinnedCalver(): void {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
}

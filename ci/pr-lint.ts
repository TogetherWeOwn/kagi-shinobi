// Dispatched PR lint boundary. ci/calver.ts explicitly dispatches `pr-lint.yml`
// for its GITHUB_TOKEN-created version PR, because that creation starts no
// workflow. A workflow_dispatch run, though, has no pull_request payload, so an
// ordinary lint run would see an empty title/body and check the wrong thing.
//
// This helper binds the dispatched run to the live PR: it reads the actual
// metadata from the GitHub API, proves that metadata is the intended PR on the
// intended exact head, and only then runs the existing Python policy with real
// title/body/author. It never writes a commit status or check run: the required
// `title` job itself runs this, so a fabricated green is neither needed nor
// possible from here.
//
// Import-safe for offline tests. The CLI executes only trusted main code.
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Env = Record<string, string | undefined>;
export interface Deps {
  fetch: typeof fetch;
  log: (line: string) => void;
  lint: (input: Env) => Promise<void>;
}
export interface Result {
  number: number;
  headSha: string;
}

const SHA = /^[0-9a-f]{40}$/;
const NUMBER = /^[1-9]\d{0,9}$/;

interface Pull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string; private: boolean } | null };
  base: { ref: string; repo: { full_name: string; private: boolean } | null };
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "invalid object");
  return value as Record<string, unknown>;
}

export async function runPrLint(env: Env, deps: Deps): Promise<Result> {
  const repository = env.GITHUB_REPOSITORY ?? "";
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "missing or malformed GITHUB_REPOSITORY");
  requireValue(env.GITHUB_TOKEN, "missing GitHub token");
  requireValue(env.GITHUB_EVENT_NAME === "workflow_dispatch", "dispatched PR lint runs only from workflow_dispatch");

  // Selection inputs are strings from workflow_dispatch. Anything else (a float,
  // a path suffix, whitespace, a newline) is not a PR number or a SHA.
  const rawNumber = env.PR_NUMBER ?? "";
  const rawHead = env.EXPECTED_HEAD_SHA ?? "";
  requireValue(NUMBER.test(rawNumber), "PR_NUMBER is not a valid pull-request number selection");
  requireValue(SHA.test(rawHead), "EXPECTED_HEAD_SHA is not an exact 40-hex commit SHA");
  const number = Number(rawNumber);
  requireValue(Number.isSafeInteger(number) && number > 0, "PR_NUMBER is not a valid pull-request number selection");
  // The dispatch's own checkout must be the head it claims to lint. Everything
  // below reads metadata for that SHA only.
  requireValue(env.GITHUB_SHA === rawHead, "dispatch checkout SHA differs from the requested exact head");

  const response = await deps.fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  // Never print the provider body: it may carry private data or a
  // credential-bearing URL.
  requireValue(response.ok, `GitHub GET /pulls/${number} HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub PR metadata was not valid JSON");
  }
  const pull = object(payload) as unknown as Pull;
  requireValue(Number.isSafeInteger(pull.number) && pull.number > 0, "PR metadata has no valid number");
  requireValue(pull.number === number, "PR metadata is for another pull request");
  const head = pull.head && typeof pull.head === "object" ? object(pull.head) : null;
  const headRepo = head?.repo && typeof head.repo === "object" ? object(head.repo) : null;
  const base = pull.base && typeof pull.base === "object" ? object(pull.base) : null;
  const baseRepo = base?.repo && typeof base.repo === "object" ? object(base.repo) : null;
  requireValue(typeof head?.sha === "string" && SHA.test(head.sha), "PR metadata has no valid head SHA");
  requireValue(head.sha === rawHead, "PR head moved away from the requested exact head");
  requireValue(headRepo?.full_name === repository, "PR head is not this repository");
  requireValue(baseRepo?.full_name === repository, "PR base is not this repository");
  requireValue(typeof pull.title === "string", "PR metadata has no title");
  const user = pull.user && typeof pull.user === "object" ? object(pull.user) : null;
  requireValue(typeof user?.login === "string" && user.login, "PR metadata has no author");

  // The real policy, run against the real metadata. Preserve the workflow's
  // own policy knobs rather than silently rewriting them.
  await deps.lint({
    EVENT: "pull_request",
    TITLE: pull.title,
    BODY: typeof pull.body === "string" ? pull.body : "",
    AUTHOR: String(user.login),
    HEAD_REF: typeof head.ref === "string" ? head.ref : "",
    REPO_PRIVATE: String(headRepo.private === true),
    PR_STANDARDS_MODE: env.PR_STANDARDS_MODE ?? "warn",
    REQUIRE_CARD_REF: env.REQUIRE_CARD_REF ?? "false",
  });
  deps.log(`dispatched PR lint passed for #${number} at ${rawHead}`);
  return { number, headSha: rawHead };
}

async function main(): Promise<void> {
  try {
    const script = fileURLToPath(new URL("../.github/scripts/pr_standards.py", import.meta.url).href);
    const result = await runPrLint(process.env, {
      fetch,
      log: (line) => process.stdout.write(`${line}\n`),
      // execFileSync, not a shell: the metadata strings are arguments, never
      // shell syntax, and the policy exit status is the lint outcome.
      lint: async (input) => {
        execFileSync("python3", [script], {
          env: { ...process.env, ...input },
          stdio: "inherit",
          timeout: 120_000,
        });
      },
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${JSON.stringify(result)}\n\n`);
    }
  } catch (error) {
    process.stderr.write(`PR lint refused: ${error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 500) : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

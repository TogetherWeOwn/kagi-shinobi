# Kagi release runbook

The CalVer migration is not a release or deployment. Do not enable it until its
single implementation PR, independent tests and normal required review/checks
pass. Release publication and production rollout remain separate outcomes.

## Identity and release selection

Stable package versions use `YYYY.MDD.P`, tagged `vYYYY.MDD.P`. The month has no
leading zero, the day has two digits, and the clock is UTC: January 5 is
`2026.105.0`; October 30 is `2026.1030.0`. `P` starts at zero and is allocated
above published stable slots by the shared planner. Legacy SemVer tags are
preserved and provide a reachable release-notes boundary; do not rename them.

Shared tooling is pinned to
[`1508f2c10cb83bc0677e8e559ff796a55c66e737`](https://github.com/TogetherWeOwn/.github/tree/1508f2c10cb83bc0677e8e559ff796a55c66e737/actions/calver).
The workflow checks this public tooling out separately from trusted main
orchestration. It never executes the selected source commit or an artifact from
an untrusted CI run. All introduced release jobs run on standard free
`ubuntu-latest`, including `workflow_run`, which is not covered by the legacy
overflow event configuration. The dispatched required jobs (`ci.yml`,
`pr-lint.yml`, `secret-scan.yml`) select `ubuntu-latest` as their first branch,
before any legacy `CI_OVERFLOW_*` routing, so an explicit dispatch never falls
back to a self-hosted runner.

1. A successful full main CI run can **propose** a version. The serialized writer
   updates only `package.json`, `package-lock.json` (both root version fields)
   and `CHANGELOG.md` in one commit on `release/calver`.
   Before replacing an existing proposal branch, the writer re-reads the live
   head and then updates that ref through GitHub's native `updateRefs` mutation
   with `beforeOid` set to the exact generated commit it verified. A final read
   followed by a force `PATCH` cannot do this: REST has no expected-before
   predicate, so a contributor push landing between the read and the write would
   be silently discarded. With `beforeOid`, that same race fails the mutation and
   the writer stops instead of overwriting it; the contributor's commit is left
   intact and the next run re-verifies the branch. `force` permits the deliberate
   non-fast-forward (the replacement is based on current main), never a missing
   precondition. Only the disposable generated branch is ever moved this way.
2. The generated `calver:release` PR requires normal review and all required
   checks. The writer explicitly dispatches **all three** workflows on the updated
   branch head — `ci.yml`, `pr-lint.yml` and `secret-scan.yml` — for full coverage,
   failing closed if any dispatch fails. A dispatched `pr-lint` run reads live PR
   metadata through `ci/pr-lint.ts`, binds it to the PR number and exact head,
   then runs the real Python policy under an explicitly selected Node runtime.
   **Dispatch success is not required-check admission:** GitHub branch rulesets
   do not count `workflow_dispatch` job checks as eligible PR evidence, even when
   green. Token-created PR `opened`/`synchronize`/`reopened` events can create
   separate native `pull_request` runs requiring approval. The writer reports
   `checkAdmission` separately, bound to the new SHA, PR, repository and all three
   workflow paths: `awaiting_pr_event`, `approval_required`, or `admitted`.
   These are admission states, not check results, review consent or merge authority.
   Nothing writes a synthetic status/check, self-approves a run or weakens a rule.
3. Publication independently fetches the selected PR from GitHub. It must be a
   merged, non-draft, same-repository bot-created `release/calver` → `main` PR
   carrying the selection label, with its exact associated merge SHA and only
   the expected three changed files. Arbitrary manifest edits, webhook fields,
   a branch name or a green main build alone are not selection. The serialized
   writer reconciles closed selected PRs as well as the triggering SHA, so a
   newer callback cannot erase an unpublished selection.
4. The exact selected merge SHA needs successful full CI. The planner rechecks
   its UTC slot; the committed package/root-lock/root-package identity and notes
   must agree. Date/slot drift refreshes a version PR for another normal review,
   never silently substitutes a tag on the old commit.
5. The shared publisher creates the exact version/tag/Release. Only after that
   promise resolves does the adapter dispatch existing `deploy.yml` on **main**
   with that tag. The existing guard still requires published non-draft Release,
   package/tag equality, main ancestry, exact-SHA CI and protected main-only
   production environment. Its Cloudflare credentials remain environment-only.

## Cutover and concurrent writers

Keep the existing workflow filename `release-please.yml` for one writer cutover;
its content replaces the release-please action. Resolve any existing open legacy
release-please version PR **with its existing owner** before generating a CalVer
proposal. The adapter refuses to create competing manifest/CHANGELOG proposals.
Do not close or merge that PR merely to make automation green. This migration
itself does not bump package versions or edit the current CHANGELOG.

The `calver-version-writer` concurrency group has `cancel-in-progress: false`.
An active writer is never cancelled, but pending GitHub concurrency entries can
coalesce: this is not a FIFO queue. Each surviving writer paginates the closed
main-target PRs and revalidates selected merges oldest first through their live
PR, commit association, allowed files, exact-SHA CI, manifests and shared plan.
Already-published operations are settled **before mutable historical CI or a
planner call**, using the committed version and direct Release/annotated-tag
reads. Settlement verifies the frozen plan's canonical integrity ID, repository,
version/tag and published Release marker, and requires the operation, policy and
merge SHA to be this exact release. A coherent tag that belongs to a different
SHA is not evidence about this one: another release legitimately owns that slot,
so the shared planner allocates a fresh version and the PR is refreshed instead
of being refused or mis-tagged. A tag whose own annotation disagrees with its
target, or claims this SHA under another operation, is unprovenanced and refuses.
This avoids one full shared registry scan per completed selection
(multiplicative history reads).
Only unresolved work reaches shared allocation/publication; shared arithmetic and
publication-time validation remain authoritative. Settled operations are skipped
without another publication or deployment dispatch, including delayed callbacks
for older releases. Intentional redeployment uses guarded Deploy, never a writer
replay. Stale
historical selections never seed a proposal from old main; the triggering main
SHA must pass its own full CI before refreshing the proposal. A recovered release
never suppresses a selected triggering merge: each is independently validated and
published in merge order. Only an unrelated ordinary merge's new proposal is
suppressed after recovery. A historical selection with completed failed CI is
logged and skipped without publication, so it cannot prevent a different green
selection from progressing; provider errors and incomplete evidence still fail
closed, and failed CI on the triggering SHA remains an error.

CI completion callbacks may arrive out of order. Successful `push`,
`workflow_dispatch` and `schedule` full-CI origins can resume the writer, but only
for workflow `CI` at `.github/workflows/ci.yml`, the same repository, main branch,
completed success and a complete exact SHA. A proposal must start from current
main; publication keeps the selected exact SHA even if main advances. Manual
recovery writers must respect the same serialization, preserve gates and never
move/delete a published tag.

## Failures, retry and rollback

- **Native PR checks awaiting admission:** inspect the generated PR's exact-head
  native `pull_request` runs, not the dispatch run's green badges. An authorized
  repository-write maintainer can use GitHub's **Approve workflows to run** UI
  where offered. This existing GitHub authority is not granted by this adapter;
  same-repository GITHUB_TOKEN self-approval through REST is not established.
  If no authorized execution route is available, keep the PR unmerged and route
  that exact approval need to the repository's authorized executor. Do not create
  a token, bypass policy, or infer approval from a green dispatch. After approval,
  verify the exact-head native checks actually complete successfully and the
  normal review gate passes before merge. No timer or auto-merge is added here.
  See GitHub's [trigger contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
  and [required-check event contract](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
- **No exact-SHA full CI yet:** publication is refused/deferred. A successful CI
  completion is the continuation; an old successful run on another SHA is not
  sufficient. Fix real CI failures instead of bypassing them.
- **Ref created, but PR creation or labeling failed:** rerun the writer normally.
  It rereads the live branch and PR; an incomplete proposal is recoverable only
  with the generated commit marker bound to its repository, parent, tree and
  manifest version plus bot author/committer identity. A changed or unknown head
  is refused. The returned labels must contain `calver:release` before any
  required-check dispatch. An unlabeled merged intermediate PR never selects a
  release; recovery does not bypass normal review or full CI.
- **Stale date/slot before publication:** refresh the version PR and rerun all
  required checks/review. Another writer winning a publication race is a hard
  failure; no retag or implicit reallocation follows.
- **Exact replay:** `kagi/release/<merge-sha>` is stable across run IDs. The shared
  engine recovers its original annotated plan and independently verifies it.
  Only an exact already-published operation can replay across a UTC date change.
  An unrelated same-SHA tag is not equivalent provenance.
- **Tag exists but Release creation failed:** this is a partial transaction, not
  success. Ordinary retries do not silently repair it. Retain the exact original
  plan and use the shared engine's explicit repair procedure under the same
  writer discipline and existing authority; do not create another operation or
  change its date/SHA to escape the refusal.
- **Release published, deployment dispatch or deployment failed:** the valid
  published Release remains. Do not delete it, mark production successful, or
  rotate credentials. Repair the specific dispatch/deploy failure, then dispatch
  the existing guarded Deploy workflow on main with that same tag. Rollback is
  the same guarded workflow with a previously approved published release tag.

## Runtime verification

An admin-authenticated `/health` returns package **`version`** beside injected
**`buildSha`**. Both identify the executable source; they do not assert that the
latest GitHub Release is deployed. Anonymous, malformed, invalid, scoped-client
and unconfigured-admin calls return only `{ "ok": true }`. Reading health makes
no Kagi request and requires no additional deployment binding or secret.

No live release, deployment or authenticated production observation is implied
by offline tests. The deploy run and authenticated health from the authorized
executor are separate rollout evidence.

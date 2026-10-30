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
overflow event configuration.

1. A successful full main CI run can **propose** a version. The serialized writer
   updates only `package.json`, `package-lock.json` (both root version fields)
   and `CHANGELOG.md` in one commit on `release/calver`.
2. The generated `calver:release` PR requires normal review and all required
   checks. GITHUB_TOKEN-created changes do not trigger ordinary PR workflows:
   explicit full-CI dispatch on the updated branch is required, together with
   the required PR-conventions and secret-scan checks. Do not merge on a partial
   set of green checks, add an override, or use an admin merge.
3. Publication independently fetches the selected PR from GitHub. It must be a
   merged, non-draft, same-repository bot-created `release/calver` → `main` PR
   carrying the selection label, with the exact invocation SHA as its merge
   commit and only the expected three changed files. Arbitrary manifest edits,
   webhook fields, a branch name or a green main build alone are not selection.
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
coalesce: this is not a FIFO queue. Read-only CI completion callbacks may arrive
out of order. A proposal must start from current main; publication keeps the
selected exact SHA even if main advances. Manual recovery writers must respect
the same serialization, preserve gates and never move/delete a published tag.

## Failures, retry and rollback

- **No exact-SHA full CI yet:** publication is refused/deferred. A successful CI
  completion is the continuation; an old successful run on another SHA is not
  sufficient. Fix real CI failures instead of bypassing them.
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

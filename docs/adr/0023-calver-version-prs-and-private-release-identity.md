# ADR 0023 — CalVer version PRs and private release identity

**Status:** Proposed — 2026-10-30 (accepted when the migration passes review)
**Relates to:** [ADR 0015](0015-build-sha-in-authenticated-health.md),
[ADR 0018](0018-automated-production-deploy-gate.md)

## Decision

Replace release-please's SemVer arithmetic with the immutable shared CalVer
releaser, but retain a reviewed **version PR** as the release-selection boundary.
Kagi remains a direct-release exception: publish the exact version committed in
that PR, then explicitly dispatch the existing guarded deployment workflow.
Neither ordinary main merges nor publication itself prove a production rollout.

Stable identities are `YYYY.MDD.P` / `vYYYY.MDD.P`, using UTC and the shared
allocator. A proposal plan binds the pre-version main SHA; after the version PR
merges, a new plan binds its exact merge SHA. Its version must equal the committed
package/root-lock/root-package version. A stale date or occupied slot produces a
refreshed version PR, not a replacement tag. Exact publication retries retain the
same SHA-derived operation identity and the shared engine's provenance.

Authenticated `/health` adds **`version`**, imported from the bundled package
manifest, beside the existing injected **`buildSha`**. This is the package identity
of those executable bytes, not a mutable Latest-release lookup. Anonymous,
invalid and scoped-client bearers still receive exactly `{ "ok": true }`; the
existing admin bearer alone unlocks release and token-state details. No new
endpoint, permission, deployment variable, credential or upstream request is
introduced.

## Why not a release on every green main build?

That would remove the deliberate release-selection step and could deploy a
change never reviewed as a release. The existing package/tag equality,
published-Release, exact-SHA full-CI and main-only production environment checks
remain independently enforced by the existing deploy gate. The shared releaser
has no Cloudflare credentials and cannot weaken that gate.

Version PR automation and all recovery writers must share a serialized writer
boundary. GITHUB_TOKEN events do not automatically start dependent workflows;
required checks and deployment need explicit dispatch. The generated branch is
replaceable proposal state; tags and the default branch are never rewritten.
See the [release runbook](../releases.md) for cutover and failure handling.
